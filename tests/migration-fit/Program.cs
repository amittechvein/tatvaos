// ============================================================================
//  THE SIZE ESTIMATE AND ITS VERDICT: refuse with a number, never fill a disk
// ============================================================================
//
//  Migration design, section 8. Two halves, both without Google, a disk or a
//  database:
//
//   MigrationFit.Judge   pure arithmetic over a report, two disks and the
//                        organisation's capacity. Each rule has a case built
//                        so that ONLY that rule decides it:
//                          mail counted twice on disk - 12 GiB of mail fits a
//                            20 GiB usable disk once, and must not fit twice
//                          the reserve - max(10% of the disk, 5 GiB)
//                          one filesystem vs two
//                          the organisation's mail and Space allocations
//                          per-person quota, by name
//                          unmeasured people: never "fits"
//   MigrationSizeEstimator  against a fake Google: the directory read as the
//                        admin across two pages; suspended and archived people
//                        left out and listed; each person measured as
//                        themselves; trash not counted; a person Google
//                        refuses is UNMEASURED with the reason, not zero
//
//  `dotnet run` and read the last line; the exit code is the verdict.
// ============================================================================

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Shared.Google;

const long GiB = 1024L * 1024 * 1024;
var passed = 0; var failed = 0;
void Ok(string what) { passed++; Console.WriteLine($"  ok    {what}"); }
void Fail(string what) { failed++; Console.WriteLine($"  FAIL  {what}"); }
void Same<T>(string what, T got, T want)
{
    if (EqualityComparer<T>.Default.Equals(got, want)) Ok($"{what}  [got {got}]");
    else Fail($"{what} - got [{got}], wanted [{want}]");
}
void Has(string what, MigrationVerdict v, string text)
{
    if (v.Reasons.Any(r => r.Contains(text))) Ok($"{what}  [\"{text}\"]");
    else Fail($"{what} - no reason contains \"{text}\"; reasons: {string.Join(" | ", v.Reasons)}");
}

StorageAllocator.Capacity Cap(long total, long used) =>
    new("pooled", total, used, Math.Max(0, total - used), total > 0 ? (double)used / total : 0, false, false, 1, null, true, null);
MigrationSizeReport Report(params (string Email, long Mail, long Drive)[] people) =>
    new(people.Select(p => new PersonSize(p.Email, p.Mail, p.Drive)).ToList(), [], []);
var roomy = Cap(10_000 * GiB, 0);
// One 100 GiB filesystem with 30 GiB free: reserve 10 GiB, so 20 GiB usable.
var disk = new DiskFigures("/var/mail/vhosts", 30 * GiB, 100 * GiB);
var sameDisk = disk with { Path = "/var/lib/space/blobs" };

Console.WriteLine("\n  Migration size estimate and verdict");

Console.WriteLine("\n>> disk");
var v = MigrationFit.Judge(Report(("a@x", 8 * GiB, 0)), disk, sameDisk, roomy, roomy, null);
Same("8 GiB of mail (16 on disk) fits 20 GiB usable", v.State, "fits");
v = MigrationFit.Judge(Report(("a@x", 12 * GiB, 0)), disk, sameDisk, roomy, roomy, null);
Same("12 GiB of mail - fits once, NOT twice - is refused", v.State, "refused");
Has("...saying it is stored twice", v, "12.0 GiB of mail stored twice");
Has("...with the shortfall", v, "short by 4.0 GiB");
v = MigrationFit.Judge(Report(("a@x", 6 * GiB, 9 * GiB)), disk, sameDisk, roomy, roomy, null);
Same("one filesystem: 12 GiB mail-on-disk + 9 GiB Drive > 20 usable is refused", v.State, "refused");
Has("...as one disk", v, "the mail and Space disk");
var otherDisk = new DiskFigures("/srv/space", 400 * GiB, 500 * GiB);
v = MigrationFit.Judge(Report(("a@x", 6 * GiB, 9 * GiB)), disk, otherDisk, roomy, roomy, null);
Same("...the same on two filesystems fits (each disk judged on its own)", v.State, "fits");
var small = new DiskFigures("/var/mail/vhosts", 8 * GiB, 20 * GiB);
v = MigrationFit.Judge(Report(("a@x", 2 * GiB, 0)), small, small with { Path = "/s" }, roomy, roomy, null);
Same("small disk: the reserve is 5 GiB, not 10% (4 GiB of mail-on-disk > 3 usable)", v.State, "refused");
Has("...naming the reserve", v, "5.0 GiB of it kept in reserve");

