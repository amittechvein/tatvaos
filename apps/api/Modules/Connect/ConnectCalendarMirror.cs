using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// A scheduled Connect meeting, as a row on its host's calendar.
///
/// ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
///
///  Amit, 18 September 2026, asking for a meetings API for a school's ERP:
///  "make sure schedule meeting visible on calendar". Reading the code to
///  find where that already happened found that it never had.
///
///  Until now the ONLY way a Connect meeting reached any calendar was the
///  emailed iMIP invitation (ConnectInvitations). That puts the meeting in
///  the RECIPIENT's calendar — Gmail's, Outlook's, or a TatvaOS calendar via
///  the mail seam. The person who scheduled it got nothing, because nobody
///  emails themselves an invitation. A teacher scheduling Monday's class saw
///  it in Connect's own list and on no calendar at all, and TatvaOS Calendar
///  never read connect.meetings (it still does not — that would have been the
///  other way to do this, and it is the wrong one: see below).
///
///  Verified rather than assumed, 18 Sept 2026: nothing in apps/api inserted
///  a CalendarEvent except CalendarEndpoints itself, and Calendar's module
///  contains no reference to ConnectMeeting.
///
/// ── WHY A ROW, AND NOT A JOIN IN THE CALENDAR QUERY ──────────────────────
///
///  Calendar could have unioned connect.meetings into its list query. That
///  needs no writes and cannot drift. It was rejected because everything a
///  calendar event can already do would then have to be special-cased for a
///  second kind of thing that is not one: reminders (CalendarReminderWorker
///  reads events), iMIP replies, free/busy, sharing, the exception table, and
///  every future feature. A row is the shape the rest of Calendar already
///  understands, so a meeting gets all of it for free.
///
///  The cost of a row is that it can drift from the meeting. That is paid by
///  keying on the meeting's own UID and upserting from the one place a
///  meeting changes, never by inserting a second row.
///
/// ── THE UID IS SHARED WITH THE INVITATION, ON PURPOSE ────────────────────
///
///  ConnectInvitations.Uid(meetingId) is what the emailed VCALENDAR carries.
///  This row uses THE SAME UID. If the host ever also receives an invitation
///  for their own meeting, a calendar matching on UID updates this row rather
///  than drawing a second event beside it. Giving the row its own UID would
///  guarantee the duplicate.
///
/// ── FAILURE IS NEVER THE CALLER'S PROBLEM ────────────────────────────────
///
///  A meeting that exists with no calendar row is a meeting you can still
///  join. A 500 from creating a meeting because a calendar write failed is a
///  meeting that does not exist. So every method here is called INSIDE the
///  meeting's own transaction for consistency, but the callers treat a
///  mirror failure as a logged warning, not a refusal.
/// </summary>
public static class ConnectCalendarMirror
{
    /// <summary>
    /// What the calendar entry says it is. Deliberately not the meeting's
    /// description: the row is the meeting, and a person opening it wants the
    /// join link, which is MeetingUrl.
    /// </summary>
    private const string Description =
        "A TatvaOS Connect meeting. Open the link at the time of the meeting to join.";

    /// <summary>
    /// Put the meeting on its host's calendar, or bring the existing row into
    /// line with it. Returns the event id, or null when there is nothing to
    /// show — an instant meeting has no time and belongs on no calendar.
    ///
    /// Idempotent by UID: called again for the same meeting it updates, and
    /// two racing calls cannot make two rows because both look the row up by
    /// a UID derived from the meeting id.
    /// </summary>
    public static async Task<Guid?> UpsertAsync(
        AppDbContext db, ConnectMeeting meeting, Guid hostUserId, string joinUrl, CancellationToken ct)
    {
        if (!ConnectInvitations.HasCalendarTime(meeting)) return null;

        var uid = ConnectInvitations.Uid(meeting.Id);
        var existing = await db.CalendarEvents
            .FirstOrDefaultAsync(e => e.Uid == uid && e.DeletedAt == null, ct);

        var title = string.IsNullOrWhiteSpace(meeting.Title) ? "Meeting" : meeting.Title;
        var starts = meeting.ScheduledStart!.Value;
        var ends = ConnectInvitations.EndOf(meeting);
        var zone = string.IsNullOrWhiteSpace(meeting.Timezone) ? "Asia/Kolkata" : meeting.Timezone;

        if (existing is not null)
        {
            // Rescheduled, renamed, or moved to another zone: the SAME row
            // changes. Never a second one — a class that had its time changed
            // twice would otherwise sit on the calendar three times.
            //
            // Status is set back to confirmed because this branch is only
            // reached for a row that is not deleted, and cancellation deletes
            // (see CancelAsync). It costs nothing and means no row can be
            // left saying 'cancelled' while the meeting is on.
            existing.Title = title;
            existing.StartsAt = starts;
            existing.EndsAt = ends;
            existing.Timezone = zone;
            existing.MeetingUrl = joinUrl;
            existing.Status = "confirmed";
            existing.Sequence = meeting.InviteSequence;
            existing.UpdatedAt = DateTimeOffset.UtcNow;
            return existing.Id;
        }

        // Belt and braces: every creation path now makes a calendar
        // (CalendarProvisioning), and this still copes with a person made
        // before that was true.
        var calendarId = await CalendarProvisioning.EnsurePrimaryAsync(db, meeting.TenantId, hostUserId, ct);

        var ev = new CalendarEvent
        {
            TenantId = meeting.TenantId,
            CalendarId = calendarId,
            Uid = uid,
            Sequence = meeting.InviteSequence,
            CreatedByUserId = hostUserId,
            OrganiserUserId = hostUserId,
            Title = title,
            Description = Description,
            MeetingUrl = joinUrl,
            StartsAt = starts,
            EndsAt = ends,
            Timezone = zone,
            Status = "confirmed",
            Transparency = "opaque",
        };
        db.CalendarEvents.Add(ev);
        return ev.Id;
    }

    /// <summary>
    /// Take the meeting off the calendar when it is cancelled.
    ///
    /// DeletedAt, not Status alone: the calendar's own list query filters on
    /// DeletedAt and shows every status, so a row left at status 'cancelled'
    /// would still be drawn — a cancelled class still sitting on forty
    /// students' Monday.
    /// </summary>
    public static async Task CancelAsync(AppDbContext db, Guid meetingId, CancellationToken ct)
    {
        var uid = ConnectInvitations.Uid(meetingId);
        var now = DateTimeOffset.UtcNow;
        await db.CalendarEvents
            .Where(e => e.Uid == uid && e.DeletedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(e => e.Status, "cancelled")
                .SetProperty(e => e.DeletedAt, now)
                .SetProperty(e => e.UpdatedAt, now), ct);
    }

}
