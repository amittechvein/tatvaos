using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// Invite people to a meeting by email (Amit, 17 Sept 2026: "Invite on the
/// meeting").
///
///   GET    /api/connect/meetings/{id}/invitations              who was invited, and did it go
///   POST   /api/connect/meetings/{id}/invitations              { emails: [...] } invite more
///   POST   /api/connect/meetings/{id}/invitations/{inv}/resend send one again
///   DELETE /api/connect/meetings/{id}/invitations/{inv}        withdraw one (CANCEL if it went)
///
/// Host and cohost only, the same people who can edit the meeting: an
/// invitation list is a list of other people's email addresses. Mapped from
/// ConnectEndpoints so no shared registry (Program.cs) changes.
/// </summary>
public static class ConnectInvitationEndpoints
{
    public sealed record InviteRequest(IReadOnlyList<string>? Emails);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/meetings/{id:guid}/invitations", ListAsync);
        g.MapPost("/meetings/{id:guid}/invitations", InviteAsync);
        g.MapPost("/meetings/{id:guid}/invitations/{invitationId:guid}/resend", ResendAsync);
        g.MapDelete("/meetings/{id:guid}/invitations/{invitationId:guid}", WithdrawAsync);
    }

    private static object ShapeOf(ConnectMeetingInvitation i, ConnectMeeting m) => new
    {
        i.Id,
        i.Email,
        i.Status,
        i.Note,
        i.CreatedAt,
        i.LastSentAt,
        // Sent, but before the meeting last moved: their calendar holds an old
        // time. The page says so rather than letting "sent" imply "current".
        outOfDate = i.Status == ConnectInvitations.StatusSent && (i.SequenceSent ?? -1) < m.InviteSequence,
    };

    private static async Task<(ConnectMeeting? meeting, IResult? refusal)> GuardAsync(
        AppDbContext db, TenantContext tenant, Guid id, bool mustBeOpen, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return (null, Results.Unauthorized());
        var meeting = await db.ConnectMeetings.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (meeting is null) return (null, Results.NotFound(new { error = "No such meeting." }));
        var role = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == id && p.UserId == uid)
            .Select(p => p.Role).FirstOrDefaultAsync(ct);
        if (role is not ("host" or "cohost"))
            return (null, Results.Json(new { error = "Only the host or a co-host can manage invitations." }, statusCode: 403));
        if (mustBeOpen && meeting.Status is "ended" or "cancelled")
            return (null, Results.Conflict(new { error = "That meeting is over." }));
        return (meeting, null);
    }

    private static async Task<List<ConnectMeetingInvitation>> AllOfAsync(AppDbContext db, Guid meetingId, CancellationToken ct) =>
        await db.Set<ConnectMeetingInvitation>()
            .Where(i => i.MeetingId == meetingId)
            .OrderBy(i => i.CreatedAt)
            .ToListAsync(ct);

    private static async Task<IResult> ListAsync(Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (meeting, refusal) = await GuardAsync(db, tenant, id, mustBeOpen: false, ct);
        if (refusal is not null) return refusal;
        var all = await AllOfAsync(db, id, ct);
        return Results.Ok(new { invitations = all.Select(i => ShapeOf(i, meeting!)) });
    }

    private static async Task<IResult> InviteAsync(
        Guid id, InviteRequest req, AppDbContext db, TenantContext tenant,
        IConfiguration config, ILoggerFactory logs, ContactAutoSave autoSave, AuditWriter audit,
        CancellationToken ct)
    {
        var (meeting, refusal) = await GuardAsync(db, tenant, id, mustBeOpen: true, ct);
        if (refusal is not null) return refusal;

        var parsed = ConnectInvitations.Parse(req.Emails);
        if (parsed.Valid.Count == 0)
            return Results.BadRequest(new
            {
                error = parsed.Invalid.Count > 0
                    ? "None of those look like email addresses."
                    : "Type at least one email address.",
                invalid = parsed.Invalid,
            });
        if (parsed.Valid.Count > ConnectInvitations.MaxPerRequest)
            return Results.BadRequest(new { error = $"Invite at most {ConnectInvitations.MaxPerRequest} people at a time." });

        var existing = await AllOfAsync(db, id, ct);
        var already = new HashSet<string>(existing.Select(e => e.Email.ToLowerInvariant()), StringComparer.Ordinal);
        var fresh = parsed.Valid.Where(e => !already.Contains(e)).ToList();
        var alreadyInvited = parsed.Valid.Where(already.Contains).ToList();

        if (existing.Count + fresh.Count > ConnectInvitations.MaxPerMeeting)
            return Results.BadRequest(new { error = $"A meeting can have at most {ConnectInvitations.MaxPerMeeting} email invitations." });

        var now = DateTimeOffset.UtcNow;
        var added = fresh.Select(email => new ConnectMeetingInvitation
        {
            Id = Guid.NewGuid(),
            TenantId = meeting!.TenantId,
            MeetingId = id,
            Email = email,
            InvitedByUserId = tenant.UserId,
            Status = ConnectInvitations.StatusPending,
            CreatedAt = now,
        }).ToList();

        ConnectInvitationMailer.Outcome outcome = new(0, 0, null);
        if (added.Count > 0)
        {
            db.Set<ConnectMeetingInvitation>().AddRange(added);
            // Saved BEFORE sending: a crash mid-send leaves 'pending' rows that
            // say exactly what happened, not addresses nobody recorded.
            await db.SaveChangesAsync(ct);
            outcome = await ConnectInvitationMailer.SendAsync(meeting!, added, Imip.MethodRequest,
                db, tenant, config, logs.CreateLogger("Connect.Invitations"), autoSave, audit, ct);
            // Counts only, never the addresses: the audit row outlives the meeting.
            await audit.WriteAsync("connect.meeting.invited", "connect.meeting", id.ToString(),
                after: new { invited = added.Count, outcome.Sent, outcome.Failed }, ct: ct, productCode: "connect");
        }

        var all = await AllOfAsync(db, id, ct);
        return Results.Ok(new
        {
            invitations = all.Select(i => ShapeOf(i, meeting!)),
            added = added.Count,
            sent = outcome.Sent,
            failed = outcome.Failed,
            alreadyInvited,
            invalid = parsed.Invalid,
            note = outcome.Note,
            // Said at the moment it matters: inviting outsiders to a meeting
            // that turns guests away sends them a link that will not let them in.
            warning = meeting!.AllowGuests ? null
                : "Guests are not allowed in this meeting, so people without a TatvaOS account in your organisation cannot join.",
        });
    }

    private static async Task<IResult> ResendAsync(
        Guid id, Guid invitationId, AppDbContext db, TenantContext tenant,
        IConfiguration config, ILoggerFactory logs, ContactAutoSave autoSave, AuditWriter audit,
        CancellationToken ct)
    {
        var (meeting, refusal) = await GuardAsync(db, tenant, id, mustBeOpen: true, ct);
        if (refusal is not null) return refusal;
        var inv = await db.Set<ConnectMeetingInvitation>()
            .FirstOrDefaultAsync(i => i.Id == invitationId && i.MeetingId == id, ct);
        if (inv is null) return Results.NotFound(new { error = "No such invitation." });

        var outcome = await ConnectInvitationMailer.SendAsync(meeting!, [inv], Imip.MethodRequest,
            db, tenant, config, logs.CreateLogger("Connect.Invitations"), autoSave, audit, ct);
        return Results.Ok(new { invitation = ShapeOf(inv, meeting!), sent = outcome.Sent, note = outcome.Note });
    }

    private static async Task<IResult> WithdrawAsync(
        Guid id, Guid invitationId, AppDbContext db, TenantContext tenant,
        IConfiguration config, ILoggerFactory logs, ContactAutoSave autoSave, AuditWriter audit,
        CancellationToken ct)
    {
        var (meeting, refusal) = await GuardAsync(db, tenant, id, mustBeOpen: false, ct);
        if (refusal is not null) return refusal;
        var inv = await db.Set<ConnectMeetingInvitation>()
            .FirstOrDefaultAsync(i => i.Id == invitationId && i.MeetingId == id, ct);
        if (inv is null) return Results.NotFound(new { error = "No such invitation." });

        string? note = null;
        // Only a delivered invitation left something in a calendar to take back.
        if (inv.Status == ConnectInvitations.StatusSent && meeting!.Status is not ("ended" or "cancelled"))
        {
            meeting.InviteSequence += 1;
            await db.SaveChangesAsync(ct);
            var outcome = await ConnectInvitationMailer.SendAsync(meeting, [inv], Imip.MethodCancel,
                db, tenant, config, logs.CreateLogger("Connect.Invitations"), autoSave, audit, ct);
            note = outcome.Note;
        }

        db.Set<ConnectMeetingInvitation>().Remove(inv);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("connect.meeting.invitation_withdrawn", "connect.meeting", id.ToString(),
            ct: ct, productCode: "connect");
        return Results.Ok(new { note });
    }
}
