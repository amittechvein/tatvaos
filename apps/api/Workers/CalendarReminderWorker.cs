using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Sends calendar reminders.
///
/// ─────────────────────────────────────────────────────────────────────────
///  POLLED, NOT TIMED. The obvious implementation schedules an in-memory
///  timer per reminder; it is also wrong. Timers die with the process, so a
///  deploy at 09:58 silently eats every 10:00 reminder, and nobody reports it
///  because a reminder that never arrives leaves no trace. This wakes every
///  minute, asks the database what is due, and records what it sent.
///
///  EVERY SEND IS RECORDED (calendar.reminder_sends, keyed by reminder AND
///  occurrence). Without that, a restart re-sends everything still inside the
///  window — and a reminder that arrives twice is how people learn to ignore
///  reminders.
///
///  It looks BACK as well as forward: a worker that was down for ten minutes
///  should still send the reminder it missed, late, rather than skip it. Late
///  is information; silence is not.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class CalendarReminderWorker(
    IServiceScopeFactory scopes,
    ILogger<CalendarReminderWorker> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromMinutes(1);

    /// <summary>
    /// How late a missed reminder may still be sent. Beyond this the event has
    /// usually started and the reminder is noise.
    /// </summary>
    private static readonly TimeSpan Grace = TimeSpan.FromMinutes(15);

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // A minute's grace on start so the database and migrations settle.
        try { await Task.Delay(TimeSpan.FromMinutes(1), stopping); }
        catch (OperationCanceledException) { return; }

        while (!stopping.IsCancellationRequested)
        {
            try { await SweepAsync(stopping); }
            catch (Exception ex)
            {
                // Never let one bad row stop the loop: the next tick retries,
                // and a crashed worker means no reminders at all.
                log.LogError(ex, "Calendar reminder sweep failed");
            }

            try { await Task.Delay(Tick, stopping); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();

        var now = DateTimeOffset.UtcNow;

        // The widest reminder we support is 4 weeks, so an occurrence can only
        // be due if it starts within that window.
        var horizon = now.AddDays(28);

        // Cross-tenant by necessity: this runs with no user, and reminders are
        // due regardless of who is signed in. It reads only what it needs to
        // send — no bodies, no attendees.
        var reminders = await db.CalendarReminders.AsNoTracking()
            .IgnoreQueryFilters()
            .ToListAsync(ct);
        if (reminders.Count == 0) return;

        var eventIds = reminders.Select(r => r.EventId).Distinct().ToList();

        var events = await db.CalendarEvents.AsNoTracking()
            .IgnoreQueryFilters()
            .Where(e => eventIds.Contains(e.Id) && e.DeletedAt == null && e.Status != "cancelled")
            .ToListAsync(ct);
        var eventById = events.ToDictionary(e => e.Id);

        var alreadySent = (await db.CalendarReminderSends.AsNoTracking()
            .IgnoreQueryFilters()
            .Where(s => s.SentAt > now.AddDays(-2))
            .ToListAsync(ct))
            .Select(s => (s.ReminderId, s.OccurrenceStartsAt))
            .ToHashSet();

        foreach (var reminder in reminders)
        {
            if (!eventById.TryGetValue(reminder.EventId, out var ev)) continue;

            var lead = TimeSpan.FromMinutes(reminder.MinutesBefore);

            // Occurrences whose reminder time falls in [now - grace, now].
            var windowStart = now + lead - Grace;
            var windowEnd = now + lead;

            foreach (var occ in Recurrence.Expand(
                         ev.StartsAt, ev.RecurrenceRule, ev.Timezone, windowStart, windowEnd))
            {
                if (alreadySent.Contains((reminder.Id, occ))) continue;

                // Recorded BEFORE sending. If the send throws we have marked a
                // reminder we did not deliver, which loses one reminder;
                // recording after would risk sending the same one every minute
                // until it succeeded, which is worse for everybody on the
                // event.
                db.CalendarReminderSends.Add(new CalendarReminderSend
                {
                    ReminderId = reminder.Id,
                    OccurrenceStartsAt = occ,
                });
                await db.SaveChangesAsync(ct);

                if (reminder.Method == "email")
                    await SendEmailAsync(db, mailer, ev, reminder, occ, ct);

                // 'notification' has nowhere to go until TatvaOS Notifications
                // exists. Recorded and logged rather than silently dropped, so
                // the count is visible when that product arrives.
                log.LogInformation(
                    "Calendar reminder {Method} for {Event} at {Occurrence}",
                    reminder.Method, ev.Title, occ);
            }
        }
    }

    private static async Task SendEmailAsync(
        AppDbContext db, SystemMailer mailer, CalendarEvent ev,
        CalendarReminder reminder, DateTimeOffset occ, CancellationToken ct)
    {
        // A per-user reminder goes to that person; a shared one goes to
        // everyone who accepted. Nobody who declined gets reminded about a
        // meeting they said no to.
        var recipients = new List<string>();

        if (reminder.UserId is Guid uid)
        {
            var email = await db.Users.AsNoTracking().IgnoreQueryFilters()
                .Where(u => u.Id == uid).Select(u => u.Email).FirstOrDefaultAsync(ct);
            if (email is not null) recipients.Add(email);
        }
        else
        {
            recipients = await db.CalendarAttendees.AsNoTracking().IgnoreQueryFilters()
                .Where(a => a.EventId == ev.Id && a.Status != "declined")
                .Select(a => a.Email)
                .ToListAsync(ct);
        }

        if (recipients.Count == 0) return;

        var when = TimeZoneInfo.ConvertTime(occ, SafeZone(ev.Timezone));
        var body = $"{ev.Title}\n{when:dddd d MMMM, h:mm tt}"
                 + (string.IsNullOrWhiteSpace(ev.Location) ? "" : $"\n{ev.Location}")
                 + (string.IsNullOrWhiteSpace(ev.MeetingUrl) ? "" : $"\n{ev.MeetingUrl}");

        foreach (var to in recipients.Distinct())
        {
            try { await mailer.SendAsync(to, $"Reminder: {ev.Title}", body, ct); }
            catch { /* one bad address must not stop the rest */ }
        }
    }

    private static TimeZoneInfo SafeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }
}
