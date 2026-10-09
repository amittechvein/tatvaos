// ============================================================================
//  GOOGLE CALENDAR INTO THE CALENDAR MODULE: one meeting, one owner
// ============================================================================
//
//  Phase 3 of the migration design. A fake Google Calendar API and a REAL
//  database (its own throwaway one - run tests/migration-calendar/
//  test-calendar.sh). Two people's calendars, migrated one after the other,
//  as the runner would drive them:
//
//    amit   organises a weekly meeting (RRULE, an EXDATE, a moved occurrence,
//           a cancelled occurrence, attendees in and outside the
//           organisation, reminders, a Meet link), an all-day event, and is
//           invited to hr's meeting and to an EXTERNAL meeting hr is also in.
//           Google lists the moved occurrence BEFORE its meeting.
//    hr     organises their own meeting; is invited to the external one.
//
//  Asserts: what lands in whose calendar (the organiser's; an external
//  meeting once, in the first migrated attendee's), the recurrence and every
//  exception, attendees linked to their TatvaOS person, reminders, an all-day
//  event's UTC instant from Kolkata, that a deleted Google event does not
//  arrive, that running it all again changes nothing, and that another
//  organisation sees none of it.
// ============================================================================

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Modules.Migration.Calendar;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

var appConn = Environment.GetEnvironmentVariable("TDB_CONN");
var superConn = Environment.GetEnvironmentVariable("TDB_SUPER");
if (string.IsNullOrEmpty(appConn) || string.IsNullOrEmpty(superConn))
{
    Console.WriteLine("  TDB_CONN and TDB_SUPER are required - run tests/migration-calendar/test-calendar.sh");
    return 2;
}

var passed = 0; var failed = 0;
void Ok(string what) { passed++; Console.WriteLine($"  ok    {what}"); }
void Fail(string what) { failed++; Console.WriteLine($"  FAIL  {what}"); }
void Same<T>(string what, T got, T want)
{
    if (EqualityComparer<T>.Default.Equals(got, want)) Ok($"{what}  [got {got}]");
    else Fail($"{what} - got [{got}], wanted [{want}]");
}

Guid TECHVEIN = Guid.Parse("11111111-1111-1111-1111-111111111111"), SCHOOL = Guid.Parse("22222222-2222-2222-2222-222222222222");
Guid AMIT = Guid.Parse("d1111111-1111-1111-1111-111111111111"), HR = Guid.Parse("d1111111-1111-1111-1111-111111111112");

// ---- Pure rules first -----------------------------------------------------------
Console.WriteLine("\n  Google Calendar into the calendar module\n\n>> the event map");
using (var d = JsonDocument.Parse("""{"start":{"date":"2026-10-20"},"end":{"date":"2026-10-21"}}"""))
{
    var s = GoogleEventMap.ReadWhen(d.RootElement, "start", "Asia/Kolkata");
    Same("an all-day date in Kolkata is midnight there: 18:30 UTC the day before", s?.At.ToString("u"), "2026-10-19 18:30:00Z");
    Same("...and marked all-day", s?.AllDay, true);
}
Same("EXDATE with a zone", string.Join(",", GoogleEventMap.ExDates("EXDATE;TZID=Asia/Kolkata:20261012T100000,20261019T100000", "UTC").Select(x => x.ToString("u"))),
    "2026-10-12 04:30:00Z,2026-10-19 04:30:00Z");
Same("EXDATE in UTC", GoogleEventMap.ExDates("EXDATE:20261012T043000Z", "Asia/Kolkata").Single().ToString("u"), "2026-10-12 04:30:00Z");
Same("Google 'confidential' is private here", GoogleEventMap.Visibility("confidential"), "private");
Same("a popup reminder is a notification here", GoogleEventMap.ReminderMethod("popup"), "notification");

// ---- The real thing ---------------------------------------------------------------
var services = new ServiceCollection();
services.AddScoped<TenantContext>();
services.AddScoped<TenantConnectionInterceptor>();
services.AddDbContext<AppDbContext>((sp, o) =>
    o.UseNpgsql(appConn).AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>()));
await using var provider = services.BuildServiceProvider();

using var rsa = RSA.Create(2048);
using var account = GoogleServiceAccount.FromJson(JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["type"] = "service_account", ["client_email"] = "m@p.iam.gserviceaccount.com",
    ["private_key"] = rsa.ExportPkcs8PrivateKeyPem(), ["token_uri"] = "https://fake.test/token",
}));
var http = new HttpClient(new FakeCalendar());
var api = new GoogleApi(http, new GoogleTokenSource(http), new GoogleEndpoints { Calendar = new("https://fake.test/calendar/v3/") },
    (_, _) => Task.CompletedTask);
