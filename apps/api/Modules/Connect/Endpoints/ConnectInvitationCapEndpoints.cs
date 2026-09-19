using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// The platform operator's dial on how many people one organisation may invite
/// to a meeting by email.
///
/// Amit, 19 Sept 2026: "Give option to change capping organization wise", and
/// on who turns it: "yes me" - the operator, not the organisation. The caps are
/// the only guard on outbound invitation mail, so the organisation's own
/// administrator has no route here: both routes sit under the SuperAdmin
/// policy, beside the rest of /api/admin/organisations, and
/// ConnectShareEndpoints.PutSettingsAsync - the organisation's route to the
/// same table - never touches these two columns.
///
/// It lives in Connect's folder although the URL is the operator console's,
/// because the numbers, their defaults and their ceiling are Connect's
/// (ConnectInvitations). OrganisationEndpoints is untouched.
///
/// An empty number means "the platform default", stored as NULL, so raising
/// the default later reaches every organisation that was never given its own.
/// </summary>
public static class ConnectInvitationCapEndpoints
{
    public sealed record CapRequest(int? PerRequest, int? PerMeeting);

    public static void MapConnectInvitationCapEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations/{id:guid}/connect-invitation-caps")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        g.MapGet("/", GetAsync);
        g.MapPut("/", PutAsync);
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        // Platform scope sets the tenant for this one operation; it does not
        // switch row-level security off (see OrganisationEndpoints).
        tenant.EnterPlatformScope(id, Actor(http));
        await db.SyncTenantAsync(ct);

        var row = await db.Set<ConnectTenantSettings>().AsNoTracking()
            .FirstOrDefaultAsync(s => s.TenantId == id, ct);
        return Results.Ok(Shape(row));
    }

    private static async Task<IResult> PutAsync(
        Guid id, CapRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        if (ConnectInvitations.CapProblem(req.PerRequest, req.PerMeeting) is string problem)
            return Results.BadRequest(new { error = problem });

        tenant.EnterPlatformScope(id, Actor(http));
        await db.SyncTenantAsync(ct);

        var row = await db.Set<ConnectTenantSettings>().FirstOrDefaultAsync(s => s.TenantId == id, ct);
        var before = new { perRequest = row?.InviteMaxPerRequest, perMeeting = row?.InviteMaxPerMeeting };

        if (row is null)
        {
            // A missing row means every Connect setting is at its default, and
            // the row made here keeps it so: public recording links stay OFF.
            row = new ConnectTenantSettings { TenantId = id };
            db.Add(row);
        }
        row.InviteMaxPerRequest = req.PerRequest;
        row.InviteMaxPerMeeting = req.PerMeeting;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Platform scope is allowed on condition that every use is audited
        // (TenantContext.EnterPlatformScope). Written even when nothing changed.
        await audit.WriteAsync("connect.settings.invitation_caps", "tenant", id.ToString(),
            before, new { perRequest = req.PerRequest, perMeeting = req.PerMeeting }, ct, productCode: "connect");

        return Results.Ok(Shape(row));
    }

    /// <summary>What is stored (null = default), what therefore applies, and the
    /// defaults and ceiling so the console never hard-codes a second copy.</summary>
    private static object Shape(ConnectTenantSettings? row)
    {
        var caps = ConnectInvitations.EffectiveCaps(row?.InviteMaxPerRequest, row?.InviteMaxPerMeeting);
        return new
        {
            perRequest = row?.InviteMaxPerRequest,
            perMeeting = row?.InviteMaxPerMeeting,
            effectivePerRequest = caps.PerRequest,
            effectivePerMeeting = caps.PerMeeting,
            defaultPerRequest = ConnectInvitations.MaxPerRequest,
            defaultPerMeeting = ConnectInvitations.MaxPerMeeting,
            ceiling = ConnectInvitations.CapCeiling,
        };
    }

    private static Guid Actor(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var uid) ? uid : Guid.Empty;
}
