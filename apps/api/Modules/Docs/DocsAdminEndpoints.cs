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

    /// <summary>
    /// FALSE UNTIL THE FILE IS BUILT ON THE SERVER (decision 0011 condition 1;
    /// design docs/DOCS_SERVER_RENDER_DESIGN.md). Amit, 29 Sept 2026: Docs
    /// stays off for EVERY organisation, Techvein included, until then — so
    /// production never holds a file a browser wrote. While false, the
    /// operator's switch refuses to turn Docs on (DocsAdminEndpoints). The
    /// render's own pull request sets it true, and nothing else should.
    /// </summary>
    public const bool ServerRenderLanded = false;

    public const string BeforeRenderMessage =
        "Docs cannot be switched on yet. Documents must first be built on the server "
        + "(decision 0011, condition 1); until then Docs stays off for every organisation.";
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
        HttpContext http, IHostEnvironment env, IConfiguration config, ILoggerFactory loggers, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        // Switching ON is refused until the render lands (DocsSwitch.
        // ServerRenderLanded). Switching OFF is never refused. Refused before
        // anything is written or scoped, and logged — a refused attempt is
        // somebody working against Amit's decision, or not knowing it.
        if (req.Enabled && RefuseSwitchOn(env, config))
        {
            loggers.CreateLogger("TatvaOS.Docs.Switch").LogWarning(
                "Docs switch-on REFUSED before the server render (Amit, 29 Sept 2026): organisation {OrganisationId}, operator {OperatorId}",
                id, Actor(http));
            return Results.Json(new { error = DocsSwitch.BeforeRenderMessage, reason = "docs_before_render" },
                statusCode: StatusCodes.Status409Conflict);
        }

        // No file a BROWSER wrote may go live (Mr. Singh, 30 Sept 2026, in
        // place of a backfill): refused while any of this organisation's
        // documents was saved before the server built the files. Counted by a
        // definer function, because documents are visible only to people who
        // can see their Space file, and the operator is not one of them — a
        // plain count here would read 0 and pass (20260930-b-...sql).
        if (req.Enabled)
        {
            var browserWritten = await db.Database
                .SqlQuery<long>($"SELECT docs.browser_written_count({id}) AS \"Value\"")
                .SingleAsync(ct);
            if (browserWritten > 0)
            {
                loggers.CreateLogger("TatvaOS.Docs.Switch").LogWarning(
                    "Docs switch-on REFUSED: organisation {OrganisationId} has {Count} document(s) a browser wrote before the server built the files; operator {OperatorId}",
                    id, browserWritten, Actor(http));
                return Results.Json(new
                {
                    error = $"Docs cannot be switched on for this organisation: {browserWritten} of its documents were saved by a browser before TatvaOS built document files on the server.",
                    reason = "browser_files",
                    count = browserWritten,
                }, statusCode: StatusCodes.Status409Conflict);
            }
        }

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

    /// <summary>
    /// Refused everywhere but a developer's machine, where tests/docs must
    /// switch Docs on to test it. Docs:RefuseSwitchOnInDevelopment can only
    /// ADD the refusal (tests/docs/docs-switch-before-render.test.mjs runs
    /// with it) — no setting takes it away in production; only the render's
    /// pull request, by setting ServerRenderLanded.
    /// </summary>
    private static bool RefuseSwitchOn(IHostEnvironment env, IConfiguration config) =>
        !DocsSwitch.ServerRenderLanded
        && (!env.IsDevelopment() || config.GetValue<bool>("Docs:RefuseSwitchOnInDevelopment"));

    private static Guid Actor(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
}