var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Migration:Calendar:PageSize"] = "3" }).Build();
var source = new GoogleCalendarSource(new GoogleCalendarClient(api), new OneAccount(account), provider.GetRequiredService<IServiceScopeFactory>(), config);

MigrationJobView Job(string google, Guid target) => new(Guid.NewGuid(), TECHVEIN, "google_workspace", "calendar", google, target, null, null, 0);
async Task<List<(string Id, string Outcome, string? Reason)>> RunAll(MigrationJobView j)
{
    var results = new List<(string, string, string?)>();
    while (true)
    {
        var page = await source.FetchAsync(j, CancellationToken.None);
        foreach (var item in page.Items)
            try { var r = await source.WriteAsync(j, item, CancellationToken.None); results.Add((item.SourceId, r.Outcome, r.Reason)); }
            catch (Exception ex) { results.Add((item.SourceId, $"threw {ex.GetType().Name}", ex.InnerException?.Message ?? ex.Message)); }
        if (page.IsLast) return results;
        j = j with { Cursor = page.NextCursor };
    }
}
async Task<string> Super(string sql)
{
    await using var c = new NpgsqlConnection(superConn);
    await c.OpenAsync();
    return (await new NpgsqlCommand(sql, c).ExecuteScalarAsync())?.ToString() ?? "";
}
string Outcomes(List<(string Id, string Outcome, string? Reason)> rs) => string.Join(",", rs.Select(r => $"{r.Id}={r.Outcome}"));
string InCal(Guid owner) => $"FROM calendar.events e JOIN calendar.calendars c ON c.id = e.calendar_id WHERE c.owner_user_id = '{owner}' AND c.is_primary";

Console.WriteLine("\n>> amit's calendar");
var a1 = await RunAll(Job("amit@customer.test", AMIT));
Same("outcomes (the moved occurrence is listed first, written in the second pass)",
    Outcomes(a1), "weekly=done,allday=done,byhr=skipped,external=done,weekly_moved=done,weekly_gone=done");
Same("...hr's meeting skipped, saying why",
    a1.Single(r => r.Id == "byhr").Reason, "organised by hr@techvein.local, in this organisation: it arrives with their calendar");
Same("three events in amit's primary calendar; the deleted one is not among them",
    await Super($"SELECT string_agg(e.uid, ',' ORDER BY e.uid) {InCal(AMIT)}"), "allday@google.com,external@partner.test,weekly@google.com");
Same("the weekly meeting: rule, zone, start in UTC, Meet link, organiser",
    await Super($"SELECT e.recurrence_rule || '|' || e.timezone || '|' || to_char(e.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || '|' || e.meeting_url || '|' || (e.organiser_user_id = '{AMIT}') {InCal(AMIT)} AND e.uid = 'weekly@google.com'"),
    "FREQ=WEEKLY;BYDAY=MO|Asia/Kolkata|2026-10-05 04:30|https://meet.google.com/abc-defg-hij|true");
Same("its exceptions: the EXDATE and the cancelled one cancelled, the moved one moved",
    await Super("SELECT string_agg(to_char(x.occurrence_starts_at AT TIME ZONE 'UTC', 'MM-DD') || '=' || CASE WHEN x.is_cancelled THEN 'cancelled' ELSE 'moved to ' || to_char(x.starts_at AT TIME ZONE 'UTC', 'HH24:MI') || ' ' || x.title END, ', ' ORDER BY x.occurrence_starts_at) FROM calendar.event_exceptions x JOIN calendar.events e ON e.id = x.event_id WHERE e.uid = 'weekly@google.com'"),
    "10-12=moved to 05:30 Weekly (moved), 10-19=cancelled, 10-26=cancelled");
Same("its attendees: hr linked to hr's account; the partner unlinked and optional; amit the chair",
    await Super($"SELECT string_agg(a.email || ':' || a.role || ':' || a.status || ':' || coalesce((a.user_id = '{HR}' OR a.user_id = '{AMIT}')::text, 'none'), ', ' ORDER BY a.email) FROM calendar.event_attendees a JOIN calendar.events e ON e.id = a.event_id WHERE e.uid = 'weekly@google.com'"),
    "amit@techvein.local:chair:accepted:true, hr@techvein.local:req-participant:accepted:true, x@partner.test:opt-participant:needs-action:none");
Same("its reminders, amit's: email 30, notification 10",
    await Super($"SELECT string_agg(r.method || ' ' || r.minutes_before, ', ' ORDER BY r.minutes_before DESC) FROM calendar.event_reminders r JOIN calendar.events e ON e.id = r.event_id WHERE e.uid = 'weekly@google.com' AND r.user_id = '{AMIT}'"),
    "email 30, notification 10");