Console.WriteLine("\n>> the organisation's storage");
v = MigrationFit.Judge(Report(("a@x", 3 * GiB, 0)), disk, otherDisk, Cap(10 * GiB, 8 * GiB), roomy, null);
Same("3 GiB of mail with 2 GiB of mail storage left is refused", v.State, "refused");
Has("...counted ONCE against the organisation", v, "Mail storage: needs 3.0 GiB, the organisation has 2.0 GiB left");
v = MigrationFit.Judge(Report(("a@x", 0, 5 * GiB)), disk, otherDisk, roomy, Cap(4 * GiB, 0), null);
Same("5 GiB of Drive with 4 GiB of Space left is refused", v.State, "refused");
Has("...as Space storage", v, "Space storage: needs 5.0 GiB");

Console.WriteLine("\n>> per-person quota");
v = MigrationFit.Judge(Report(("small@x", 1 * GiB, 0), ("big@x", 3 * GiB, 0)), disk, otherDisk, roomy, roomy, 2 * GiB);
Same("one person over a 2 GiB per-person quota: refused", v.State, "refused");
Same("...naming exactly that person", string.Join(",", v.OverQuota.Select(p => p.Email)), "big@x");
Has("...with their numbers", v, "big@x: 3.0 GiB of mail, over the 2.0 GiB per-person quota by 1.0 GiB");

Console.WriteLine("\n>> unmeasured people");
var partial = new MigrationSizeReport([new("a@x", 1 * GiB, 0)], [], [new("b@x", "Google API HTTP 403")]);
v = MigrationFit.Judge(partial, disk, otherDisk, roomy, roomy, null);
Same("everything fits but one person is unmeasured: incomplete, not fits", v.State, "incomplete");
v = MigrationFit.Judge(partial with { People = [new("a@x", 50 * GiB, 0)] }, disk, otherDisk, roomy, roomy, null);
Same("...and a refusal still wins over incomplete", v.State, "refused");

v = MigrationFit.Judge(Report(("a@x", 1 * GiB, 0)), disk, otherDisk, null, roomy, null);
Same("mail storage not given: incomplete, never fits", v.State, "incomplete");
Has("...saying what was not checked", v, "not checked: the organisation's mail storage");

Console.WriteLine("\n>> sizes");
Same("bytes", MigrationFit.Size(512), "512 B");
Same("GiB with one decimal", MigrationFit.Size(1536L * 1024 * 1024), "1.5 GiB");
Same("large values without decimals", MigrationFit.Size(250 * GiB), "250 GiB");

Console.WriteLine("\n>> disk figures");
var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var sub = Directory.CreateTempSubdirectory("migration-fit-").FullName;
try
{
    var a = DiskFigures.Of(home);
    var b = DiskFigures.Of(sub);
    var c = DiskFigures.Of(Path.Combine(home, "."));
    if (a.TotalBytes > 0 && a.FreeBytes > 0) Ok($"a real directory measures ({MigrationFit.Size(a.FreeBytes)} free of {MigrationFit.Size(a.TotalBytes)})");
    else Fail($"a real directory measured as nothing: {a}");
    Same("the same filesystem reached by two paths is one filesystem", a.SameFilesystemAs(c), true);
    Console.WriteLine($"        (temp {b.Path}: {MigrationFit.Size(b.FreeBytes)} free of {MigrationFit.Size(b.TotalBytes)}; one filesystem with home: {a.SameFilesystemAs(b)})");
}
finally { Directory.Delete(sub); }
Same("a different total is a different filesystem", disk.SameFilesystemAs(otherDisk), false);

Console.WriteLine("\n>> the estimator, against a fake Google");
using var rsa = RSA.Create(2048);
using var account = GoogleServiceAccount.FromJson(JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["type"] = "service_account", ["client_email"] = "m@p.iam.gserviceaccount.com",
    ["private_key"] = rsa.ExportPkcs8PrivateKeyPem(), ["token_uri"] = "https://fake.test/token",
}));
var fake = new FakeWorkspace();
var http = new HttpClient(fake);
var api = new GoogleApi(http, new GoogleTokenSource(http),
    new GoogleEndpoints { Drive = new("https://fake.test/drive/v3/"), Directory = new("https://fake.test/admin/directory/v1/") },
    (_, _) => Task.CompletedTask);
var report = await new MigrationSizeEstimator(new GoogleWorkspaceClient(api)).MeasureAsync(account, "admin@customer.test", CancellationToken.None);

Same("the directory was read as the admin, across both pages", string.Join(",", fake.DirectoryCallers), "admin@customer.test,admin@customer.test");
Same("...with the directory scope only", fake.DirectoryScopes.Distinct().Single(), GoogleScopes.DirectoryUsersReadOnly);
Same("measured: the three active people", string.Join(",", report.People.Select(p => p.Email)), "admin@customer.test,alice@customer.test,carol@customer.test");
Same("each measured as themselves", string.Join(",", fake.DriveCallers.Order()), "admin@customer.test,alice@customer.test,bob@customer.test,carol@customer.test,frank@customer.test");
Same("not migrated: suspended and archived, with reasons",
    string.Join(",", report.NotMigrated.Select(n => $"{n.Email}={n.Reason}")), "dave@customer.test=suspended in Google,erin@customer.test=archived in Google");
