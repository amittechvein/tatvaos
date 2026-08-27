using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// The §2 join: Calendar handing an invitation to Mail to carry.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS FILE IS THE SEAM THAT EXISTED ONLY IN DOCUMENTATION.
///
///  Until 27 August 2026, Imip.Build could produce a perfect VCALENDAR,
///  MailSender.SubmitAsync could carry one (ICalendar/ICalendarMethod have
///  been in MailSubmission since the carriage work), InvitationBody was
///  proven with 384 assertions — and NOTHING CALLED ACROSS. Calendar never
///  asked Mail to send. Mail found it by grepping for callers before running
///  a test Core wrote from intention rather than from the repo, which is the
///  failure class this platform has spent a week hunting in its own tools.
///
///  ─────────────────────────────────────────────────────────────────────────
///  AN INVITATION THAT CANNOT BE SENT MUST NOT UNSAVE THE EVENT.
///
///  The event is the customer's record; the email is its announcement. So
///  every path here returns an outcome instead of throwing, and callers save
///  the event FIRST and mail after. The one thing not tolerated is silence:
///  the outcome carries a human sentence for the response body, because "I
///  created it, did anyone get told?" is the first question a host asks.
///
///  WHO GETS MAIL: every attendee except the organiser — including
///  colleagues on this platform. Their copy arrives in their TatvaOS inbox
///  through the same pipeline as an outsider's arrives at Gmail, which means
///  one path to test instead of two, and the in-app response buttons stand
///  on top of mail rather than beside it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class CalendarInvitationMailer
{
    public sealed record Outcome(int Sent, string? Note);

    public static async Task<Outcome> SendAsync(
        CalendarEvent ev,
        string method,
        AppDbContext db,
        TenantContext tenant,
        IConfiguration config,
        ILogger log,
        TatvaOS.Api.Modules.Family.ContactAutoSave autoSave,
        TatvaOS.Api.Modules.Admin.AuditWriter audit,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid)
            return new Outcome(0, "No signed-in user to send as.");

        var organiser = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == uid, ct);

        // The organiser's PERSONAL mailbox is the sending identity. A user
        // without one (possible on this platform — mail is a product, not a
        // prerequisite) can hold meetings; they just cannot email invitations,
        // and the outcome says so in words rather than failing the event.
        var box = await db.Mailboxes
            .FirstOrDefaultAsync(m => m.UserId == uid && m.Type == "user", ct);
        if (box is null || organiser is null)
            return new Outcome(0,
                "You have no mailbox on this account, so invitations were not emailed. "
                + "Attendees on TatvaOS still see the event.");

        var attendees = await db.CalendarAttendees.AsNoTracking()
            .Where(a => a.EventId == ev.Id)
            .ToListAsync(ct);

        var recipients = attendees
            .Where(a => !string.Equals(a.Email, box.Address, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (recipients.Count == 0)
            return new Outcome(0, null);   // a meeting with yourself needs no post

        var ical = Imip.Build(ev, attendees, box.Address, organiser.DisplayName, method);

        // The HUMAN half of the alternative. Deliberately plain text and
        // deliberately bilingual-safe: no templating, just the facts in the
        // order a person scans them. Clients that understand text/calendar
        // never show this; clients that don't get something honest.
        //
        // CONVERTED to the event's zone BEFORE printing, and this line is here
        // because the first live send got it wrong: StartsAt is stored UTC,
        // and formatting it raw put "09:30 (Asia/Calcutta)" in the body of an
        // event whose card correctly read 15:00 — the UTC clock wearing an
        // IST label, which is worse than either alone because it looks
        // decided. Google's own render of the VCALENDAR was what caught it:
        // the 384-assertion suite proves bytes, and this bug lived in prose.
        TimeZoneInfo tzi;
        try { tzi = TimeZoneInfo.FindSystemTimeZoneById(ev.Timezone); }
        catch (TimeZoneNotFoundException) { tzi = TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { tzi = TimeZoneInfo.Utc; }
        var localStart = TimeZoneInfo.ConvertTime(ev.StartsAt, tzi);
        var localEnd = TimeZoneInfo.ConvertTime(ev.EndsAt, tzi);

        var when = ev.IsAllDay
            ? localStart.ToString("dd MMM yyyy")
            : $"{localStart:dd MMM yyyy, HH:mm}–{localEnd:HH:mm} ({ev.Timezone})";
        var text =
            (method == Imip.MethodCancel ? "Cancelled: " : "") + ev.Title + "\n"
            + "When: " + when + "\n"
            + (string.IsNullOrWhiteSpace(ev.Location) ? "" : "Where: " + ev.Location + "\n")
            + (string.IsNullOrWhiteSpace(ev.Description) ? "" : "\n" + ev.Description + "\n")
            + "\nOrganised by " + (organiser.DisplayName ?? box.Address);

        var submission = new MailSubmission(
            To: recipients.Select(r => new MailboxAddress(r.DisplayName ?? "", r.Email)).ToList(),
            Cc: [],
            Subject: (method == Imip.MethodCancel ? "Cancelled: " : "Invitation: ") + ev.Title,
            BodyText: text,
            BodyHtml: "",
            Attachments: [],
            ICalendar: ical,
            ICalendarMethod: method);

        try
        {
            var result = await MailSender.SubmitAsync(
                box, submission, db, tenant, config, log, autoSave, audit, ct);

            if (result.Outcome != SendOutcome.Sent)
            {
                log.LogWarning(
                    "Invitation mail for event {Event} was not sent: {Error}",
                    ev.Id, result.Error);
                return new Outcome(0,
                    "The event is saved, but the invitation email could not be sent: "
                    + (result.Error ?? "unknown reason"));
            }

            return new Outcome(recipients.Count, null);
        }
        catch (Exception ex)
        {
            // The event is already saved and must stay saved. This catch is
            // the guarantee; the log line is so the failure is a fact
            // somewhere instead of a shrug.
            log.LogError(ex, "Invitation mail for event {Event} threw", ev.Id);
            return new Outcome(0,
                "The event is saved, but sending the invitation email failed unexpectedly.");
        }
    }
}
