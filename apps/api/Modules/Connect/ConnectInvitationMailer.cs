using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Sends meeting invitations, and writes down what each send ANSWERED.
///
/// Modelled on CalendarInvitationMailer, with two deliberate differences:
///
///  • ONE MESSAGE PER PERSON. Calendar puts every attendee on one To line,
///    which is right inside an organisation. A Connect meeting routinely
///    invites people from three different companies, and one To line would
///    hand each of them the others' addresses. So each person gets their own
///    message, whose calendar file names only them.
///
///  • NO SENT COPY. Fifty invitations must not become fifty entries in the
///    host's Sent folder and fifty charges against their quota. The record is
///    connect.meeting_invitations, per person, with status and note.
///
/// Same rules as Calendar's on everything else: the SENDER is the signed-in
/// person's own mailbox (MailSender has no system-sender mode, and a calendar
/// invitation from no-reply@ is one people cannot reply to); a person without
/// a mailbox can still invite, the rows just say not_sent and why; nothing
/// here throws, because the meeting is already saved and must stay saved.
/// </summary>
public static class ConnectInvitationMailer
{
    public sealed record Outcome(int Sent, int Failed, string? Note);

    public static async Task<Outcome> SendAsync(
        ConnectMeeting meeting,
        IReadOnlyList<ConnectMeetingInvitation> targets,
        string method,
        AppDbContext db,
        TenantContext tenant,
        IConfiguration config,
        ILogger log,
        ContactAutoSave autoSave,
        AuditWriter audit,
        CancellationToken ct)
    {
        if (targets.Count == 0) return new Outcome(0, 0, null);
        if (tenant.UserId is not Guid uid) return new Outcome(0, 0, "No signed-in user to send as.");

        var sender = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == uid, ct);
        var box = await db.Mailboxes.FirstOrDefaultAsync(m => m.UserId == uid && m.Type == "user", ct);
        if (box is null || sender is null)
        {
            const string why = "You have no TatvaOS mailbox, so the invitation could not be emailed. Share the link instead.";
            foreach (var t in targets)
            {
                t.Status = ConnectInvitations.StatusNotSent;
                t.Note = why;
            }
            await db.SaveChangesAsync(ct);
            return new Outcome(0, 0, why);
        }

        var joinUrl = Endpoints.ConnectEndpoints.JoinUrlOf(meeting);
        var withCalendar = ConnectInvitations.HasCalendarTime(meeting);
        int sent = 0, failed = 0;
        string? lastError = null;

        foreach (var t in targets)
        {
            try
            {
                var sequence = ConnectInvitations.SequenceFor(meeting, t.SequenceSent);
                var ical = withCalendar
                    ? ConnectInvitations.BuildCalendar(meeting, joinUrl, t.Email, box.Address, sender.DisplayName, method, sequence)
                    : null;

                var submission = new MailSubmission(
                    To: [new MailboxAddress("", t.Email)],
                    Cc: [],
                    Subject: ConnectInvitations.Subject(meeting, method),
                    BodyText: ConnectInvitations.BodyText(meeting, joinUrl, sender.DisplayName, box.Address, method, meeting.AllowGuests),
                    BodyHtml: "",
                    Attachments: [],
                    ICalendar: ical,
                    ICalendarMethod: ical is null ? null : method,
                    FileSentCopy: false);

                var result = await MailSender.SubmitAsync(box, submission, db, tenant, config, log, autoSave, audit, ct);

                if (result.Outcome is SendOutcome.Sent or SendOutcome.SentButNotFiled)
                {
                    t.Status = ConnectInvitations.StatusSent;
                    t.Note = null;
                    t.SequenceSent = sequence;
                    t.LastSentAt = DateTimeOffset.UtcNow;
                    sent++;
                }
                else
                {
                    t.Status = ConnectInvitations.StatusFailed;
                    t.Note = result.Error ?? "The mail server did not accept it.";
                    lastError = t.Note;
                    failed++;
                    // Never the address in the log: it is somebody's personal data,
                    // and the row already holds it for anyone entitled to see it.
                    log.LogWarning("Meeting {Meeting}: invitation {Invitation} ({Method}) not sent: {Outcome} {Error}",
                        meeting.Id, t.Id, method, result.Outcome, result.Error);
                }
            }
            catch (Exception ex)
            {
                t.Status = ConnectInvitations.StatusFailed;
                t.Note = "Sending failed unexpectedly.";
                lastError = t.Note;
                failed++;
                log.LogError(ex, "Meeting {Meeting}: invitation {Invitation} ({Method}) threw", meeting.Id, t.Id, method);
            }
        }

        await db.SaveChangesAsync(ct);
        log.LogInformation("Meeting {Meeting}: {Method} invitations sent {Sent}, failed {Failed}",
            meeting.Id, method, sent, failed);

        return new Outcome(sent, failed, failed == 0 ? null
            : $"{failed} invitation{(failed == 1 ? "" : "s")} could not be sent: {lastError}");
    }

    /// <summary>
    /// After a saved change to a meeting people were already invited to: send
    /// the replacement (REQUEST) or the withdrawal (CANCEL) to everyone whose
    /// invitation actually went, at a higher SEQUENCE so their calendar
    /// replaces the old entry instead of ignoring the message as a duplicate.
    /// Best effort, like every send here: the meeting change stands either way.
    /// </summary>
    public static async Task<Outcome> ReissueAsync(
        ConnectMeeting meeting, string method, AppDbContext db, TenantContext tenant,
        IConfiguration config, ILogger log, ContactAutoSave autoSave, AuditWriter audit, CancellationToken ct)
    {
        var delivered = await db.Set<ConnectMeetingInvitation>()
            .Where(i => i.MeetingId == meeting.Id && i.Status == ConnectInvitations.StatusSent)
            .ToListAsync(ct);
        if (delivered.Count == 0) return new Outcome(0, 0, null);

        meeting.InviteSequence += 1;
        await db.SaveChangesAsync(ct);
        return await SendAsync(meeting, delivered, method, db, tenant, config, log, autoSave, audit, ct);
    }
}
