using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// Is Sheets switched on for the CURRENT organisation? Sheets' own switch,
/// independent of Docs' (Amit, 24 Sept 2026: a school may take one without
/// the other). No row = off (20260925-sheets-switch.sql).
/// </summary>
public static class SheetsSwitch
{
    public const string OffMessage = "Sheets is not switched on for your organisation yet.";

    public static Task<bool> EnabledAsync(AppDbContext db, CancellationToken ct) =>
        db.SheetsTenantSettings.AsNoTracking().AnyAsync(s => s.Enabled, ct);

    /// <summary>403 with reason "sheets_off", which the web client shows as a sentence.</summary>
    public static IResult Off() =>
        Results.Json(new { error = OffMessage, reason = "sheets_off" }, statusCode: StatusCodes.Status403Forbidden);

    /// <summary>
    /// FALSE UNTIL SHEETS' OWN FILE IS BUILT ON THE SERVER. Amit, 30 Sept
    /// 2026: Sheets refuses switch-on until the server builds its own .xlsx
    /// (decision 0011 condition 1, as for Docs; Mr. Singh: the same rules,
    /// with XlsxGuard on the server's own .xlsx). Today a spreadsheet's .xlsx
    /// is the one its browser wrote (DocsEndpoints.SheetCheckpointAsync), so
    /// production must never hold one. While false, the operator's switch
    /// refuses to turn Sheets on. The server build's own pull request sets it
    /// true, and nothing else should.
    /// </summary>
    public const bool ServerRenderLanded = false;

    public const string BeforeRenderMessage =
        "Sheets cannot be switched on yet. Spreadsheets must first be built on the server "
        + "(decision 0011, condition 1); until then Sheets stays off for every organisation.";
}

/// <summary>
/// Which switch governs a live file. Documents and spreadsheets share every
/// route (DocsEndpoints) and the live channel (DocsLiveHub); each asks the
/// switch that belongs to the file's own type — so turning Docs off never
/// closes a spreadsheet, and turning Sheets off never closes a document.
///
/// WHAT THIS DOES AND DOES NOT ENFORCE (Mr. Singh's review, 24 Sept 2026).
/// The switch is keyed on the file's type, so the type must be the server's:
/// only DocsEndpoints.CreateAsync sets a live type, Space refuses to
/// overwrite a live file, and every client- or sender-supplied type passes
/// through DocsFormat.ClientType, which strips the two live types. So the
/// switch consulted is always the one belonging to how the file was CREATED.
///
/// It does not decide which editor a browser runs on a file: the server
/// relays Yjs content without reading it (DocsLiveHub), so a hand-made client
/// with edit access to a document can store any content in it. Each editor
/// refuses the other kind's files (DocumentMeta.kind), which covers mistakes
/// and wrong links; it is not a control against a deliberate hand-made client,
/// and nothing short of parsing the content could be.
///
/// RULES, stated rather than left to side-effect:
///  1. Switching a product off withdraws its EDITOR, never the customer's
///     data. Space still lists and downloads the file (a spreadsheet as its
///     .xlsx). Checked by tests/sheets/sheets-live.e2e.ts every run.
///  2. Two switch tables (docs.tenant_settings, docs.sheets_tenant_settings)
///     is the limit. Before a THIRD product gets a switch, unify them — the
///     entitlement system, or one table with a product column — so product
///     gates cannot drift apart (Mr. Singh, 24 Sept 2026).
/// </summary>
public static class LiveSwitch
{
    public static bool IsSheet(string? mimeType) => mimeType == DocsFormat.SpreadsheetMimeType;

    public static Task<bool> EnabledAsync(AppDbContext db, string? mimeType, CancellationToken ct) =>
        IsSheet(mimeType) ? SheetsSwitch.EnabledAsync(db, ct) : DocsSwitch.EnabledAsync(db, ct);

    public static IResult Off(string? mimeType) =>
        IsSheet(mimeType) ? SheetsSwitch.Off() : DocsSwitch.Off();
}

