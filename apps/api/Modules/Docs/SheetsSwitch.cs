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
}

/// <summary>
/// Which switch governs a live file. Documents and spreadsheets share every
/// route (DocsEndpoints) and the live channel (DocsLiveHub); each asks the
/// switch that belongs to the file's own type — so turning Docs off never
/// closes a spreadsheet, and turning Sheets off never closes a document.
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
        var g = app.MapGroup("/api/admin/organisations/{id:guid}/sheets")
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
        var row = await db.SheetsTenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == id, ct);
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

    private static Guid Actor(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
}
