using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>An organisation's public careers page. Table <c>hire.careers_sites</c>.</summary>
public sealed class HireCareersSite
{
    public Guid TenantId { get; set; }
    public string Slug { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? ErasureContact { get; set; }
    public bool IsEnabled { get; set; }
    public Guid? UpdatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// The public careers page — decision 0010 §1 (proposed), SWITCHED OFF.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE FIRST UNAUTHENTICATED READ OF HIRE DATA. What it may show is an
///  explicit projection in PublicJob / PublicListItem below — a field is
///  public only if it is written there. Never the hiring manager, recruiter,
///  department, internal ids, applicant counts, or the salary unless the job
///  says show_salary.
///
///  EVERY "NO" LOOKS THE SAME. Unknown site, site switched off, platform
///  switch off, organisation suspended, job a draft / on hold / closed /
///  past its closing date, job of another organisation: all 404 with the same
///  body. Nothing here tells a caller which of those it was.
///
///  TWO SWITCHES, both checked in hire.resolve_careers_site() in the
///  database: the organisation's own, and the platform's
///  'hire.careers_portal_enabled', which stays false until Mr. Singh has
///  ruled on 0010 and a lawyer has confirmed the retention period (Amit,
///  24 Sept 2026).
///
///  NO FORM YET. Applying is the next change (0010 §5–§7), with the consent
///  notice and bot protection; this one only shows jobs.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class CareersEndpoints
{
    private static readonly Regex SlugShape = new("^[a-z0-9](-?[a-z0-9])+$", RegexOptions.Compiled);

    public static void MapCareersEndpoints(this IEndpointRouteBuilder app)
    {
        // Administrators set the page up; nothing public happens here.
        app.MapGet("/api/hire/careers", GetSiteAsync).RequireAuthorization("User").WithTags("Hire");
        app.MapPut("/api/hire/careers", SaveSiteAsync).RequireAuthorization("User").WithTags("Hire");

        var pub = app.MapGroup("/api/public/careers")
            .AllowAnonymous()
            .RequireRateLimiting("careers-read")
            .WithTags("Hire (public)")
            // JSON is never a page to index, whatever the launch state. The
            // pages themselves carry noindex in app/careers/layout.tsx until
            // launch (Mr. Singh, 24 Sept 2026).
            .AddEndpointFilter(async (ctx, next) =>
            {
                ctx.HttpContext.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
                return await next(ctx);
            });
        pub.MapGet("/{site}", PublicListAsync);
        pub.MapGet("/{site}/jobs/{jobSlug}", PublicJobAsync);
    }

    // ============================================================== admin

    private static async Task<IResult> GetSiteAsync(
        HireAccess access, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) != HireLevel.Admin)
            return Results.Json(new { error = "Only an administrator can set up the careers page." }, statusCode: 403);

        var site = await access.CareersSiteAsync(ct);
        var platformOn = await PlatformOnAsync(db, ct);
        if (site is not null)
            return Results.Ok(new
            {
                saved = true, site.Slug, site.DisplayName, site.ErasureContact, site.IsEnabled,
                platformEnabled = platformOn, path = $"/careers/{site.Slug}",
            });

        // Suggestions only — nothing is saved until the administrator saves.
        var org = await db.Tenants.AsNoTracking().Where(t => t.Id == tenant.TenantId)
            .Select(t => t.Name).FirstOrDefaultAsync(ct) ?? "";
        var platformFqdn = await db.Domains.AsNoTracking().Where(d => d.IsPlatform)
            .Select(d => d.Fqdn).FirstOrDefaultAsync(ct);
        var owner = await db.Users.AsNoTracking()
            .Where(u => u.Role == "org_owner" && u.Status == "active")
            .OrderBy(u => u.CreatedAt).Select(u => u.Email).FirstOrDefaultAsync(ct);
        var suggested = platformFqdn?.Split('.')[0].ToLowerInvariant();
        return Results.Ok(new
        {
            saved = false,
            slug = suggested is not null && SlugShape.IsMatch(suggested) ? suggested : null,
            displayName = org,
            erasureContact = owner,
            isEnabled = false,
            platformEnabled = platformOn,
            path = (string?)null,
        });
    }

