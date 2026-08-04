using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Platform administration — onboarding and managing organisations.
///
/// Every route here requires the super_admin role and runs in platform scope.
/// Note what platform scope does NOT do: it does not disable row-level
/// security. It sets the tenant for one operation at a time, so even an
/// operator listing every organisation reads them one tenant at a time.
/// There is deliberately no "see everything" mode, because a bug in one would
/// be unbounded.
/// </summary>
public static class OrganisationEndpoints
{
    public static void MapOrganisationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        g.MapGet("/", ListAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapPost("/", CreateAsync);
        g.MapPost("/{id:guid}/suspend", SuspendAsync);
        g.MapPost("/{id:guid}/activate", ActivateAsync);
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        // Tenants itself carries no RLS policy — it IS the boundary — so this
        // listing is safe. Everything hanging off it is read per tenant below.
        var orgs = await db.Tenants.AsNoTracking()
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);

        var actor = CurrentUserId(http);
        var results = new List<OrganisationResponse>(orgs.Count);

        foreach (var org in orgs)
        {
            // Scope to each organisation in turn. The alternative — one query
            // with RLS off — is exactly the unbounded read this design avoids.
            tenant.EnterPlatformScope(org.Id, actor);

            var cap = await storage.GetCapacityAsync(org.Id, ct);
            var domain = await db.Domains.AsNoTracking()
                .Where(d => d.Type == "primary")
                .Select(d => d.Fqdn)
                .FirstOrDefaultAsync(ct);
            var domainCount = await db.Domains.CountAsync(ct);

            results.Add(new OrganisationResponse(
                org.Id, org.Name, org.Type, org.Status,
                domain ?? "—", org.StorageModel, org.MaxUsers,
                cap.UserCount, cap.TotalBytes, cap.UsedBytes,
                domainCount, org.AdminEmail, org.CreatedAt, org.TrialEndsAt));
        }

