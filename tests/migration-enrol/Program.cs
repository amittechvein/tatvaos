// ============================================================================
//  THE WHOLE ORGANISATION, PERSON BY PERSON: enrol, match, start, progress
// ============================================================================
//
//  MigrationEnrolment against a REAL database (its own throwaway one - run
//  tests/migration-enrol/test-enrolment.sh, which makes it), as the API's own
//  role, inside one organisation at a time, through the same DbContext,
//  TenantContext and connection interceptor the API uses. Asserts:
//
//    enrol    one 'planned' job per active person per type; suspended and
//             archived Google accounts left out and listed; a repeat creates
//             nothing
//    match    by sign-in email, or by the person's own mailbox address;
//             NEVER by another organisation's person with that address -
//             mail delivered to the wrong company is the one mistake a
//             migration cannot take back; unmatched people listed by address
//    start    only matched people; one person first works; asked-for people
//             who cannot start are named with the reason
//    progress per Google address, per data type; another organisation sees
//             none of it
//
//  Expects TDB_CONN (tatvaos_app) and TDB_SUPER (a superuser, for fixtures).
// ============================================================================

using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

var appConn = Environment.GetEnvironmentVariable("TDB_CONN");
var superConn = Environment.GetEnvironmentVariable("TDB_SUPER");
if (string.IsNullOrEmpty(appConn) || string.IsNullOrEmpty(superConn))
{
    Console.WriteLine("  TDB_CONN and TDB_SUPER are required - run tests/migration-enrol/test-enrolment.sh");
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
var XAVIER = Guid.Parse("e1111111-1111-4111-8111-000000000421");

var services = new ServiceCollection();
services.AddScoped<TenantContext>();
services.AddScoped<TenantConnectionInterceptor>();
services.AddDbContext<AppDbContext>((sp, o) =>
    o.UseNpgsql(appConn).AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>()));
services.AddScoped<MigrationEnrolment>();
await using var provider = services.BuildServiceProvider();

// The same thing the worker and an endpoint do: a fresh scope, inside one organisation.
async Task<T> In<T>(Guid tenant, Func<MigrationEnrolment, Task<T>> f)
{
    await using var scope = provider.CreateAsyncScope();
    scope.ServiceProvider.GetRequiredService<TenantContext>().EnterAnonymousScope(tenant, "system");
    return await f(scope.ServiceProvider.GetRequiredService<MigrationEnrolment>());
}

// A person whose sign-in email differs from their mailbox address, so the
// mailbox match is the only one that can find them.
await using (var su = new NpgsqlConnection(superConn))
{
    await su.OpenAsync();
    await new NpgsqlCommand($$"""
        INSERT INTO core.users (id, tenant_id, domain_id, email, display_name, status)
        VALUES ('{{XAVIER}}', '{{TECHVEIN}}', 'a1111111-1111-1111-1111-111111111111', 'x.signin@techvein.local', 'Xavier', 'active');
        INSERT INTO mail.mailboxes (tenant_id, domain_id, user_id, address, local_part, type, imap_password_hash, quota_bytes)
        VALUES ('{{TECHVEIN}}', 'a1111111-1111-1111-1111-111111111111', '{{XAVIER}}', 'xavier@techvein.local', 'xavier', 'user', '{PLAIN}x', 1073741824);
        """, su).ExecuteNonQueryAsync();
}
Console.WriteLine("\n  Migration enrolment\n");

GoogleDirectoryUser P(string e, bool s = false, bool a = false) => new(e, s, a);
var directory = new List<GoogleDirectoryUser>
{
    P("Amit@TechVein.local"),          // sign-in email, any case
    P("hr@techvein.local"),            // sign-in email
    P("xavier@techvein.local"),        // mailbox address only
    P("principal@abcschool.local"),    // a person - in ANOTHER organisation
    P("ghost@techvein.local"),         // nobody
    P("gone@techvein.local", s: true), // suspended in Google
    P("old@techvein.local", a: true),  // archived in Google
};
string[] mailAndContacts = ["mail", "contacts"];

