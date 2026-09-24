using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Locations and designations — Phase 0 of Hire &amp; People (24 Sept 2026).
///
/// Two flat lists an organisation keeps once and every job opening, and
/// later every employee, picks from. Deliberately the dullest possible CRUD:
/// the interesting rules are few, and they are these.
///
/// ─────────────────────────────────────────────────────────────────────────
///  UNIQUE IGNORING CASE AND SPACES. "Pune" and " pune" are one office. The
///  database enforces it (a unique index on lower(btrim(name))); the check
///  here exists only to answer 409 with a sentence instead of a 500.
///
///  ARCHIVE BEFORE DELETE. is_active = false keeps a row meaning what it
///  meant for everything already naming it. Delete is allowed today because
///  nothing references these tables yet; the first table that does must add
///  its refusal to DeleteLocationAsync / DeleteDesignationAsync, exactly as
///  departments refuse while people are in them.
///
///  ADMINS ONLY, READS INCLUDED. Hire will need hiring managers to pick from
///  these lists; that read goes through Hire's own endpoints when they exist,
///  scoped to what a job form needs, rather than widening this group.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OrgStructureEndpoints
{
    public static void MapOrgStructureEndpoints(this IEndpointRouteBuilder app)
    {
        var loc = app.MapGroup("/api/org/locations")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");
        loc.MapGet("/", ListLocationsAsync);
        loc.MapPost("/", CreateLocationAsync);
        loc.MapPut("/{id:guid}", UpdateLocationAsync);
        loc.MapDelete("/{id:guid}", DeleteLocationAsync);

        var des = app.MapGroup("/api/org/designations")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");
        des.MapGet("/", ListDesignationsAsync);
        des.MapPost("/", CreateDesignationAsync);
        des.MapPut("/{id:guid}", UpdateDesignationAsync);
        des.MapDelete("/{id:guid}", DeleteDesignationAsync);
    }

    // ================================================================ locations

    private static async Task<IResult> ListLocationsAsync(AppDbContext db, CancellationToken ct)
    {
        var rows = await db.OrgLocations.AsNoTracking()
            .OrderByDescending(l => l.IsActive).ThenBy(l => l.Name)
            .Select(l => new
            {
                l.Id, l.Name, l.Code, l.AddressLine, l.City, l.State, l.PostalCode,
                l.Country, l.IsRemote, l.IsActive,
            })
            .ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> CreateLocationAsync(
        SaveLocationRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var error = ValidateLocation(req, out var name, out var country);
        if (error is not null) return Results.BadRequest(new { error });

        if (await LocationNameTakenAsync(db, name, except: null, ct))
            return Results.Conflict(new { error = $"A location called {name} already exists." });

        var now = DateTimeOffset.UtcNow;
        var row = new OrgLocation
        {
            Id = Guid.NewGuid(),
            TenantId = tenant.TenantId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        ApplyLocation(row, req, name, country);

        db.OrgLocations.Add(row);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("location.created", "location", row.Id.ToString(),
            after: new { row.Name, row.City, row.IsRemote }, ct: ct);

        return Results.Created($"/api/org/locations/{row.Id}", new { row.Id, row.Name });
    }

    private static async Task<IResult> UpdateLocationAsync(
        Guid id, SaveLocationRequest req, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var row = await db.OrgLocations.FirstOrDefaultAsync(l => l.Id == id, ct);
        if (row is null) return Results.NotFound();

        var error = ValidateLocation(req, out var name, out var country);
        if (error is not null) return Results.BadRequest(new { error });

        if (await LocationNameTakenAsync(db, name, except: id, ct))
            return Results.Conflict(new { error = $"A location called {name} already exists." });

        var before = new { row.Name, row.City, row.IsRemote, row.IsActive };
        ApplyLocation(row, req, name, country);
        row.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("location.updated", "location", id.ToString(),
            before, new { row.Name, row.City, row.IsRemote, row.IsActive }, ct);

        return Results.Ok(new { row.Id, row.Name });
    }

    private static async Task<IResult> DeleteLocationAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var row = await db.OrgLocations.FirstOrDefaultAsync(l => l.Id == id, ct);
        if (row is null) return Results.NotFound();

        // Nothing references a location yet. The first thing that does —
        // hire.job_openings — adds its refusal here.
        db.OrgLocations.Remove(row);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("location.deleted", "location", id.ToString(),
            before: new { row.Name }, ct: ct);

        return Results.Ok(new { deleted = true });
    }

    private static string? ValidateLocation(SaveLocationRequest req, out string name, out string country)
    {
        name = req.Name?.Trim() ?? "";
        country = (req.Country?.Trim() is { Length: > 0 } c ? c : "IN").ToUpperInvariant();

        if (name.Length is < 1 or > 100) return "A location name is required (up to 100 characters).";
        if (country.Length != 2 || !country.All(ch => ch is >= 'A' and <= 'Z'))
            return "Country must be a two-letter code, such as IN.";
        if (Clean(req.Code)?.Length > 20) return "The code can be at most 20 characters.";
        if (Clean(req.AddressLine)?.Length > 300) return "The address can be at most 300 characters.";
        if (Clean(req.City)?.Length > 100) return "The city can be at most 100 characters.";
        if (Clean(req.State)?.Length > 100) return "The state can be at most 100 characters.";
        if (Clean(req.PostalCode)?.Length > 20) return "The postal code can be at most 20 characters.";
        return null;
    }

    private static void ApplyLocation(OrgLocation row, SaveLocationRequest req, string name, string country)
    {
        row.Name = name;
        row.Code = Clean(req.Code);
        row.AddressLine = Clean(req.AddressLine);
        row.City = Clean(req.City);
        row.State = Clean(req.State);
        row.PostalCode = Clean(req.PostalCode);
        row.Country = country;
        row.IsRemote = req.IsRemote ?? false;
        row.IsActive = req.IsActive ?? true;
    }

    private static Task<bool> LocationNameTakenAsync(
        AppDbContext db, string name, Guid? except, CancellationToken ct)
    {
        var key = name.ToLower();
        return db.OrgLocations.AnyAsync(l => l.Name.Trim().ToLower() == key && l.Id != except, ct);
    }

    // ============================================================= designations

    private static async Task<IResult> ListDesignationsAsync(AppDbContext db, CancellationToken ct)
    {
        // Most senior first, unranked last, then alphabetical — the order a
        // job form's dropdown should read in.
        var rows = await db.OrgDesignations.AsNoTracking()
            .OrderByDescending(d => d.IsActive)
            .ThenBy(d => d.Level == null)
            .ThenByDescending(d => d.Level)
            .ThenBy(d => d.Title)
            .Select(d => new { d.Id, d.Title, d.Grade, d.Level, d.Description, d.IsActive })
            .ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> CreateDesignationAsync(
        SaveDesignationRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var error = ValidateDesignation(req, out var title);
        if (error is not null) return Results.BadRequest(new { error });

        if (await DesignationTitleTakenAsync(db, title, except: null, ct))
            return Results.Conflict(new { error = $"A designation called {title} already exists." });

        var now = DateTimeOffset.UtcNow;
        var row = new OrgDesignation
        {
            Id = Guid.NewGuid(),
            TenantId = tenant.TenantId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        ApplyDesignation(row, req, title);

        db.OrgDesignations.Add(row);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("designation.created", "designation", row.Id.ToString(),
            after: new { row.Title, row.Grade, row.Level }, ct: ct);

        return Results.Created($"/api/org/designations/{row.Id}", new { row.Id, row.Title });
    }

    private static async Task<IResult> UpdateDesignationAsync(
        Guid id, SaveDesignationRequest req, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var row = await db.OrgDesignations.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (row is null) return Results.NotFound();

        var error = ValidateDesignation(req, out var title);
        if (error is not null) return Results.BadRequest(new { error });

        if (await DesignationTitleTakenAsync(db, title, except: id, ct))
            return Results.Conflict(new { error = $"A designation called {title} already exists." });

        var before = new { row.Title, row.Grade, row.Level, row.IsActive };
        ApplyDesignation(row, req, title);
        row.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("designation.updated", "designation", id.ToString(),
            before, new { row.Title, row.Grade, row.Level, row.IsActive }, ct);

        return Results.Ok(new { row.Id, row.Title });
    }

    private static async Task<IResult> DeleteDesignationAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var row = await db.OrgDesignations.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (row is null) return Results.NotFound();

        // As for locations: the first table to reference a designation adds
        // its refusal here.
        db.OrgDesignations.Remove(row);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("designation.deleted", "designation", id.ToString(),
            before: new { row.Title }, ct: ct);

        return Results.Ok(new { deleted = true });
    }

    private static string? ValidateDesignation(SaveDesignationRequest req, out string title)
    {
        title = req.Title?.Trim() ?? "";
        if (title.Length is < 1 or > 100) return "A designation title is required (up to 100 characters).";
        if (Clean(req.Grade)?.Length > 20) return "The grade can be at most 20 characters.";
        if (req.Level is < 0 or > 100) return "Level must be between 0 and 100.";
        if (Clean(req.Description)?.Length > 500) return "The description can be at most 500 characters.";
        return null;
    }

    private static void ApplyDesignation(OrgDesignation row, SaveDesignationRequest req, string title)
    {
        row.Title = title;
        row.Grade = Clean(req.Grade);
        row.Level = req.Level;
        row.Description = Clean(req.Description);
        row.IsActive = req.IsActive ?? true;
    }

    private static Task<bool> DesignationTitleTakenAsync(
        AppDbContext db, string title, Guid? except, CancellationToken ct)
    {
        var key = title.ToLower();
        return db.OrgDesignations.AnyAsync(d => d.Title.Trim().ToLower() == key && d.Id != except, ct);
    }

    // ================================================================= shared

    /// <summary>Trimmed, and blank becomes NULL — so clearing a field clears it.</summary>
    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

/// <summary>
/// Full replacement on update: every field is sent every time, so clearing an
/// optional field back to empty is expressible.
/// </summary>
public sealed record SaveLocationRequest(
    string? Name,
    string? Code,
    string? AddressLine,
    string? City,
    string? State,
    string? PostalCode,
    string? Country,
    bool? IsRemote,
    bool? IsActive);

public sealed record SaveDesignationRequest(
    string? Title,
    string? Grade,
    int? Level,
    string? Description,
    bool? IsActive);