Same("Google refused bob, the network failed for frank: both UNMEASURED, not zero",
    string.Join(",", report.Unmeasured.Select(u => u.Email)), "bob@customer.test,frank@customer.test");
Same("...bob with Google's status as the reason", report.Unmeasured.FirstOrDefault(u => u.Email.StartsWith("bob"))?.Reason.StartsWith("Google API HTTP 403"), true);
Same("...frank's reason names the failure, not the URL",
    report.Unmeasured.FirstOrDefault(u => u.Email.StartsWith("frank"))?.Reason, "Google could not be reached (HttpRequestException)");
var alice = report.People.Single(p => p.Email == "alice@customer.test");
Same("alice's mail = usage - usageInDrive", alice.MailBytes, 7 * GiB);
Same("alice's Drive leaves out her trash", alice.DriveBytes, 2 * GiB);
Same("totals: mail (alice 7, carol 1, admin 1; bob not counted)", report.MailBytes, 9 * GiB);
Same("totals: Drive (alice 2, carol 4, admin 0)", report.DriveBytes, 6 * GiB);

var directoryCallsBefore = fake.DirectoryCallers.Count;
var one = await new MigrationSizeEstimator(new GoogleWorkspaceClient(api)).MeasurePeopleAsync(account, ["alice@customer.test"], CancellationToken.None);
Same("one named person: measured, nobody else", string.Join(",", one.People.Select(p => p.Email)), "alice@customer.test");
Same("...and the directory was NOT read (no admin, no colleagues' data)", fake.DirectoryCallers.Count, directoryCallsBefore);

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

// A fake Google Workspace: a token endpoint, a two-page directory, and each
// person's storage quota (as strings, as Drive sends them).
sealed class FakeWorkspace : HttpMessageHandler
{
    public readonly List<string> DirectoryCallers = [], DirectoryScopes = [], DriveCallers = [];
    private readonly Dictionary<string, (string Sub, string Scope)> _tokens = [];
    const long G = 1024L * 1024 * 1024;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        if (path == "/token")
        {
            var form = (await req.Content!.ReadAsStringAsync(ct)).Split('&').Select(kv => kv.Split('=', 2))
                .ToDictionary(kv => kv[0], kv => Uri.UnescapeDataString(kv[1]));
            var part = form["assertion"].Split('.')[1].Replace('-', '+').Replace('_', '/');
            var claims = JsonDocument.Parse(Convert.FromBase64String(part + new string('=', (4 - part.Length % 4) % 4))).RootElement;
            var token = $"ya29.t{_tokens.Count}";
            _tokens[token] = (claims.GetProperty("sub").GetString()!, claims.GetProperty("scope").GetString()!);
            return Json(200, $$"""{"access_token":"{{token}}","expires_in":3600}""");
        }
        var (sub, scope) = _tokens[req.Headers.Authorization!.Parameter!];
        if (path.EndsWith("/users"))
        {
            DirectoryCallers.Add(sub); DirectoryScopes.Add(scope);
            return req.RequestUri.Query.Contains("pageToken=p2")
                ? Json(200, """{"users":[{"primaryEmail":"dave@customer.test","suspended":true},{"primaryEmail":"erin@customer.test","archived":true},{"primaryEmail":"carol@customer.test"},{"primaryEmail":"frank@customer.test"}]}""")
                : Json(200, """{"users":[{"primaryEmail":"alice@customer.test"},{"primaryEmail":"bob@customer.test"},{"primaryEmail":"admin@customer.test"}],"nextPageToken":"p2"}""");
        }
        if (path.EndsWith("/about"))
        {
            DriveCallers.Add(sub);
            return sub switch
            {
                "alice@customer.test" => Quota(10 * G, 3 * G, 1 * G),   // mail 7, Drive 2 (1 in trash)
                "frank@customer.test" => throw new HttpRequestException("Connection refused (frank@customer.test)"),
                "bob@customer.test" => Json(403, """{"error":{"code":403,"message":"Drive is turned off for this user","errors":[{"reason":"forbidden"}]}}"""),
                "carol@customer.test" => Quota(5 * G, 4 * G, 0),    // mail 1, Drive 4
                _ => Quota(1 * G, 0, 0),                           // admin: mail 1, Drive 0
            };
        }
        return Json(404, """{"error":{"code":404,"message":"not found"}}""");
    }

    private static HttpResponseMessage Quota(long usage, long inDrive, long trash) =>
        Json(200, $$$"""{"storageQuota":{"limit":"16106127360","usage":"{{{usage}}}","usageInDrive":"{{{inDrive}}}","usageInDriveTrash":"{{{trash}}}"}}""");

    private static HttpResponseMessage Json(int status, string body) =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
}
