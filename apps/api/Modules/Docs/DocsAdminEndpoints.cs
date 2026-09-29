using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// Is Docs switched on for the CURRENT organisation? One implementation,
/// called by every Docs route and by the live channel's watcher.
/// No row = off (20260924-docs-schema.sql, docs.tenant_settings).
/// </summary>
public static class DocsSwitch
{
    public const string OffMessage = "Docs is not switched on for your organisation yet.";

    public static Task<bool> EnabledAsync(AppDbContext db, CancellationToken ct) =>
        db.DocsTenantSettings.AsNoTracking().AnyAsync(s => s.Enabled, ct);

    /// <summary>403 with reason "docs_off", which the web client shows as a sentence.</summary>
    public static IResult Off() =>
        Results.Json(new { error = OffMessage, reason = "docs_off" }, statusCode: StatusCodes.Status403Forbidden);
}

/// <summary>
/// The platform operator's switch for Docs, per organisation. Same shape as
/// ConnectInvitationCapEndpoints: under the SuperAdmin policy beside the rest
/// of /api/admin/organisations, platform scope for the one write, audited
/// every time. The organisation itself has no route here.
/// </summary>
public static class DocsAdminEndpoints
{
    public sealed record SwitchRequest(bool Enabled);

    public static void MapDocsAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations/{id:guid}/docs")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        g.MapGet("/", GetAsync);
        g.MapPut("/", PutAsync);
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();
        tenant.EnterPlatformScope(id, Actor(http));
        await db.SyncTenantAsync(ct);
        var row = await db.DocsTenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == id, ct);
        return Results.Ok(new { enabled = row?.Enabled ?? false, updatedAt = row?.UpdatedAt });
    }

    private static async Task<IResult> PutAsync(
        Guid id, SwitchRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        // Platform scope sets the tenant for this one operation; it does not
        // switch row-level security off (see OrganisationEndpoints).
        tenant.EnterPlatformScope(id, Actor(http));
        await db.SyncTenantAsync(ct);

        var row = await db.DocsTenantSettings.FirstOrDefaultAsync(s => s.TenantId == id, ct);
        var before = new { enabled = row?.Enabled ?? false };
        if (row is null)
        {
            row = new DocsTenantSetting { TenantId = id };
            db.DocsTenantSettings.Add(row);
        }
        row.Enabled = req.Enabled;
        row.UpdatedByUserId = Actor(http) is var a && a != Guid.Empty ? a : null;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Platform scope is allowed on condition that every use is audited.
        // Written even when nothing changed. Product code 'drive': a document
        // is a Space file, and Space's catalogue row is 'drive'.
        await audit.WriteAsync("docs.settings.enabled", "tenant", id.ToString(),
            before, new { enabled = req.Enabled }, ct, productCode: "drive");

        return Results.Ok(new { enabled = row.Enabled, updatedAt = row.UpdatedAt });
    }

    private static Guid Actor(HttpContext http) =>
        TatvaOS.Api.Shared.Auth.SignedIn.UserIdOrEmpty(http);
}
