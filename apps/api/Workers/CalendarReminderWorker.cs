using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

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

    // ── WHY THIS ENTERS EACH ORGANISATION ──────────────────────────────────
    //
    //  From 16 Aug to 27 Sept 2026 this sweep read the calendar tables with no
    //  tenant set and IgnoreQueryFilters(). Those tables have FORCED row-level
    //  security, so with no tenant it saw no reminders at all, and "nothing
    //  due" is not an error: it sent nothing and said nothing, for six weeks.
    //  Production on 27 Sept: 7 reminders set, not one ever sent.
    //
    //  IgnoreQueryFilters() does not switch RLS off; nothing in the application
    //  can. The only cross-organisation question - who has reminders - goes to
    //  calendar.reminder_tenants(), a SECURITY DEFINER function returning ids
    //  only; everything else is read inside one organisation at a time, under
    //  RLS, the way ConnectNotesWorker does it. tests/calendar/test-reminders.sh
    //  runs this worker with a real reminder due in two organisations and
    //  fails unless the send is recorded AND the mail arrives.
    // ─────────────────────────────────────────────────────────────────────────
    private async Task SweepAsync(CancellationToken ct)
    {
        List<Guid> tenants;
        using (var scope0 = scopes.CreateScope())
        {
            var db0 = scope0.ServiceProvider.GetRequiredService<AppDbContext>();
            // AS "Value" is EF's required alias for a scalar SqlQuery.
            tenants = await db0.Database
                .SqlQuery<Guid>($"""SELECT tenant_id AS "Value" FROM calendar.reminder_tenants()""")
                .ToListAsync(ct);
        }

        foreach (var tenantId in tenants)
        {
            // One organisation's failure must not cost the others their reminders.
            try { await SweepOrganisationAsync(tenantId, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Calendar reminder sweep failed for organisation {TenantId}", tenantId);
            }
        }
    }

    private async Task SweepOrganisationAsync(Guid tenantId, CancellationToken ct)
    {
        // A FRESH SCOPE PER ORGANISATION, never one context switched between
        // them: its own AppDbContext and TenantContext (both scoped, Program.cs),
        // so nothing tracked for organisation A is in the change tracker while
        // B's sweep runs. Mr. Singh, 29 Sept 2026, reviewing this PR: the
        // two-organisation test proves today's emails go to the right people;
        // this makes it structural.
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        // Scope on the C# object, THEN push it into the database session on the
        // next line: RLS reads app.tenant_id, not the object (ConnectNotesWorker).
        tenant.EnterAnonymousScope(tenantId, "system");
        await db.SyncTenantAsync(ct);

        var now = DateTimeOffset.UtcNow;

        // It reads only what it needs to send — no bodies, no attendees.
        var reminders = await db.CalendarReminders.AsNoTracking().ToListAsync(ct);
        if (reminders.Count == 0) return;

        var eventIds = reminders.Select(r => r.EventId).Distinct().ToList();

        var events = await db.CalendarEvents.AsNoTracking()
            .Where(e => eventIds.Contains(e.Id) && e.DeletedAt == null && e.Status != "cancelled")
            .ToListAsync(ct);
        var eventById = events.ToDictionary(e => e.Id);

        var alreadySent = (await db.CalendarReminderSends.AsNoTracking()
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
            var email = await db.Users.AsNoTracking()
                .Where(u => u.Id == uid).Select(u => u.Email).FirstOrDefaultAsync(ct);
            if (email is not null) recipients.Add(email);
        }
        else
        {
            recipients = await db.CalendarAttendees.AsNoTracking()
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
