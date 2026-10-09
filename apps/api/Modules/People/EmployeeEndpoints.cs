using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.People;

/// <summary>
/// /api/people — employee records and People HR (decision 0018, stage one).
///
/// ─────────────────────────────────────────────────────────────────────────
///  Reads go through PeopleAccess.VisibleAsync: HR sees everyone, anyone else
///  themselves and the people below them. Writes are People HR only.
///
///  The database holds the rules and this file only puts them into words:
///  no reporting to yourself, no loops, no exited manager, no exit while
///  people still report to you, no reporting change without a named person
///  (20261009-people-employees.sql). Each refusal arrives as a check
///  violation with a sentence, and is answered 409 with that sentence.
///
///  SETTING reports_to GRANTS ACCESS (Mr. Singh, 9 Oct). The audit of it is
///  people.reporting_changes, written by the database; this file adds an
///  ordinary audit row as well, naming the field, never personal data.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class EmployeeEndpoints
{
    private static readonly string[] Types = ["full_time", "part_time", "contract", "intern"];

    public static void MapEmployeeEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/people").RequireAuthorization("User").WithTags("People");
        g.MapGet("/me", MeAsync);
        g.MapGet("/options", OptionsAsync);
        // The staff directory (0018 §5): colleagues, directory fields only.
        g.MapGet("/directory", DirectoryAsync);
        g.MapGet("/directory/settings", GetDirectorySettingsAsync);
        g.MapPut("/directory/settings", PutDirectorySettingsAsync);
        g.MapGet("/employees", ListAsync);
        g.MapGet("/employees/{id:guid}", GetAsync);
        g.MapPost("/employees", CreateAsync);
        g.MapPut("/employees/{id:guid}", UpdateAsync);
        g.MapPost("/employees/{id:guid}/exit", ExitAsync);
        g.MapGet("/employees/{id:guid}/reporting-changes", HistoryAsync);
        g.MapGet("/hr", ListHrAsync);
        g.MapPut("/hr/{userId:guid}", AddHrAsync);
        g.MapDelete("/hr/{userId:guid}", RemoveHrAsync);
    }

    public sealed record SaveEmployeeRequest(
        string? FullName, string? WorkEmail, Guid? UserId, Guid? DepartmentId, Guid? DesignationId,
        Guid? LocationId, Guid? ReportsTo, string? EmploymentType, DateOnly? JoinedOn,
        string? EmployeeCode, string? Status);

    public sealed record ExitRequest(DateOnly? ExitOn);
    public sealed record DirectorySettingsRequest(string? VisibleTo, bool? ShowManager);

    private static object Shape(Employee e) => new
    {
        e.Id, e.EmployeeCode, e.UserId, e.FullName, e.WorkEmail, e.DepartmentId, e.DesignationId,
        e.LocationId, e.ReportsTo, e.EmploymentType, e.Status, e.JoinedOn, e.ExitOn,
    };

    private static IResult Forbidden(string msg) =>
        Results.Json(new { error = msg }, statusCode: StatusCodes.Status403Forbidden);

    // ================================================================ reads

    private static async Task<IResult> MeAsync(PeopleAccess access, CancellationToken ct)
    {
        var me = await access.MeAsync(ct);
        return Results.Ok(new
        {
            isHr = await access.IsHrAsync(ct),
            canNameHr = access.CanNameHr(),
            employee = me is null ? null : Shape(me),
            directReports = me is null ? 0 : await access.DirectReportsAsync(me.Id, ct),
            canSeeDirectory = await access.CanSeeDirectoryAsync(ct),
        });
    }

    /// <summary>
    /// What HR's form picks from: departments, designations and locations in
    /// use, sign-ins not yet linked to a record, and managers (people still
    /// here). HR only — it lists the organisation's sign-ins.
    /// </summary>
    private static async Task<IResult> OptionsAsync(PeopleAccess access, AppDbContext db, CancellationToken ct)
    {
        if (!await access.IsHrAsync(ct)) return Forbidden("Only People HR can add or change employee records.");
        var everyone = await (await access.VisibleAsync(ct)).AsNoTracking()
            .Select(e => new { e.Id, e.FullName, e.EmployeeCode, e.Status, e.UserId })
            .ToListAsync(ct);
        var linked = everyone.Where(e => e.UserId is not null).Select(e => e.UserId!.Value).ToHashSet();
        var users = await db.Users.AsNoTracking().Where(u => u.Status != "deleted")
            .OrderBy(u => u.DisplayName).Select(u => new { u.Id, u.DisplayName, u.Email }).ToListAsync(ct);
        return Results.Ok(new
        {
            // 'manual' means the form asks for the ID; 'auto' gives it on save.
            codeMode = await access.SchemeModeAsync(ct) ?? "auto",
            departments = await db.Departments.AsNoTracking().OrderBy(d => d.Name).Select(d => new { d.Id, d.Name }).ToListAsync(ct),
            designations = await db.OrgDesignations.AsNoTracking().Where(d => d.IsActive).OrderBy(d => d.Title).Select(d => new { d.Id, name = d.Title }).ToListAsync(ct),
            locations = await db.OrgLocations.AsNoTracking().Where(l => l.IsActive).OrderBy(l => l.Name).Select(l => new { l.Id, l.Name }).ToListAsync(ct),
            // Linked sign-ins are listed too, marked, so the form can still show
            // the one already on the record being edited.
            signIns = users.Select(u => new { u.Id, u.DisplayName, u.Email, linked = linked.Contains(u.Id) }),
            managers = everyone.Where(e => e.Status != "exited").OrderBy(e => e.FullName)
                .Select(e => new { e.Id, name = e.FullName, code = e.EmployeeCode }),
        });
    }

    private static async Task<IResult> ListAsync(PeopleAccess access, string? q, string? status, CancellationToken ct)
    {
        var rows = (await access.VisibleAsync(ct)).AsNoTracking();
        if (!string.IsNullOrWhiteSpace(status)) rows = rows.Where(e => e.Status == status);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var k = q.Trim().ToLower();
            rows = rows.Where(e => e.FullName.ToLower().Contains(k) || e.EmployeeCode.ToLower().Contains(k));
        }
        var list = await rows.OrderBy(e => e.FullName).Take(500).ToListAsync(ct);
        return Results.Ok(list.Select(Shape));
    }

    private static async Task<IResult> GetAsync(Guid id, PeopleAccess access, CancellationToken ct)
    {
        var e = await (await access.VisibleAsync(ct)).AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        return e is null ? Results.NotFound() : Results.Ok(Shape(e));
    }

    /// <summary>Who changed this person's manager, and when. HR, or the person themselves.</summary>
    private static async Task<IResult> HistoryAsync(Guid id, PeopleAccess access, CancellationToken ct)
    {
        var me = await access.MeAsync(ct);
        if (!await access.IsHrAsync(ct) && me?.Id != id) return Results.NotFound();
        if (!await access.ExistsAsync(id, ct)) return Results.NotFound();
        var rows = await access.ReportingHistoryAsync(id, ct);
        return Results.Ok(rows.Select(r => new { r.FromManagerId, r.ToManagerId, r.ChangedBy, r.ChangedAt }));
    }

    // ================================================================ directory

    /// <summary>
    /// The staff directory. Everyone in the organisation by default; People
    /// HR only if the organisation says so. Fields: name, designation,
    /// department, location, work email, manager (if shown) — never code,
    /// status, dates or employment type (PeopleAccess.DirectoryEntry).
    /// </summary>
    private static async Task<IResult> DirectoryAsync(
        PeopleAccess access, string? q, Guid? departmentId, Guid? locationId, CancellationToken ct)
    {
        if (!await access.CanSeeDirectoryAsync(ct))
            return Forbidden("Your organisation shows the staff directory to People HR only.");
        return Results.Ok(await access.DirectoryAsync(q, departmentId, locationId, ct));
    }

    private static async Task<IResult> GetDirectorySettingsAsync(PeopleAccess access, CancellationToken ct)
    {
        if (!access.CanNameHr() && !await access.IsHrAsync(ct))
            return Forbidden("Only administrators and People HR can see the directory settings.");
        var s = await access.DirectorySettingsAsync(ct);
        return Results.Ok(new { s.VisibleTo, s.ShowManager });
    }

    /// <summary>Narrowing only: the hidden fields are never returned, whatever this says.</summary>
    private static async Task<IResult> PutDirectorySettingsAsync(
        DirectorySettingsRequest req, PeopleAccess access, AuditWriter audit, TenantContext tenant, CancellationToken ct)
    {
        if (!access.CanNameHr() && !await access.IsHrAsync(ct))
            return Forbidden("Only administrators and People HR can change who sees the directory.");
        var visibleTo = req.VisibleTo ?? "everyone";
        if (visibleTo is not ("everyone" or "hr_only"))
            return Results.BadRequest(new { error = "Who sees the directory is everyone or hr_only." });
        var before = await access.DirectorySettingsAsync(ct);
        await access.SaveDirectorySettingsAsync(visibleTo, req.ShowManager ?? true, ct);
        await audit.WriteAsync("people_directory.settings_changed", "directory_settings", tenant.TenantId.ToString(),
            before: new { before.VisibleTo, before.ShowManager },
            after: new { VisibleTo = visibleTo, ShowManager = req.ShowManager ?? true }, ct: ct, productCode: "people");
        return Results.Ok(new { visibleTo, showManager = req.ShowManager ?? true });
    }

    // ================================================================ writes

    private static async Task<IResult> CreateAsync(
        SaveEmployeeRequest req, PeopleAccess access, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (!await access.IsHrAsync(ct)) return Forbidden("Only People HR can add employees.");
        var error = await ValidateAsync(req, null, access, db, ct);
        if (error is not null) return Results.BadRequest(new { error });
        if (req.JoinedOn is null) return Results.BadRequest(new { error = "Give the date they joined." });

        var mode = await access.SchemeModeAsync(ct) ?? "auto";
        var typed = req.EmployeeCode?.Trim();
        if (mode == "auto" && !string.IsNullOrEmpty(typed))
            return Results.BadRequest(new { error = "Employee IDs are given automatically here. Leave the ID empty, or switch the scheme to manual." });
        if (mode == "manual" && string.IsNullOrEmpty(typed))
            return Results.BadRequest(new { error = "This organisation types employee IDs by hand. Give one." });
        if (typed is { Length: > 30 }) return Results.BadRequest(new { error = "An employee ID can be at most 30 characters." });

        var now = DateTimeOffset.UtcNow;
        var e = new Employee
        {
            Id = Guid.NewGuid(), TenantId = tenant.TenantId, CreatedAt = now, UpdatedAt = now,
            CreatedBy = tenant.UserId, UpdatedBy = tenant.UserId, JoinedOn = req.JoinedOn.Value, Status = "active",
        };
        Apply(e, req);

        // The number and the row in one transaction: a refused insert gives
        // its number back instead of leaving a gap.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        e.EmployeeCode = mode == "auto" ? await access.NextCodeAsync(ct) : typed!;
        access.Add(e);
        var refused = await TrySaveAsync(access, ct);
        if (refused is not null) return refused;
        await tx.CommitAsync(ct);

        await audit.WriteAsync("employee.created", "employee", e.Id.ToString(),
            after: new { e.EmployeeCode, hasManager = e.ReportsTo is not null, linkedToLogin = e.UserId is not null },
            ct: ct, productCode: "people");
        return Results.Created($"/api/people/employees/{e.Id}", Shape(e));
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, SaveEmployeeRequest req, PeopleAccess access, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (!await access.IsHrAsync(ct)) return Forbidden("Only People HR can change employee records.");
        var e = await access.ForHrEditAsync(id, ct);
        if (e is null) return Results.NotFound();
        if (e.Status == "exited") return Results.Conflict(new { error = "This person has left. Their record is kept as it was." });
        if (!string.IsNullOrEmpty(req.EmployeeCode) && !string.Equals(req.EmployeeCode.Trim(), e.EmployeeCode, StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "An employee ID never changes once given." });
        var error = await ValidateAsync(req, e, access, db, ct);
        if (error is not null) return Results.BadRequest(new { error });
        if (req.Status is not null && req.Status is not ("active" or "on_notice"))
            return Results.BadRequest(new { error = "Status is active or on_notice here. Someone leaving goes through Exit." });

        var managerBefore = e.ReportsTo;
        Apply(e, req);
        if (req.JoinedOn is { } j) e.JoinedOn = j;
        if (req.Status is not null) e.Status = req.Status;
        e.UpdatedAt = DateTimeOffset.UtcNow;
        e.UpdatedBy = tenant.UserId;
        var refused = await TrySaveAsync(access, ct);
        if (refused is not null) return refused;

        await audit.WriteAsync("employee.updated", "employee", e.Id.ToString(),
            after: new { managerChanged = managerBefore != e.ReportsTo, e.Status }, ct: ct, productCode: "people");
        return Results.Ok(Shape(e));
    }

    private static async Task<IResult> ExitAsync(
        Guid id, ExitRequest req, PeopleAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (!await access.IsHrAsync(ct)) return Forbidden("Only People HR can record someone leaving.");
        var e = await access.ForHrEditAsync(id, ct);
        if (e is null) return Results.NotFound();
        if (e.Status == "exited") return Results.Conflict(new { error = "This person has already left." });
        if (req.ExitOn is not { } exitOn) return Results.BadRequest(new { error = "Give their last day." });
        if (exitOn < e.JoinedOn) return Results.BadRequest(new { error = "Their last day cannot be before they joined." });
        e.Status = "exited";
        e.ExitOn = exitOn;
        e.UpdatedAt = DateTimeOffset.UtcNow;
        e.UpdatedBy = tenant.UserId;
        var refused = await TrySaveAsync(access, ct);
        if (refused is not null) return refused;
        await audit.WriteAsync("employee.exited", "employee", e.Id.ToString(), after: new { e.ExitOn }, ct: ct, productCode: "people");
        return Results.Ok(Shape(e));
    }

    // ================================================================ People HR

    private static async Task<IResult> ListHrAsync(PeopleAccess access, AppDbContext db, CancellationToken ct)
    {
        if (!access.CanNameHr() && !await access.IsHrAsync(ct)) return Forbidden("Only administrators and People HR can see who is People HR.");
        var members = await access.HrMembersAsync(ct);
        var ids = members.Select(m => m.UserId).ToList();
        var names = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return Results.Ok(members.Select(m => new { m.UserId, name = names.GetValueOrDefault(m.UserId), m.AddedBy, m.CreatedAt }));
    }

    /// <summary>
    /// Administrators name People HR — themselves included. An owner is not HR
    /// until they do this (Amit, 9 Oct: one click, and the moment is recorded).
    /// </summary>
    private static async Task<IResult> AddHrAsync(
        Guid userId, PeopleAccess access, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (!access.CanNameHr()) return Forbidden("Only an administrator can name People HR.");
        if (!await db.Users.AnyAsync(u => u.Id == userId && u.Status != "deleted", ct)) return Results.NotFound();
        if (!await access.AddHrAsync(userId, ct)) return Results.Ok(new { added = false });
        await audit.WriteAsync("people_hr.added", "user", userId.ToString(),
            after: new { appointedThemselves = userId == tenant.UserId }, ct: ct, productCode: "people");
        return Results.Ok(new { added = true });
    }

    private static async Task<IResult> RemoveHrAsync(
        Guid userId, PeopleAccess access, AuditWriter audit, TenantContext tenant, CancellationToken ct)
    {
        if (!access.CanNameHr()) return Forbidden("Only an administrator can change People HR.");
        if (!await access.RemoveHrAsync(userId, ct)) return Results.NotFound();
        await audit.WriteAsync("people_hr.removed", "user", userId.ToString(),
            after: new { removedThemselves = userId == tenant.UserId }, ct: ct, productCode: "people");
        return Results.Ok(new { removed = true });
    }

    // ================================================================ helpers

    private static void Apply(Employee e, SaveEmployeeRequest req)
    {
        e.FullName = req.FullName!.Trim();
        e.WorkEmail = string.IsNullOrWhiteSpace(req.WorkEmail) ? null : req.WorkEmail.Trim();
        e.UserId = req.UserId;
        e.DepartmentId = req.DepartmentId;
        e.DesignationId = req.DesignationId;
        e.LocationId = req.LocationId;
        e.ReportsTo = req.ReportsTo;
        e.EmploymentType = req.EmploymentType ?? e.EmploymentType;
    }

    /// <summary>
    /// What the API checks before the database does: answers that name the
    /// field. Another organisation's department, person or manager is "does not
    /// exist" here (the tenant filter) and refused by the composite foreign
    /// keys behind it.
    /// </summary>
    private static async Task<string?> ValidateAsync(
        SaveEmployeeRequest req, Employee? current, PeopleAccess access, AppDbContext db, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.FullName) || req.FullName.Trim().Length > 200)
            return "Give their name, up to 200 characters.";
        if (req.WorkEmail is { Length: > 320 }) return "That email address is too long.";
        if (req.EmploymentType is not null && !Types.Contains(req.EmploymentType))
            return "Employment type is full_time, part_time, contract or intern.";
        if (req.DepartmentId is Guid d && !await db.Departments.AnyAsync(x => x.Id == d, ct))
            return "That department does not exist.";
        // An archived location or designation may stay on a record, not be newly chosen.
        if (req.LocationId is Guid l && l != current?.LocationId
            && !await db.OrgLocations.AnyAsync(x => x.Id == l && x.IsActive, ct))
            return "That location does not exist or is no longer in use.";
        if (req.DesignationId is Guid g && g != current?.DesignationId
            && !await db.OrgDesignations.AnyAsync(x => x.Id == g && x.IsActive, ct))
            return "That designation does not exist or is no longer in use.";
        if (req.UserId is Guid u)
        {
            if (!await db.Users.AnyAsync(x => x.Id == u && x.Status != "deleted", ct))
                return "That sign-in does not exist in this organisation.";
            if (await access.UserLinkedAsync(u, current?.Id, ct))
                return "That sign-in already belongs to another employee record.";
        }
        if (req.ReportsTo is Guid m && !await access.ExistsAsync(m, ct))
            return "That manager does not exist in this organisation.";
        return null;
    }

    /// <summary>
    /// Saves, and turns the database's refusals into 409s with their sentence.
    /// The trigger's sentences are written for people (no loop, no exited
    /// manager, people still reporting); the unique indexes get one here.
    /// </summary>
    private static async Task<IResult?> TrySaveAsync(PeopleAccess access, CancellationToken ct)
    {
        try
        {
            await access.SaveAsync(ct);
            return null;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException pg)
        {
            var msg = pg.SqlState switch
            {
                PostgresErrorCodes.CheckViolation when pg.ConstraintName?.StartsWith("ck_people_") == true
                                                   || pg.ConstraintName == "ck_employee_not_own_manager" => pg.MessageText,
                PostgresErrorCodes.UniqueViolation when pg.ConstraintName == "ux_people_employees_code" =>
                    "That employee ID is already taken. If the scheme handed it out, raise its next number past the IDs typed by hand.",
                PostgresErrorCodes.UniqueViolation when pg.ConstraintName == "ux_people_employees_user" =>
                    "That sign-in already belongs to another employee record.",
                _ => null,
            };
            if (msg is null) throw;
            return Results.Conflict(new { error = msg });
        }
    }
}
