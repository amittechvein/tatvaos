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
