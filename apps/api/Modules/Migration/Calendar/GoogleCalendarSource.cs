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
///  THREE PASSES. "m:<token>" reads the events themselves; "s:<token>" is the
///  SWEEP (decision 0019 §3, proposed): a meeting skipped in "m" because its
///  organiser is in this organisation is created here after all if that
///  organiser's calendar is not being migrated - never while their calendar
///  job is queued or running (the page waits and is retried), so the
///  organiser keeps it whenever they are being migrated; then "x:<token>"
///  for the changed and cancelled occurrences (calendar.event_exceptions),
///  LAST, because Google does not promise to list a recurring event before
///  its occurrences, and so a swept meeting's occurrences find it here.
///
///  SAFE TO REPEAT: an event whose uid is already here, and an exception
///  already recorded for its occurrence, are skipped.
///
///  EVERY CALENDAR THE PERSON OWNS, main one first: the cursor is
///  "<n>/<pass>:<token>" for the n-th (no "<n>/" = the main one). An extra
///  calendar becomes a personal calendar of the same name here; the sweep
///  runs on the main calendar only, where other people's meetings are.
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

    /// <param name="CalendarName">Null for the main calendar; else the person's own extra calendar's name.</param>
    public sealed record Item(JsonElement Event, string Zone, bool Sweep = false, string? CalendarName = null);

    public async Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        var account = await credentials.ForTenantAsync(job.TenantId, ct)
                      ?? throw new InvalidOperationException("this organisation has no Google service account on file");
        // "<n>/<pass>:<token>": the person's n-th OWNED calendar, main one
        // first. A cursor with no "<n>/" is the main calendar (n = 0).
        var cursor = job.Cursor;
        var calIndex = 0;
        if (cursor is not null && cursor.IndexOf('/') is var slash and > 0 && int.TryParse(cursor[..slash], out var n))
            (calIndex, cursor) = (n, cursor[(slash + 1)..]);
        var calendars = await google.OwnedCalendarsAsync(account, job.SourceUser, ct);
        if (calIndex >= calendars.Count) return new MigrationPage([], job.Cursor, IsLast: true);
        var cal = calendars[calIndex];
        var main = calIndex == 0;
        string Next(int i, string rest) => i == 0 ? rest : $"{i}/{rest}";

        var pass = cursor is { Length: >= 2 } c0 && c0[1] == ':' ? c0[0] : 'm';
        var token = cursor is { Length: > 2 } c ? c[2..] : null;
        var exceptionsPass = pass == 'x';

        // The exceptions pass needs cancelled occurrences, which only appear
        // with showDeleted; the events and sweep passes must NOT see deleted events.
        var page = await google.ListEventsAsync(account, job.SourceUser, main ? "primary" : cal.Id, token, exceptionsPass, PageSize, ct);
        var zone = page.TimeZone ?? "Asia/Kolkata";

        var items = page.Events
            .Where(e => exceptionsPass ? Str(e, "recurringEventId") is not null : Str(e, "recurringEventId") is null)
            .Where(e => exceptionsPass || Str(e, "status") != "cancelled")
            .Where(e => Str(e, "id") is not null)
            // The sweep looks only at meetings someone else organised.
            .Where(e => pass != 's' || (!True(e.TryGetProperty("organizer", out var o) ? o : default, "self")
                                        && e.TryGetProperty("organizer", out var o2) && Str(o2, "email") is not null))
            // No dedupe key: a recurring event and its exceptions share one
            // iCalUID, and the runner would take the exceptions for duplicates.
            // Sweep items carry their own source id: the ledger already holds
            // the "m" pass's skip for the same event and would drop them.
            .Select(e => new MigrationSourceItem(
                (pass == 's' ? "sweep:" : "") + (main ? "" : $"{cal.Id}/") + Str(e, "id")!, null,
                new Item(e, zone, pass == 's', main ? null : cal.Name)))
            .ToList();

        if (page.NextPageToken is { } next)
            return new MigrationPage(items, Next(calIndex, $"{pass}:{next}"), IsLast: false);
        return pass switch
        {
            // The sweep is for meetings others organised: the main calendar's.
            'm' => new MigrationPage(items, Next(calIndex, main ? "s:" : "x:"), IsLast: false),
            's' => new MigrationPage(items, Next(calIndex, "x:"), IsLast: false),
            _ when calIndex + 1 < calendars.Count => new MigrationPage(items, Next(calIndex + 1, "m:"), IsLast: false),
            _ => new MigrationPage(items, null, IsLast: true),
        };
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        var (e, zone, _, calendarName) = (Item)item.Payload!;
        await using var scope = scopes.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantContext>().EnterAnonymousScope(job.TenantId, "system");
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.SyncTenantAsync(ct);

        var it = (Item)item.Payload!;
        if (it.Sweep) return await SweepAsync(db, job, e, zone, ct);
        return Str(e, "recurringEventId") is null
            ? await WriteEventAsync(db, job, e, zone, calendarName, ct)
            : await WriteExceptionAsync(db, job, e, zone, ct);
    }

    private static string UidOf(JsonElement e) => Str(e, "iCalUID") ?? $"{Str(e, "id")}@google.com";

    private async Task<MigrationWriteResult> WriteEventAsync(
        AppDbContext db, MigrationJobView job, JsonElement e, string calendarZone, string? calendarName, CancellationToken ct)
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
        return await CreateEventAsync(db, job, e, calendarZone, self, calendarName, ct);
    }

    /// <summary>
    /// The sweep: a meeting organised by someone in this organisation, still
    /// not here once the "m" pass is done. Created in this attendee's
    /// calendar unless the organiser's own calendar job is queued or running
    /// - then the page fails on purpose and the runner retries it later, so
    /// the organiser keeps their meeting whenever their calendar is moving.
    /// </summary>
    private async Task<MigrationWriteResult> SweepAsync(
        AppDbContext db, MigrationJobView job, JsonElement e, string calendarZone, CancellationToken ct)
    {
        var uid = UidOf(e);
        if (await OwnerOfAsync(db, uid, ct) is { } owner)
            return MigrationWriteResult.Skipped(owner.UserId == job.TargetUserId
                ? "already migrated" : $"arrived with {owner.Email ?? "another person"}'s calendar");

        var orgEmail = Str(e.GetProperty("organizer"), "email")!.Trim().ToLowerInvariant();
        var organiserId = (await PeopleAsync(db, [orgEmail], ct)).TryGetValue(orgEmail, out var id) ? id : (Guid?)null;
        if (organiserId is Guid oid)
        {
            var moving = await db.MigrationJobs.AsNoTracking().AnyAsync(j =>
                j.Source == "google_workspace" && j.DataType == "calendar" && j.TargetUserId == oid
                && (j.State == "pending" || j.State == "running"), ct);
            if (moving)
                throw new InvalidOperationException($"waiting for {orgEmail}'s calendar to finish before placing their meetings with attendees");
        }

        var created = await CreateEventAsync(db, job, e, calendarZone, self: false, calendarName: null, ct);
        return created.Outcome != "done" ? created
            : new MigrationWriteResult("done", 0,
                $"organised by {orgEmail}, whose calendar is not being migrated: placed with this attendee");
    }

    private async Task<MigrationWriteResult> CreateEventAsync(
        AppDbContext db, MigrationJobView job, JsonElement e, string calendarZone, bool self, string? calendarName, CancellationToken ct)
    {
        var uid = UidOf(e);

        var zone = e.TryGetProperty("start", out var st) && Str(st, "timeZone") is { } z ? z : calendarZone;
        var start = ReadWhen(e, "start", zone);
        var end = ReadWhen(e, "end", zone);
        if (start is null || end is null) return MigrationWriteResult.Failed("the event has no readable start or end");
        var (rule, exDates, notCarried) = Recurrence(e, zone);
        if (rule is { Length: > 500 }) return MigrationWriteResult.Failed("its recurrence rule is longer than the calendar module keeps (500)");

        var calendarId = calendarName is null
            ? await CalendarProvisioning.EnsurePrimaryAsync(db, job.TenantId, job.TargetUserId, ct)
            : await OwnCalendarAsync(db, job, calendarName, zone, ct);
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

    /// <summary>
    /// The person's own extra calendar of this name, made the first time: a
    /// personal calendar, theirs, not their primary. Found by name, so two
    /// Google calendars with one name become one here.
    /// </summary>
    private static async Task<Guid> OwnCalendarAsync(AppDbContext db, MigrationJobView job, string name, string zone, CancellationToken ct)
    {
        var clipped = name.Length > 200 ? name[..200] : name;
        var existing = await db.Calendars.Where(c => c.OwnerUserId == job.TargetUserId && !c.IsPrimary
                && c.DeletedAt == null && c.Name == clipped)
            .Select(c => (Guid?)c.Id).FirstOrDefaultAsync(ct);
        if (existing is Guid id) return id;
        var cal = new CalendarCalendar
        {
            TenantId = job.TenantId, OwnerUserId = job.TargetUserId, Name = clipped,
            Kind = "personal", IsPrimary = false, Timezone = zone.Length <= 64 ? zone : "Asia/Kolkata",
        };
        db.Calendars.Add(cal);
        await db.SaveChangesAsync(ct);
        return cal.Id;
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
