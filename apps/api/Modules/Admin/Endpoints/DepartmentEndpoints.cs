using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Departments — what Google calls Organisational Units.
///
/// A named group carrying policy that passes down: storage, which products,
/// whether members may email outsiders. Engineering &gt; Backend &gt; Platform.
///
/// ─────────────────────────────────────────────────────────────────────────
///  QUOTA INHERITS. PERMISSION DOES NOT.
///
///  A NULL quota means "take the parent's". That is what makes a tree worth
///  having — raise Engineering to 50 GB and every team beneath it moves,
///  with no per-team edit and no drift.
///
///  can_send_external is deliberately NOT inherited. A parent permitting
///  external mail must never silently grant it to a Students department
///  created underneath next year. The safe value gets chosen explicitly,
///  every time.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class DepartmentEndpoints
{
    public static void MapDepartmentEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/departments")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", TreeAsync);
        g.MapPost("/", CreateAsync);
        g.MapPut("/{id:guid}", UpdateAsync);
        g.MapPut("/{id:guid}/move", MoveAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);
    }

    public sealed record Node(
        Guid Id, Guid? ParentId, string Name, string? Description,
        string DefaultRole, string[] DefaultProducts, bool CanSendExternal,
        string Colour,
        long? OwnQuotaBytes,
        long? EffectiveQuotaBytes,
        bool QuotaInherited,
        int UserCount,
        int DescendantUserCount,
        List<Node> Children);

    // ------------------------------------------------------------------
    private static async Task<IResult> TreeAsync(
        AppDbContext db, StorageAllocator storage, TenantContext tenant, CancellationToken ct)
    {
        var rows = await db.Departments.AsNoTracking()
            .OrderBy(d => d.Name)
            .Select(d => new
            {
                d.Id, d.ParentId, d.Name, d.Description, d.DefaultRole,
                d.DefaultProducts, d.CanSendExternal, d.Colour, d.DefaultQuotaBytes,
                UserCount = db.Users.Count(u => u.DepartmentId == d.Id && u.Status != "deleted"),
            })
            .ToListAsync(ct);

        // The pool's per-user quota is where inheritance bottoms out, so a
        // department with no value anywhere up its chain still shows a real
        // number rather than a blank.
        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == tenant.TenantId, ct);
        var floor = pool?.PerUserQuotaBytes ?? StorageAllocator.DefaultPerUserQuota;

        var byParent = rows.ToLookup(r => r.ParentId);

        // Resolved in one pass down the tree, carrying each level's effective
        // value with it — rather than walking up per node, which is O(n·depth)
        // on a screen that renders every department at once.
        List<Node> Build(Guid? parentId, long inherited)
        {
            return byParent[parentId].Select(r =>
            {
                var own = r.DefaultQuotaBytes;
                var effective = own ?? inherited;
                var children = Build(r.Id, effective);

                return new Node(
                    r.Id, r.ParentId, r.Name, r.Description, r.DefaultRole,
                    r.DefaultProducts, r.CanSendExternal, r.Colour,
                    OwnQuotaBytes: own,
                    EffectiveQuotaBytes: effective,
                    QuotaInherited: own is null,
                    UserCount: r.UserCount,
                    // Includes everyone beneath. "Engineering has 3 people" is
                    // misleading when its four sub-teams hold forty more.
                    DescendantUserCount: r.UserCount + children.Sum(c => c.DescendantUserCount),
                    Children: children);
            }).ToList();
        }

        var tree = Build(null, floor);
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);

        return Results.Ok(new
        {
            tree,
            unassignedUsers = await db.Users.CountAsync(
                u => u.DepartmentId == null && u.Status != "deleted", ct),
            storage = new
            {
                capacity.StorageModel,
                capacity.TotalBytes,
                capacity.UsedBytes,
                capacity.AvailableBytes,
                perUserFloor = floor,
                capacity.UserCount,
                capacity.MaxUsers,
            },
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CreateAsync(
        SaveDepartmentRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length < 2)
            return Results.BadRequest(new { error = "A department name is required." });

        // Unique among SIBLINGS, not tenant-wide. Two "Administration"
        // departments under different parents is normal in a school; refusing
        // it would force meaningless names like "Admin (Primary)".
        if (await db.Departments.AnyAsync(d => d.ParentId == req.ParentId && d.Name == name, ct))
            return Results.Conflict(new
            {
                error = req.ParentId is null
                    ? $"A top-level department called {name} already exists."
                    : $"That department already contains one called {name}.",
            });

        if (req.ParentId is Guid p && !await db.Departments.AnyAsync(d => d.Id == p, ct))
            return Results.BadRequest(new { error = "The parent department does not exist." });

        var known = await db.Products.Select(x => x.Code).ToListAsync(ct);
        var products = req.DefaultProducts ?? ["mail"];
        var unknown = products.Except(known).ToArray();
        if (unknown.Length > 0)
            return Results.BadRequest(new { error = $"Unknown product(s): {string.Join(", ", unknown)}" });

        var dept = new Department
        {
            TenantId = tenant.TenantId,
            ParentId = req.ParentId,
            Name = name,
            Description = req.Description,
            DefaultRole = req.DefaultRole ?? "employee",
            DefaultQuotaBytes = req.DefaultQuotaBytes,
            DefaultProducts = products,
            CanSendExternal = req.CanSendExternal ?? false,
            Colour = req.Colour ?? "#7367f0",
        };

        db.Departments.Add(dept);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("department.created", "department", dept.Id.ToString(),
            after: new { dept.Name, parent = req.ParentId }, ct: ct);

        return Results.Created($"/api/org/departments/{dept.Id}", new { dept.Id, dept.Name });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> UpdateAsync(
        Guid id, SaveDepartmentRequest req, AppDbContext db, AuditWriter audit,
        CancellationToken ct)
    {
        var dept = await db.Departments.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (dept is null) return Results.NotFound();

        var before = new { dept.Name, dept.DefaultQuotaBytes, dept.ParentId };

        if (!string.IsNullOrWhiteSpace(req.Name)) dept.Name = req.Name.Trim();
        dept.Description = req.Description;
        if (req.DefaultRole is not null) dept.DefaultRole = req.DefaultRole;
        if (req.DefaultProducts is not null) dept.DefaultProducts = req.DefaultProducts;
        if (req.CanSendExternal is bool ext) dept.CanSendExternal = ext;
        if (req.Colour is not null) dept.Colour = req.Colour;

        // Assigned unconditionally, so clearing it back to NULL — "inherit
        // from my parent again" — is expressible. A null-coalescing update
        // would make that impossible to say.
        dept.DefaultQuotaBytes = req.DefaultQuotaBytes;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("department.updated", "department", id.ToString(),
            before, new { dept.Name, dept.DefaultQuotaBytes }, ct);

        return Results.Ok(new { dept.Id, dept.Name });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> MoveAsync(
        Guid id, MoveDepartmentRequest req, AppDbContext db, AuditWriter audit,
        CancellationToken ct)
    {
        var dept = await db.Departments.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (dept is null) return Results.NotFound();

        if (req.ParentId is Guid p)
        {
            if (p == id)
                return Results.BadRequest(new { error = "A department cannot contain itself." });
            if (!await db.Departments.AnyAsync(d => d.Id == p, ct))
                return Results.BadRequest(new { error = "The destination department does not exist." });
        }

        var from = dept.ParentId;
        dept.ParentId = req.ParentId;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (
            ex.InnerException?.Message.Contains("sub-departments", StringComparison.OrdinalIgnoreCase) == true
            || ex.InnerException?.Message.Contains("own parent", StringComparison.OrdinalIgnoreCase) == true
            || ex.InnerException?.Message.Contains("too deep", StringComparison.OrdinalIgnoreCase) == true)
        {
            // The database trigger refuses cycles. Catching it beats
            // duplicating the walk in C#, where the copy would eventually
            // disagree with the trigger and one of them would be wrong.
            return Results.BadRequest(new
            {
                error = "That move would put the department inside one of its own sub-departments.",
            });
        }

        await audit.WriteAsync("department.moved", "department", id.ToString(),
            new { parent = from }, new { parent = dept.ParentId }, ct);

        return Results.Ok(new
        {
            dept.Id,
            dept.ParentId,
            note = "Storage and permissions for everyone in this department and below now "
                 + "inherit from its new parent.",
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> DeleteAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var dept = await db.Departments.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (dept is null) return Results.NotFound();

        // Refused rather than cascaded. The database would happily delete the
        // sub-tree, and with it the department every one of those people
        // belongs to — quota, products and send permission all silently
        // reverting to the tenant defaults. Moving people first is the
        // admin's decision to make, explicitly.
        var children = await db.Departments.CountAsync(d => d.ParentId == id, ct);
        if (children > 0)
            return Results.BadRequest(new
            {
                error = $"{dept.Name} contains {children} sub-department(s). Move or delete those first.",
            });

        var users = await db.Users.CountAsync(u => u.DepartmentId == id && u.Status != "deleted", ct);
        if (users > 0)
            return Results.BadRequest(new
            {
                error = $"{users} person(s) are in {dept.Name}. Move them to another department first — "
                      + "deleting it would reset their storage and permissions to the organisation defaults.",
            });

        db.Departments.Remove(dept);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("department.deleted", "department", id.ToString(),
            before: new { dept.Name }, ct: ct);

        return Results.Ok(new { deleted = true });
    }
}

public sealed record SaveDepartmentRequest(
    string? Name,
    string? Description,
    Guid? ParentId,
    string? DefaultRole,
    long? DefaultQuotaBytes,
    string[]? DefaultProducts,
    bool? CanSendExternal,
    string? Colour);

/// <summary>
/// Moving is its own endpoint on purpose.
///
/// On the update payload, a Guid? parent cannot distinguish "leave it alone"
/// from "move to top level" — both arrive as null. A separate call makes the
/// intent unambiguous, and reparenting is a rarer, riskier action than
/// renaming: it changes what every person underneath inherits.
/// </summary>
public sealed record MoveDepartmentRequest(Guid? ParentId);