/// <summary>
/// The platform operator's switch for Sheets, per organisation. A copy in
/// shape of DocsAdminEndpoints on purpose (same policy, same platform scope,
/// same audit on every write) so the two console switches behave alike.
/// </summary>
public static class SheetsAdminEndpoints
{
    public sealed record SwitchRequest(bool Enabled);

    public static void MapSheetsAdminEndpoints(this IEndpointRouteBuilder app)
    {
        // RequireOperator (PR 355): the operator policy AND the write
        // transaction, so the switch and its audit line commit together. This
        // route merged into main (PR 342) after 355 was written and still had
        // the old guard; 355's own CI caught it (the operator's switch-on was
        // refused: its audit line named nobody).
        var g = app.MapGroup("/api/admin/organisations/{id:guid}/sheets")
            .RequireOperator()
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
        var row = await db.SheetsTenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == id, ct);
        return Results.Ok(new { enabled = row?.Enabled ?? false, updatedAt = row?.UpdatedAt });
    }

    private static async Task<IResult> PutAsync(
        Guid id, SwitchRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, IHostEnvironment env, IConfiguration config, ILoggerFactory loggers, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        // Switching ON is refused until Sheets' server build lands
        // (SheetsSwitch.ServerRenderLanded). Switching OFF is never refused.
        // Refused before anything is written or scoped, and logged — a refused
        // attempt is somebody working against Amit's decision, or not knowing it.
        if (req.Enabled && RefuseSwitchOn(env, config))
        {
            loggers.CreateLogger("TatvaOS.Sheets.Switch").LogWarning(
                "Sheets switch-on REFUSED before the server build (Amit, 30 Sept 2026): organisation {OrganisationId}, operator {OperatorId}",
                id, Actor(http));
            return Results.Json(new { error = SheetsSwitch.BeforeRenderMessage, reason = "sheets_before_render" },
                statusCode: StatusCodes.Status409Conflict);
        }

        // Platform scope sets the tenant for this one operation; it does not
        // switch row-level security off (see OrganisationEndpoints).
        tenant.EnterPlatformScope(id, Actor(http));
        await db.SyncTenantAsync(ct);

        var row = await db.SheetsTenantSettings.FirstOrDefaultAsync(s => s.TenantId == id, ct);
        var before = new { enabled = row?.Enabled ?? false };
        if (row is null)
        {
            row = new SheetsTenantSetting { TenantId = id };
            db.SheetsTenantSettings.Add(row);
        }
        row.Enabled = req.Enabled;
        row.UpdatedByUserId = Actor(http) is var a && a != Guid.Empty ? a : null;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Audited even when nothing changed, as Docs' switch is. Product code
        // 'drive': a spreadsheet is a Space file, as a document is.
        await audit.WriteAsync("sheets.settings.enabled", "tenant", id.ToString(),
            before, new { enabled = req.Enabled }, ct, productCode: "drive");

        return Results.Ok(new { enabled = row.Enabled, updatedAt = row.UpdatedAt });
    }

    /// <summary>
    /// Refused everywhere but a developer's machine, where tests/sheets must
    /// switch Sheets on to test it. Sheets:RefuseSwitchOnInDevelopment can only
    /// ADD the refusal (tests/sheets/sheets-switch-production.test.mjs runs
    /// with it) — no setting takes it away in production; only the server
    /// build's pull request, by setting ServerRenderLanded. Same shape as
    /// Docs' (DocsAdminEndpoints.RefuseSwitchOn).
    /// </summary>
    private static bool RefuseSwitchOn(IHostEnvironment env, IConfiguration config) =>
        !SheetsSwitch.ServerRenderLanded
        && (!env.IsDevelopment() || config.GetValue<bool>("Sheets:RefuseSwitchOnInDevelopment"));

    // The operator, read as every operator route reads them (SignedIn, PR 355):
    // "sub" has been renamed by the JWT handler by the time an endpoint looks.
    private static Guid Actor(HttpContext http) =>
        TatvaOS.Api.Shared.Auth.SignedIn.UserIdOrEmpty(http);
}