    private static async Task<IResult> SaveSiteAsync(
        SaveCareersSiteRequest req, HireAccess access, AuditWriter audit, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) != HireLevel.Admin)
            return Results.Json(new { error = "Only an administrator can set up the careers page." }, statusCode: 403);

        var slug = req.Slug?.Trim().ToLowerInvariant() ?? "";
        if (slug.Length is < 3 or > 40 || !SlugShape.IsMatch(slug))
            return Results.BadRequest(new
            {
                error = "The address must be 3 to 40 lower-case letters or digits, with single hyphens between them — such as techvein or abc-school.",
            });
        var name = req.DisplayName?.Trim() ?? "";
        if (name.Length is < 1 or > 120) return Results.BadRequest(new { error = "Give the name candidates will see (up to 120 characters)." });
        var contact = string.IsNullOrWhiteSpace(req.ErasureContact) ? null : req.ErasureContact.Trim().ToLowerInvariant();
        if (contact is not null && (contact.Length > 320 || !Regex.IsMatch(contact, @"^[^@\s]+@[^@\s]+\.[^@\s]+$")))
            return Results.BadRequest(new { error = "The contact must be an email address." });
        var enable = req.IsEnabled ?? false;
        if (enable && contact is null)
            return Results.BadRequest(new
            {
                error = "Name who answers candidates' requests to see or delete their data before switching the page on. It is shown on every job.",
            });

        var before = await access.CareersSiteAsync(ct);
        var beforeState = before is null ? null : new { before.Slug, before.IsEnabled };
        try
        {
            await access.SaveCareersSiteAsync(slug, name, contact, enable, ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            return Results.Conflict(new { error = $"The address {slug} is taken. Choose another." });
        }
        await audit.WriteAsync(
            before is null ? "careers_site.created" : "careers_site.updated", "careers_site", slug,
            before: beforeState, after: new { slug, isEnabled = enable }, ct: ct, productCode: "hire");
        return Results.Ok(new { slug, isEnabled = enable, path = $"/careers/{slug}" });
    }

    // ============================================================= public

    private static async Task<IResult> PublicListAsync(
        string site, AppDbContext db, TenantContext tenant, HireAccess access, CancellationToken ct)
    {
        var resolved = await ResolveAsync(site, db, tenant, ct);
        if (resolved is null) return NotFound();

        var today = JobOpeningEndpoints.Today();
        var jobs = await access.PublicJobs(today).AsNoTracking()
            .OrderByDescending(j => j.PublishedAt)
            .Select(j => new { j.Slug, j.Title, j.LocationId, j.EmploymentType, j.ClosingDate })
            .ToListAsync(ct);
        var locations = await LocationNamesAsync(db, jobs.Select(j => j.LocationId), ct);

        return Results.Ok(new
        {
            organisation = resolved.Value.DisplayName,
            jobs = jobs.Select(j => new PublicListItem(
                j.Slug!, j.Title, Name(locations, j.LocationId), j.EmploymentType, j.ClosingDate)),
        });
    }

    private static async Task<IResult> PublicJobAsync(
        string site, string jobSlug, AppDbContext db, TenantContext tenant, HireAccess access, CancellationToken ct)
    {
        var resolved = await ResolveAsync(site, db, tenant, ct);
        if (resolved is null) return NotFound();

        var key = jobSlug.ToLowerInvariant();
        var j = await access.PublicJobs(JobOpeningEndpoints.Today()).AsNoTracking()
            .FirstOrDefaultAsync(x => x.Slug == key, ct);
        if (j is null) return NotFound();
        var locations = await LocationNamesAsync(db, [j.LocationId], ct);

        return Results.Ok(new PublicJob(
            resolved.Value.DisplayName, j.Slug!, j.Title, Name(locations, j.LocationId), j.EmploymentType,
            j.ExperienceMinYears, j.ExperienceMaxYears, j.Qualification, j.Skills, j.Vacancies,
            j.Description, j.Responsibilities, j.Requirements, j.ClosingDate,
            j.ShowSalary && (j.SalaryMin is not null || j.SalaryMax is not null)
                ? new PublicSalary(j.SalaryMin, j.SalaryMax, j.SalaryCurrency, j.SalaryPeriod)
                : null,
            resolved.Value.ErasureContact,
            ApplyOpen: false));
    }

    /// <summary>
    /// Finds the organisation for a public slug through the SECURITY DEFINER
    /// resolver, then scopes the rest of the request to it — the
    /// OrgApiAuth pattern. Null for every kind of "no".
    /// </summary>
    private static async Task<(string DisplayName, string? ErasureContact)?> ResolveAsync(
        string site, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (site.Length is < 3 or > 40 || !SlugShape.IsMatch(site.ToLowerInvariant())) return null;

        Guid tenantId;
        string displayName;
        string? contact;
        var conn = db.Database.GetDbConnection();
        // Opened and closed here, as in OrgApiAuth: a raw open bypasses the
        // tenant interceptor, so EF must open its own once the scope is set.
        var openedHere = conn.State != System.Data.ConnectionState.Open;
        if (openedHere) await conn.OpenAsync(ct);
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT tenant_id, display_name, erasure_contact FROM hire.resolve_careers_site(@slug)";
            var p = cmd.CreateParameter(); p.ParameterName = "@slug"; p.Value = site.ToLowerInvariant(); cmd.Parameters.Add(p);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) return null;
            tenantId = reader.GetGuid(0);
            displayName = reader.GetString(1);
            contact = reader.IsDBNull(2) ? null : reader.GetString(2);
        }
        finally
        {
            if (openedHere) await conn.CloseAsync();
        }

        tenant.EnterAnonymousScope(tenantId, "careers_public");
        await db.SyncTenantAsync(ct);
        return (displayName, contact);
    }

    private static async Task<bool> PlatformOnAsync(AppDbContext db, CancellationToken ct) =>
        string.Equals(
            await db.PlatformSettings.AsNoTracking().Where(s => s.Key == "hire.careers_portal_enabled")
                .Select(s => s.Value).FirstOrDefaultAsync(ct),
            "true", StringComparison.OrdinalIgnoreCase);

    private static async Task<Dictionary<Guid, string>> LocationNamesAsync(
        AppDbContext db, IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        return await db.OrgLocations.AsNoTracking().Where(l => list.Contains(l.Id))
            .ToDictionaryAsync(l => l.Id, l => l.Name, ct);
    }

    private static string? Name(Dictionary<Guid, string> map, Guid? id) =>
        id is Guid g && map.TryGetValue(g, out var n) ? n : null;

    /// <summary>The same answer for every kind of "no".</summary>
    private static IResult NotFound() => Results.Json(new { error = "Not found." }, statusCode: 404);
}

public sealed record SaveCareersSiteRequest(string? Slug, string? DisplayName, string? ErasureContact, bool? IsEnabled);

// The public shapes. A field is public only if it is written here.
public sealed record PublicListItem(string Slug, string Title, string? Location, string EmploymentType, DateOnly? ClosingDate);
public sealed record PublicSalary(decimal? Min, decimal? Max, string Currency, string Period);
public sealed record PublicJob(
    string Organisation, string Slug, string Title, string? Location, string EmploymentType,
    short? ExperienceMinYears, short? ExperienceMaxYears, string? Qualification, string[] Skills, int Vacancies,
    string? Description, string? Responsibilities, string? Requirements, DateOnly? ClosingDate,
    PublicSalary? Salary, string? PrivacyContact, bool ApplyOpen);