Same("the all-day event: midnight Kolkata, all-day",
    await Super($"SELECT to_char(e.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' ' || e.is_all_day {InCal(AMIT)} AND e.uid = 'allday@google.com'"), "2026-10-19 18:30 true");
Same("the external meeting is amit's, with no organiser in this organisation",
    await Super($"SELECT (e.organiser_user_id IS NULL)::text {InCal(AMIT)} AND e.uid = 'external@partner.test'"), "true");

Console.WriteLine("\n>> hr's calendar");
var h1 = await RunAll(Job("hr@customer.test", HR));
Same("outcomes", Outcomes(h1), "byhr=done,external=skipped");
Same("...the external meeting: already in amit's calendar, not a second copy",
    h1.Single(r => r.Id == "external").Reason, "already in amit@techvein.local's calendar");
Same("hr's meeting is in hr's calendar, with amit linked as an attendee",
    await Super($"SELECT count(*) FROM calendar.event_attendees a JOIN calendar.events e ON e.id = a.event_id JOIN calendar.calendars c ON c.id = e.calendar_id WHERE e.uid = 'byhr@google.com' AND c.owner_user_id = '{HR}' AND a.user_id = '{AMIT}'"), "1");
Same("one row per meeting in the organisation", await Super("SELECT count(*) - count(DISTINCT uid) FROM calendar.events WHERE tenant_id = '11111111-1111-1111-1111-111111111111'"), "0");

Console.WriteLine("\n>> again, and from elsewhere");
var before = await Super("SELECT (SELECT count(*) FROM calendar.events) || '/' || (SELECT count(*) FROM calendar.event_exceptions) || '/' || (SELECT count(*) FROM calendar.event_attendees) || '/' || (SELECT count(*) FROM calendar.event_reminders)");
var a2 = await RunAll(Job("amit@customer.test", AMIT));
Same("amit again: nothing done", a2.Count(r => r.Outcome == "done"), 0);
Same("...every events/exceptions/attendees/reminders count unchanged",
    await Super("SELECT (SELECT count(*) FROM calendar.events) || '/' || (SELECT count(*) FROM calendar.event_exceptions) || '/' || (SELECT count(*) FROM calendar.event_attendees) || '/' || (SELECT count(*) FROM calendar.event_reminders)"), before);
await using (var c = new NpgsqlConnection(appConn))
{
    await c.OpenAsync();
    await new NpgsqlCommand($"SELECT set_config('app.tenant_id', '{SCHOOL}', false)", c).ExecuteNonQueryAsync();
    Same("ABC School sees none of the migrated meetings",
        (await new NpgsqlCommand("SELECT count(*) FROM calendar.events WHERE uid IN ('weekly@google.com','allday@google.com','external@partner.test','byhr@google.com')", c).ExecuteScalarAsync())?.ToString(), "0");
}

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

sealed class OneAccount(GoogleServiceAccount a) : IGoogleCredentialProvider
{
    public Task<GoogleServiceAccount?> ForTenantAsync(Guid tenantId, CancellationToken ct) => Task.FromResult<GoogleServiceAccount?>(a);
}

// A fake Google Calendar. Each person's events, as Google lists them with
// singleEvents=false; cancelled ones only with showDeleted=true.
sealed class FakeCalendar : HttpMessageHandler
{
    static readonly Dictionary<string, string> Token = [];

