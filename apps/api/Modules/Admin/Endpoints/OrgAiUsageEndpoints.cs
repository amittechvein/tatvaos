using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The operator's view of one organisation's AI use this month — the same
/// summary the organisation sees (AiUsageReport), read in platform scope.
/// Read-only: the limits themselves are platform settings (ai.* keys),
/// changed on the Settings page and audited there.
/// </summary>
public static class OrgAiUsageEndpoints
{
    public static void MapOrgAiUsageEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/organisations/{id:guid}/ai-usage", GetAsync)
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        // The operator's AI-credit exception for one organisation (26 Sept 2026).
        app.MapPut("/api/admin/organisations/{id:guid}/ai-credits", PutCreditsAsync)
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        // Its own read, beside ai-usage rather than inside it: ai-usage's shape
        // is read by the metering test and the console, and stays as it was.
        app.MapGet("/api/admin/organisations/{id:guid}/ai-credits", GetCreditsAsync)
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
    }

    private static async Task<IResult> GetCreditsAsync(
        Guid id, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var over = await db.Tenants.AsNoTracking().Where(t => t.Id == id)
            .Select(t => new { t.AiCreditsOverride }).FirstOrDefaultAsync(ct);
        if (over is null) return Results.NotFound();
        var actor = Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);
        return Results.Ok(new { credits = await AiUsageReport.CreditsAsync(db, id, ct), @override = over.AiCreditsOverride });
    }

    /// <summary>Override: a number = exactly that many credits a month; null = follow the plan.</summary>
    public sealed record CreditsRequest(int? Override);

    private static async Task<IResult> PutCreditsAsync(
        Guid id, CreditsRequest req, AppDbContext db, TenantContext tenant, HttpContext http,
        TatvaOS.Api.Modules.Admin.AuditWriter audit, CancellationToken ct)
    {
        if (req.Override is < 0)
            return Results.BadRequest(new { error = "Credits cannot be negative. Empty follows the plan; 0 allows none." });
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();
        var before = org.AiCreditsOverride;
        if (before == req.Override) return Results.Ok(new { @override = before });

        org.AiCreditsOverride = req.Override;
        await db.SaveChangesAsync(ct);

        // Audited into the CUSTOMER's own log: an exception to what their plan
        // gives them is something their administrators may ask about.
        var actor = Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("org.ai.credits_override", "core.tenant", id.ToString(),
            before: new { @override = before }, after: new { @override = req.Override }, ct: ct);
        return Results.Ok(new { @override = req.Override });
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, TenantContext tenant, SettingsReader settings, HttpContext http,
        CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        // Platform scope sets the tenant for this one read; RLS still applies.
        // A read, so nothing to audit (the same stance as the other GETs here).
        var actor = Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);

        return Results.Ok(await AiUsageReport.ThisMonthAsync(db, settings, ct));
    }
}