        return Results.Ok(results);
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, StorageAllocator storage, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));

        var cap = await storage.GetCapacityAsync(org.Id, ct);
        var domain = await db.Domains.AsNoTracking()
            .Where(d => d.Type == "primary").Select(d => d.Fqdn).FirstOrDefaultAsync(ct);

        return Results.Ok(new OrganisationResponse(
            org.Id, org.Name, org.Type, org.Status, domain ?? "—",
            org.StorageModel, org.MaxUsers, cap.UserCount,
            cap.TotalBytes, cap.UsedBytes,
            await db.Domains.CountAsync(ct), org.AdminEmail, org.CreatedAt, org.TrialEndsAt));
    }

    /// <summary>
    /// Onboard an organisation.
    ///
    /// The organisation is created in <c>pending</c> and stays there until the
    /// domain's ownership is proven by DNS. Nothing is delivered for an
    /// unverified domain, and no user can send as it. That single rule is what
    /// stops anyone claiming a domain they do not control — and it is the
    /// answer we give providers who ask how abuse is prevented.
    /// </summary>
    private static async Task<IResult> CreateAsync(
        CreateOrganisationRequest req,
        AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var fqdn = req.PrimaryDomain.Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Organisation name is required." });

        if (!IsPlausibleDomain(fqdn))
            return Results.BadRequest(new { error = "Primary domain is not a valid domain name." });

        if (req.StorageModel is not ("per_user" or "pooled"))
            return Results.BadRequest(new { error = "StorageModel must be 'per_user' or 'pooled'." });

        // Domains are unique platform-wide. Whoever verifies ownership first
        // holds it — checked here for a clear error, and enforced by a unique
        // index so a race cannot slip through.
        if (await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == fqdn, ct))
            return Results.Conflict(new { error = $"The domain {fqdn} is already registered on this platform." });

        var org = new Tenant
        {
            Name = req.Name.Trim(),
            Type = req.Type,
            Status = "pending",
            PlanId = req.PlanId,
            StorageModel = req.StorageModel,
            MaxUsers = req.MaxUsers,
            PerUserQuotaBytes = req.StorageModel == "per_user" ? req.PerUserQuotaBytes : null,
            PooledStorageBytes = req.StorageModel == "pooled" ? req.PooledStorageBytes : null,
            AdminName = req.AdminName,
            AdminEmail = req.AdminEmail,
            Phone = req.Phone,
            Country = req.Country,
            Gstin = req.Gstin,
            TrialEndsAt = DateTimeOffset.UtcNow.AddDays(30),
        };

        db.Tenants.Add(org);
        await db.SaveChangesAsync(ct);

        // From here on, act inside the new organisation.
        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));

        var domain = new Domain
        {
            TenantId = org.Id,
            Fqdn = fqdn,
            Type = "primary",
            IsActive = false,
            VerificationToken = GenerateVerificationToken(),
            DkimSelector = $"tv{DateTime.UtcNow:yyyy}a",
        };
        db.Domains.Add(domain);

        // Sensible starting categories by organisation type. An admin facing
        // an empty screen has to invent structure before they can create a
        // single user; these give them something to edit instead.
        foreach (var c in DefaultCategories(req.Type, org.Id))
            db.UserCategories.Add(c);

        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("organisation.created", "tenant", org.Id.ToString(),
            after: new { org.Name, org.Type, org.StorageModel, domain = fqdn }, ct: ct);

        return Results.Created($"/api/admin/organisations/{org.Id}", new
        {
            org.Id,
            org.Name,
            org.Status,
            domain = fqdn,
            verification = new
            {
                type = "TXT",
                host = "@",
                value = $"tatvaos-verification={domain.VerificationToken}",
                note = "The organisation must publish this record before any mail is accepted for the domain.",
            },
        });
    }

    private static async Task<IResult> SuspendAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new { org.Status };
        org.Status = "suspended";
        org.SuspendedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await audit.WriteAsync("organisation.suspended", "tenant", org.Id.ToString(),
            before, new { org.Status }, ct);

        // Suspension stops authentication and delivery immediately, but does
        // not delete anything. Data removal is a separate, deliberate action
        // after the grace period — see the billing policy.
        return Results.Ok(new { org.Id, org.Status });
    }

    private static async Task<IResult> ActivateAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new { org.Status };
        org.Status = "active";
        org.SuspendedAt = null;
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await audit.WriteAsync("organisation.activated", "tenant", org.Id.ToString(),
            before, new { org.Status }, ct);

        return Results.Ok(new { org.Id, org.Status });
    }

    // ------------------------------------------------------------------

    private static Guid CurrentUserId(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var id) ? id : Guid.Empty;

    private static string GenerateVerificationToken() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    private static bool IsPlausibleDomain(string fqdn) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            fqdn, @"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$")
        && fqdn.Length <= 253;

    private static IEnumerable<UserCategory> DefaultCategories(string orgType, Guid tenantId)
    {
        const long GB = 1024L * 1024 * 1024;

        (string Name, long Quota, string Role, bool External, string Colour)[] defs = orgType switch
        {
            "school" =>
            [
                ("Leadership",     50 * GB, "org_admin", true,  "#ea580c"),
                ("Teachers",       15 * GB, "employee",  true,  "#3563f0"),
                ("Administration", 20 * GB, "manager",   true,  "#a855f7"),
                // Students blocked from external send by default. A school
                // requirement, and one of the strongest abuse controls we have.
                ("Students",        2 * GB, "employee",  false, "#16a34a"),
            ],
            "hospital" =>
            [
                ("Doctors",        30 * GB, "employee", true,  "#3563f0"),
                ("Nursing",        15 * GB, "employee", true,  "#16a34a"),
                ("Reception",      10 * GB, "employee", true,  "#a855f7"),
                ("Administration", 30 * GB, "manager",  true,  "#ea580c"),
            ],
            _ =>
            [
                ("Leadership",  50 * GB, "org_admin", true, "#ea580c"),
                ("Staff",       30 * GB, "employee",  true, "#3563f0"),
                ("Contractors",  5 * GB, "employee",  true, "#a855f7"),
            ],
        };

        return defs.Select(d => new UserCategory
        {
            TenantId = tenantId,
            Name = d.Name,
            DefaultQuotaBytes = d.Quota,
            DefaultRole = d.Role,
            CanSendExternal = d.External,
            Colour = d.Colour,
        });
    }
}
