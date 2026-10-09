using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;
using static TatvaOS.Api.Modules.Migration.Calendar.GoogleEventMap;

namespace TatvaOS.Api.Modules.Migration.Calendar;

/// <summary>
/// Phase 3: one person's Google Calendar into the calendar module
/// ('google_workspace' / 'calendar').
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE MEETING, ONE OWNER. In Google a meeting is in every attendee's
///  calendar under one iCalUID; here it is one calendar.events row (unique
///  per organisation on uid) in its ORGANISER's calendar, and everyone else
///  is an attendee row, linked to their TatvaOS person. So, for each meeting
///  in this person's Google calendar (Amit's choice "A", 9 Oct 2026, for Mr.
///  Singh to confirm):
///
///   * they organised it          -> created in their primary calendar
///   * its organiser is in THIS organisation
///                                -> skipped: it arrives with the organiser's
///                                   calendar, with this person as an attendee
///   * its organiser is outside   -> created in this person's calendar, unless
///                                   another person's job already did; then
///                                   skipped, naming whose calendar it is in
///
///  The cost of the second rule, said plainly: a meeting organised by someone
///  in the organisation who is never migrated does not arrive. The skip
///  reason names the organiser, so the per-person progress shows why.
///
///  TWO PASSES, because Google does not promise to list a recurring event
///  before its changed occurrences: the cursor is "m:<token>" while reading
///  the events themselves, then "x:<token>" for the changed and cancelled
///  occurrences (calendar.event_exceptions), whose event is by then here.
///
///  SAFE TO REPEAT: an event whose uid is already here, and an exception
///  already recorded for its occurrence, are skipped.
///
///  NOT REGISTERED in Program.cs: like the other sources, it needs section 9's
///  IGoogleCredentialProvider.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleCalendarSource(
    GoogleCalendarClient google,
    IGoogleCredentialProvider credentials,
    IServiceScopeFactory scopes,
    IConfiguration config) : IMigrationSource
{
    public string Source => "google_workspace";
    public string DataType => "calendar";

    private int PageSize => Math.Clamp(config.GetValue("Migration:Calendar:PageSize", 250), 1, 2500);

    public sealed record Item(JsonElement Event, string Zone);

    public async Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        var account = await credentials.ForTenantAsync(job.TenantId, ct)
                      ?? throw new InvalidOperationException("this organisation has no Google service account on file");
        var exceptionsPass = job.Cursor?.StartsWith("x:") == true;
        var token = job.Cursor is { Length: > 2 } c ? c[2..] : null;

        // The exceptions pass needs cancelled occurrences, which only appear
        // with showDeleted; the events pass must NOT see deleted events.
        var page = await google.ListEventsAsync(account, job.SourceUser, token, exceptionsPass, PageSize, ct);
        var zone = page.TimeZone ?? "Asia/Kolkata";

        var items = page.Events
            .Where(e => exceptionsPass ? Str(e, "recurringEventId") is not null : Str(e, "recurringEventId") is null)
            .Where(e => exceptionsPass || Str(e, "status") != "cancelled")
            .Where(e => Str(e, "id") is not null)
            // No dedupe key: a recurring event and its exceptions share one
            // iCalUID, and the runner would take the exceptions for duplicates.
            .Select(e => new MigrationSourceItem(Str(e, "id")!, null, new Item(e, zone)))
            .ToList();

        if (page.NextPageToken is { } next)
            return new MigrationPage(items, (exceptionsPass ? "x:" : "m:") + next, IsLast: false);
        return exceptionsPass
            ? new MigrationPage(items, null, IsLast: true)
            : new MigrationPage(items, "x:", IsLast: false);   // events done; now their exceptions
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        var (e, zone) = (Item)item.Payload!;
        await using var scope = scopes.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantContext>().EnterAnonymousScope(job.TenantId, "system");
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.SyncTenantAsync(ct);

        return Str(e, "recurringEventId") is null
            ? await WriteEventAsync(db, job, e, zone, ct)
            : await WriteExceptionAsync(db, job, e, zone, ct);
    }

    private static string UidOf(JsonElement e) => Str(e, "iCalUID") ?? $"{Str(e, "id")}@google.com";

    private async Task<MigrationWriteResult> WriteEventAsync(
        AppDbContext db, MigrationJobView job, JsonElement e, string calendarZone, CancellationToken ct)
    {
        var uid = UidOf(e);
        if (await OwnerOfAsync(db, uid, ct) is { } owner)
            return MigrationWriteResult.Skipped(owner.UserId == job.TargetUserId
                ? "already migrated" : $"already in {owner.Email ?? "another person"}'s calendar");

        var organiser = e.TryGetProperty("organizer", out var o) ? o : default;
        var self = True(organiser, "self");
        if (!self && Str(organiser, "email") is { } orgEmail)
        {
            var inOrg = await PeopleAsync(db, [orgEmail], ct);
            if (inOrg.ContainsKey(orgEmail.Trim().ToLowerInvariant()))
                return MigrationWriteResult.Skipped($"organised by {orgEmail.Trim().ToLowerInvariant()}, in this organisation: it arrives with their calendar");
        }

        var zone = e.TryGetProperty("start", out var st) && Str(st, "timeZone") is { } z ? z : calendarZone;
        var start = ReadWhen(e, "start", zone);
        var end = ReadWhen(e, "end", zone);
        if (start is null || end is null) return MigrationWriteResult.Failed("the event has no readable start or end");
        var (rule, exDates, notCarried) = Recurrence(e, zone);
        if (rule is { Length: > 500 }) return MigrationWriteResult.Failed("its recurrence rule is longer than the calendar module keeps (500)");

        var calendarId = await CalendarProvisioning.EnsurePrimaryAsync(db, job.TenantId, job.TargetUserId, ct);
        var ev = new CalendarEvent
        {
            TenantId = job.TenantId,
            CalendarId = calendarId,
            Uid = uid,
            Sequence = e.TryGetProperty("sequence", out var sq) && sq.TryGetInt32(out var s) ? s : 0,
            CreatedByUserId = job.TargetUserId,
            OrganiserUserId = self ? job.TargetUserId : null,
            Title = Clip(Str(e, "summary"), 300) ?? "(No title)",
            Description = Str(e, "description"),
            Location = Clip(Str(e, "location"), 300),
            MeetingUrl = Clip(Str(e, "hangoutLink"), 500),
            StartsAt = start.At,
            EndsAt = end.At < start.At ? start.At : end.At,
            Timezone = Clip(zone, 64)!,
            IsAllDay = start.AllDay,
            RecurrenceRule = rule,
            Transparency = Str(e, "transparency") == "transparent" ? "transparent" : "opaque",
            Status = Status(Str(e, "status")),
            Visibility = Visibility(Str(e, "visibility")),
        };
        db.CalendarEvents.Add(ev);

        // Attendees, linked to their TatvaOS person where there is one.
        var attendees = e.TryGetProperty("attendees", out var a) && a.ValueKind == JsonValueKind.Array
            ? a.EnumerateArray().Where(x => Str(x, "email") is not null).ToList() : [];
        var people = await PeopleAsync(db, attendees.Select(x => Str(x, "email")!), ct);
        foreach (var x in attendees.DistinctBy(x => Str(x, "email")!.Trim().ToLowerInvariant()))
        {
            var email = Str(x, "email")!.Trim().ToLowerInvariant();
            db.CalendarAttendees.Add(new CalendarAttendee
            {
                EventId = ev.Id,
                UserId = people.TryGetValue(email, out var pid) ? pid : null,
                Email = email,
                DisplayName = Clip(Str(x, "displayName"), 200),
                Role = True(x, "organizer") ? "chair" : True(x, "optional") ? "opt-participant" : "req-participant",
                Status = AttendeeStatus(Str(x, "responseStatus")),
            });
        }

        foreach (var at in exDates.Distinct())
            db.CalendarEventExceptions.Add(new CalendarEventException { EventId = ev.Id, OccurrenceStartsAt = at, IsCancelled = true });

        // This person's own reminders. "useDefault" means the Google calendar's
        // default reminders, which this read does not see; not carried.
        if (e.TryGetProperty("reminders", out var r) && r.TryGetProperty("overrides", out var ov) && ov.ValueKind == JsonValueKind.Array)
            foreach (var x in ov.EnumerateArray()
                         .Select(x => (Method: ReminderMethod(Str(x, "method")),
                                       Minutes: x.TryGetProperty("minutes", out var m) && m.TryGetInt32(out var mi) ? mi : -1))
                         .Where(x => x.Minutes is >= 0 and <= 40320).Distinct())
                db.CalendarReminders.Add(new CalendarReminder
                    { EventId = ev.Id, UserId = job.TargetUserId, MinutesBefore = x.Minutes, Method = x.Method });

        await db.SaveChangesAsync(ct);
        return notCarried.Count == 0
            ? MigrationWriteResult.Done(0)
            : new MigrationWriteResult("done", 0, $"not carried: {string.Join(", ", notCarried.Distinct())}");
    }

    private async Task<MigrationWriteResult> WriteExceptionAsync(
        AppDbContext db, MigrationJobView job, JsonElement e, string calendarZone, CancellationToken ct)
    {
        var uid = UidOf(e);
        var master = await db.CalendarEvents.AsNoTracking().Where(x => x.Uid == uid)
            .Select(x => new { x.Id, x.Timezone, Owner = db.Calendars.Where(c => c.Id == x.CalendarId).Select(c => c.OwnerUserId).FirstOrDefault() })
            .FirstOrDefaultAsync(ct);
        if (master is null) return MigrationWriteResult.Skipped("its recurring event was not migrated");
        if (master.Owner != job.TargetUserId) return MigrationWriteResult.Skipped("its recurring event is in another person's calendar");

        var original = ReadWhen(e, "originalStartTime", master.Timezone);
        if (original is null) return MigrationWriteResult.Failed("the changed occurrence has no original start");
        if (await db.CalendarEventExceptions.AnyAsync(x => x.EventId == master.Id && x.OccurrenceStartsAt == original.At, ct))
            return MigrationWriteResult.Skipped("already migrated");

        var ex = new CalendarEventException { EventId = master.Id, OccurrenceStartsAt = original.At };
        if (Str(e, "status") == "cancelled") ex.IsCancelled = true;
        else
        {
            ex.StartsAt = ReadWhen(e, "start", master.Timezone)?.At;
            ex.EndsAt = ReadWhen(e, "end", master.Timezone)?.At;
            ex.Title = Clip(Str(e, "summary"), 300);
            ex.Location = Clip(Str(e, "location"), 300);
        }
        db.CalendarEventExceptions.Add(ex);
        await db.SaveChangesAsync(ct);
        return MigrationWriteResult.Done(0);
    }

    /// <summary>Whose calendar an event with this uid is in, if it is here at all.</summary>
    private static async Task<(Guid? UserId, string? Email)?> OwnerOfAsync(AppDbContext db, string uid, CancellationToken ct)
    {
        var hit = await (from ev in db.CalendarEvents.AsNoTracking()
                         where ev.Uid == uid
                         join c in db.Calendars.AsNoTracking() on ev.CalendarId equals c.Id
                         join u in db.Users.AsNoTracking() on c.OwnerUserId equals u.Id into us
                         from u in us.DefaultIfEmpty()
                         select new { c.OwnerUserId, Email = u == null ? null : u.Email }).FirstOrDefaultAsync(ct);
        return hit is null ? null : (hit.OwnerUserId, hit.Email);
    }

    /// <summary>
    /// Address -> TatvaOS person in THIS organisation: sign-in email, else the
    /// person's own mailbox. The same rule enrolment matches by.
    /// </summary>
    private static async Task<Dictionary<string, Guid>> PeopleAsync(AppDbContext db, IEnumerable<string> emails, CancellationToken ct)
    {
        var wanted = emails.Select(x => x.Trim().ToLowerInvariant()).Distinct().ToList();
        var found = new Dictionary<string, Guid>();
        if (wanted.Count == 0) return found;
        foreach (var u in await db.Users.AsNoTracking()
                     .Where(u => u.Status != "deleted" && wanted.Contains(u.Email.ToLower()))
                     .Select(u => new { u.Id, u.Email }).ToListAsync(ct))
            found.TryAdd(u.Email.ToLowerInvariant(), u.Id);
        foreach (var m in await db.Mailboxes.AsNoTracking()
                     .Where(m => m.Type == "user" && m.UserId != null && wanted.Contains(m.Address.ToLower()))
                     .Select(m => new { m.Address, m.UserId }).ToListAsync(ct))
            found.TryAdd(m.Address.ToLowerInvariant(), m.UserId!.Value);
        return found;
    }

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