    static readonly string[] Amit =
    [
        // Listed FIRST, before its meeting: the moved occurrence.
        """{"id":"weekly_moved","iCalUID":"weekly@google.com","recurringEventId":"weekly","status":"confirmed","summary":"Weekly (moved)", "originalStartTime":{"dateTime":"2026-10-12T10:00:00+05:30","timeZone":"Asia/Kolkata"}, "start":{"dateTime":"2026-10-12T11:00:00+05:30","timeZone":"Asia/Kolkata"},"end":{"dateTime":"2026-10-12T11:30:00+05:30","timeZone":"Asia/Kolkata"}, "organizer":{"email":"amit@techvein.local","self":true}}""",
        """{"id":"weekly","iCalUID":"weekly@google.com","status":"confirmed","summary":"Weekly","sequence":2, "hangoutLink":"https://meet.google.com/abc-defg-hij", "start":{"dateTime":"2026-10-05T10:00:00+05:30","timeZone":"Asia/Kolkata"},"end":{"dateTime":"2026-10-05T10:30:00+05:30","timeZone":"Asia/Kolkata"}, "recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO","EXDATE;TZID=Asia/Kolkata:20261019T100000"], "organizer":{"email":"amit@techvein.local","self":true}, "attendees":[{"email":"amit@techvein.local","organizer":true,"self":true,"responseStatus":"accepted"}, {"email":"HR@techvein.local","responseStatus":"accepted"}, {"email":"x@partner.test","optional":true,"responseStatus":"needsAction","displayName":"Partner X"}], "reminders":{"useDefault":false,"overrides":[{"method":"email","minutes":30},{"method":"popup","minutes":10}]}}""",
        """{"id":"allday","iCalUID":"allday@google.com","status":"confirmed","summary":"Diwali","transparency":"transparent", "start":{"date":"2026-10-20"},"end":{"date":"2026-10-21"},"organizer":{"email":"amit@techvein.local","self":true}}""",
        """{"id":"byhr","iCalUID":"byhr@google.com","status":"confirmed","summary":"HR review", "start":{"dateTime":"2026-10-07T15:00:00+05:30"},"end":{"dateTime":"2026-10-07T16:00:00+05:30"}, "organizer":{"email":"hr@techvein.local"}, "attendees":[{"email":"hr@techvein.local","organizer":true,"responseStatus":"accepted"},{"email":"amit@techvein.local","self":true,"responseStatus":"accepted"}]}""",
        """{"id":"external","iCalUID":"external@partner.test","status":"confirmed","summary":"Partner call", "start":{"dateTime":"2026-10-08T09:00:00Z"},"end":{"dateTime":"2026-10-08T10:00:00Z"}, "organizer":{"email":"boss@partner.test"}, "attendees":[{"email":"boss@partner.test","organizer":true,"responseStatus":"accepted"}, {"email":"amit@techvein.local","self":true,"responseStatus":"accepted"},{"email":"hr@techvein.local","responseStatus":"tentative"}]}""",
        """{"id":"weekly_gone","iCalUID":"weekly@google.com","recurringEventId":"weekly","status":"cancelled", "originalStartTime":{"dateTime":"2026-10-26T10:00:00+05:30","timeZone":"Asia/Kolkata"}}""",
        """{"id":"deleted","iCalUID":"deleted@google.com","status":"cancelled"}""",
    ];
    static readonly string[] Hr =
    [
        """{"id":"byhr","iCalUID":"byhr@google.com","status":"confirmed","summary":"HR review", "start":{"dateTime":"2026-10-07T15:00:00+05:30"},"end":{"dateTime":"2026-10-07T16:00:00+05:30"}, "organizer":{"email":"hr@techvein.local","self":true}, "attendees":[{"email":"hr@techvein.local","organizer":true,"self":true,"responseStatus":"accepted"},{"email":"amit@techvein.local","responseStatus":"accepted"}]}""",
        """{"id":"external","iCalUID":"external@partner.test","status":"confirmed","summary":"Partner call", "start":{"dateTime":"2026-10-08T09:00:00Z"},"end":{"dateTime":"2026-10-08T10:00:00Z"}, "organizer":{"email":"boss@partner.test"}, "attendees":[{"email":"boss@partner.test","organizer":true,"responseStatus":"accepted"},{"email":"hr@techvein.local","self":true,"responseStatus":"tentative"}]}""",
    ];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        string body;
        if (path == "/token")
        {
            var form = req.Content!.ReadAsStringAsync(ct).Result;
            var part = Uri.UnescapeDataString(form.Split("assertion=")[1].Split('&')[0]).Split('.')[1].Replace('-', '+').Replace('_', '/');
            var sub = JsonDocument.Parse(Convert.FromBase64String(part + new string('=', (4 - part.Length % 4) % 4))).RootElement.GetProperty("sub").GetString()!;
            var t = $"ya29.{Token.Count}";
            Token[t] = sub;
            body = $$"""{"access_token":"{{t}}","expires_in":3600}""";
        }
        else
        {
            var who = Token[req.Headers.Authorization!.Parameter!];
            var q = req.RequestUri.Query;
            var showDeleted = q.Contains("showDeleted=true");
            var size = int.Parse(System.Text.RegularExpressions.Regex.Match(q, "maxResults=(\\d+)").Groups[1].Value);
            var from = q.Contains("pageToken=") ? int.Parse(System.Text.RegularExpressions.Regex.Match(q, "pageToken=(\\d+)").Groups[1].Value) : 0;
            var all = (who.StartsWith("amit") ? Amit : Hr)
                .Where(e => showDeleted || !e.Contains("\"status\":\"cancelled\"")).ToList();
            var page = all.Skip(from).Take(size).ToList();
            var next = from + size < all.Count ? $",\"nextPageToken\":\"{from + size}\"" : "";
            body = $"{{\"timeZone\":\"Asia/Kolkata\",\"items\":[{string.Join(",", page)}]{next}}}";
        }
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}