Console.WriteLine(">> enrol");
var r1 = await In(TECHVEIN, e => e.EnrolAsync(TECHVEIN, directory, mailAndContacts, null, CancellationToken.None));
Same("five active people offered", r1.People, 5);
Same("ten jobs created (five people x two types)", r1.JobsCreated, 10);
Same("matched: amit, hr, xavier", r1.Matched, 3);
Same("unmatched, by address - including the OTHER organisation's principal",
    string.Join(",", r1.Unmatched), "ghost@techvein.local,principal@abcschool.local");
Same("not enrolled: suspended and archived", string.Join(",", r1.NotEnrolled), "gone@techvein.local,old@techvein.local");

var progress = await In(TECHVEIN, e => e.ProgressAsync(CancellationToken.None));
Same("every job starts 'planned' - enrolling starts nothing",
    string.Join(",", progress.SelectMany(p => p.Types).Select(t => t.State).Distinct()), "planned");
Same("xavier matched through his mailbox to his sign-in account",
    progress.Single(p => p.GoogleAddress == "xavier@techvein.local").TargetEmail, "x.signin@techvein.local");
Same("the other organisation's principal is NOT a target",
    progress.Single(p => p.GoogleAddress == "principal@abcschool.local").TargetUserId, null);

var r2 = await In(TECHVEIN, e => e.EnrolAsync(TECHVEIN, directory, mailAndContacts, null, CancellationToken.None));
Same("enrolling again creates nothing", r2.JobsCreated, 0);
Same("...and matches the same people", r2.Matched, 3);

Console.WriteLine("\n>> start");
var s1 = await In(TECHVEIN, e => e.StartAsync(["mail"], ["amit@techvein.local", "ghost@techvein.local", "nobody@techvein.local"], CancellationToken.None));
Same("one person first: amit's mail only", s1.JobsStarted, 1);
Same("...the unmatched one is named, with why",
    s1.NotStarted.FirstOrDefault(n => n.Email == "ghost@techvein.local")?.Reason, "no TatvaOS person matches this address");
Same("...and the one never enrolled",
    s1.NotStarted.FirstOrDefault(n => n.Email == "nobody@techvein.local")?.Reason, "not enrolled");
var s2 = await In(TECHVEIN, e => e.StartAsync(["mail"], null, CancellationToken.None));
Same("then everyone's mail: hr and xavier (amit is already started; ghost and principal cannot be)", s2.JobsStarted, 2);
progress = await In(TECHVEIN, e => e.ProgressAsync(CancellationToken.None));
Same("amit: mail pending, contacts still planned",
    string.Join(",", progress.Single(p => p.GoogleAddress == "amit@techvein.local").Types.Select(t => $"{t.DataType}={t.State}")),
    "contacts=planned,mail=pending");
Same("ghost: nothing started", string.Join(",", progress.Single(p => p.GoogleAddress == "ghost@techvein.local").Types.Select(t => t.State).Distinct()), "planned");
try
{
    await In(TECHVEIN, e => e.StartAsync(["email"], null, CancellationToken.None));
    Fail("an unknown data type was accepted");
}
catch (ArgumentException) { Ok("an unknown data type is refused"); }

Console.WriteLine("\n>> another organisation");
var school = await In(SCHOOL, e => e.ProgressAsync(CancellationToken.None));
Same("ABC School sees none of Techvein's migration", school.Count, 0);
var rs = await In(SCHOOL, e => e.EnrolAsync(SCHOOL, [P("amit@techvein.local"), P("principal@abcschool.local")], ["mail"], null, CancellationToken.None));
Same("ABC School: its principal matches, Techvein's amit does NOT",
    $"{rs.Matched}:{string.Join(",", rs.Unmatched)}", "1:amit@techvein.local");
var started = await In(SCHOOL, e => e.StartAsync(["mail"], null, CancellationToken.None));
Same("starting ABC School's mail starts ABC School's one job, not Techvein's", started.JobsStarted, 1);
progress = await In(TECHVEIN, e => e.ProgressAsync(CancellationToken.None));
Same("...Techvein's ghost is still planned", progress.Single(p => p.GoogleAddress == "ghost@techvein.local").Types.Single(t => t.DataType == "mail").State, "planned");

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;
