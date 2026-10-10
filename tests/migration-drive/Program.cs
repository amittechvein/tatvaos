// ============================================================================
//  GOOGLE DRIVE INTO THE PERSON'S OWN SPACE, through Space's own save path
// ============================================================================
//
//  Phase 4 of the migration design. A fake Drive API and a REAL database (its
//  own throwaway one - run tests/migration-drive/test-drive.sh), with Space's
//  real blob store writing under a scratch folder. Asserts:
//
//    * files land under "Google Drive/<their Drive path>" in the person's own
//      Space, folders built from Drive's parents, each folder asked about once
//    * the bytes stored are the bytes Drive sent
//    * Google Docs/Sheets/Slides are SKIPPED, saying phase 5 waits on
//      Mr. Singh (design section 6); a Form, with no file, skipped too
//    * a file Space refuses (over Space:MaxFileBytes) is FAILED with Space's
//      own reason - the same gate as an upload, not one of our own
//    * the files are the person's: a colleague sees none of them
//    * running it all again adds nothing
// ============================================================================

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Modules.Migration.Drive;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

var appConn = Environment.GetEnvironmentVariable("TDB_CONN");
var superConn = Environment.GetEnvironmentVariable("TDB_SUPER");
if (string.IsNullOrEmpty(appConn) || string.IsNullOrEmpty(superConn))
{
    Console.WriteLine("  TDB_CONN and TDB_SUPER are required - run tests/migration-drive/test-drive.sh");
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

Guid TECHVEIN = Guid.Parse("11111111-1111-1111-1111-111111111111");
Guid AMIT = Guid.Parse("d1111111-1111-1111-1111-111111111111"), HR = Guid.Parse("d1111111-1111-1111-1111-111111111112");
var blobRoot = Directory.CreateTempSubdirectory("migration-drive-blobs-").FullName;

var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Migration:Drive:PageSize"] = "2", ["Space:BlobRoot"] = blobRoot, ["Space:MaxFileBytes"] = "1000",
}).Build();
var services = new ServiceCollection();
services.AddSingleton<IConfiguration>(config);
services.AddScoped<TenantContext>();
services.AddScoped<TenantConnectionInterceptor>();
services.AddDbContext<AppDbContext>((sp, o) =>
    o.UseNpgsql(appConn).AddInterceptors(sp.GetRequiredService<TenantConnectionInterceptor>()));
services.AddScoped<StorageAllocator>();
services.AddSingleton<IBlobStore, FileSystemBlobStore>();
services.AddScoped<SpaceContentGateway>();
await using var provider = services.BuildServiceProvider();

using var rsa = RSA.Create(2048);
using var account = GoogleServiceAccount.FromJson(JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["type"] = "service_account", ["client_email"] = "m@p.iam.gserviceaccount.com",
    ["private_key"] = rsa.ExportPkcs8PrivateKeyPem(), ["token_uri"] = "https://fake.test/token",
}));
var fake = new FakeDrive();
var http = new HttpClient(fake);
var api = new GoogleApi(http, new GoogleTokenSource(http), new GoogleEndpoints { Drive = new("https://fake.test/drive/v3/") },
    (_, _) => Task.CompletedTask);
var source = new GoogleDriveSource(new GoogleDriveClient(api), new OneAccount(account), provider.GetRequiredService<IServiceScopeFactory>(), config);
var job = new MigrationJobView(Guid.NewGuid(), TECHVEIN, "google_workspace", "drive", "amit@customer.test", AMIT, null, null, 0);

async Task<List<(string Id, string Outcome, string? Reason)>> RunAll()
{
    var results = new List<(string, string, string?)>();
    var j = job;
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
// Every live file of amit's, as "path/name size".
const string Tree = """
    WITH RECURSIVE p AS (
        SELECT id, name::text AS path FROM space.folders
         WHERE parent_folder_id IS NULL AND owner_user_id = 'd1111111-1111-1111-1111-111111111111' AND deleted_at IS NULL
        UNION ALL
        SELECT f.id, p.path || '/' || f.name FROM space.folders f JOIN p ON f.parent_folder_id = p.id WHERE f.deleted_at IS NULL)
    SELECT string_agg(p.path || '/' || x.name || ' ' || x.size_bytes, ', ' ORDER BY (p.path || '/' || x.name) COLLATE "C")
      FROM space.files x JOIN p ON p.id = x.folder_id
     WHERE x.owner_user_id = 'd1111111-1111-1111-1111-111111111111' AND x.deleted_at IS NULL
    """;

// amit needs a Space allowance for the gate to say yes; the seed may not give one.
await Super($"UPDATE core.storage_pools SET per_user_quota_bytes = coalesce(per_user_quota_bytes, 1073741824) WHERE tenant_id = '{TECHVEIN}'");

try
{
    Console.WriteLine("\n  Google Drive into Space\n\n>> first run");
    var first = await RunAll();
    Same("outcomes", string.Join(",", first.Select(r => $"{r.Id}={r.Outcome}")),
        "f1=done,f2=done,f3=skipped,f4=done,f5=skipped,f6=failed");
    Same("the Google Doc: skipped, naming phase 5", first.Single(r => r.Id == "f3").Reason,
        "a Google Docs/Sheets/Slides file: phase 5, waiting on Mr. Singh's ruling (design section 6)");
    Same("the Form: skipped, no file", first.Single(r => r.Id == "f5").Reason, "a Google-native form has no file to bring");
    Same("the big file: Space's own refusal", first.Single(r => r.Id == "f6").Reason?.StartsWith("Space refused it (file_too_large)"), true);
    Same("amit's Space: Google Drive/<Drive path>/<file>",
        await Super(Tree), "Google Drive/A/B/photo.jpg 6, Google Drive/A/report.pdf 5, Google Drive/notes.txt 4");
    Same("each Drive folder asked about once (A, B, My Drive)", string.Join(",", fake.FolderLookups.Order()), "A,B,root0");

    await using (var scope = provider.CreateAsyncScope())
    {
        scope.ServiceProvider.GetRequiredService<TenantContext>().Set(TECHVEIN, AMIT, "employee");
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var photo = await db.SpaceFiles.AsNoTracking().FirstAsync(f => f.Name == "photo.jpg");
        await using var s = scope.ServiceProvider.GetRequiredService<IBlobStore>().OpenRead(photo.BlobKey)!;
        using var ms = new MemoryStream(); await s.CopyToAsync(ms);
        Same("the bytes stored are the bytes Drive sent", Encoding.ASCII.GetString(ms.ToArray()), "PHOTO!");
        Same("...with Drive's type", photo.MimeType, "image/jpeg");
    }

    Console.WriteLine("\n>> whose they are, and again");
    await using (var c = new NpgsqlConnection(appConn))
    {
        await c.OpenAsync();
        await new NpgsqlCommand($"SELECT set_config('app.tenant_id', '{TECHVEIN}', false), set_config('app.user_id', '{HR}', false)", c).ExecuteNonQueryAsync();
        Same("hr, in the same organisation, sees none of amit's files",
            (await new NpgsqlCommand("SELECT count(*) FROM space.files WHERE name IN ('photo.jpg','report.pdf','notes.txt')", c).ExecuteScalarAsync())?.ToString(), "0");
    }
    var before = await Super(Tree);
    var second = await RunAll();
    Same("again: nothing written", second.Count(r => r.Outcome == "done"), 0);
    Same("...the three files skipped as already in Space", second.Count(r => r.Reason == "already in Space"), 3);
    Same("...amit's Space unchanged", await Super(Tree), before);
    Same("...and no second folder of any name", await Super($"SELECT count(*) - count(DISTINCT (parent_folder_id, name)) FROM space.folders WHERE owner_user_id = '{AMIT}' AND deleted_at IS NULL"), "0");

    Console.WriteLine("\n>> a SHARED drive - the organisation's");
    await Super($"INSERT INTO migration.grants (tenant_id, google_domain, google_admin, client_id) VALUES ('{TECHVEIN}', 'techvein.local', 'admin@techvein.local', 'x')");
    // The "Space" allocation the organisational gate checks.
    await Super($"INSERT INTO core.storage_allocations (tenant_id, product_code, allocated_bytes) VALUES ('{TECHVEIN}', 'drive', 1073741824) ON CONFLICT (tenant_id, product_code) DO UPDATE SET allocated_bytes = 1073741824");
    var sjob = new MigrationJobView(Guid.NewGuid(), TECHVEIN, "google_workspace", "drive", "shareddrive:SD1:Finance", AMIT, null, null, 0);
    var sres = new List<(string, string, string?)>();
    var sp = await source.FetchAsync(sjob, CancellationToken.None);
    foreach (var item in sp.Items)
        try { var r = await source.WriteAsync(sjob, item, CancellationToken.None); sres.Add((item.SourceId, r.Outcome, r.Reason)); }
        catch (Exception ex) { sres.Add((item.SourceId, $"threw {ex.GetType().Name}", ex.InnerException?.Message ?? ex.Message)); }
    Same("the shared drive's file written", string.Join(",", sres.Select(r => $"{r.Item1}={r.Item2}{(r.Item3 is null ? "" : ":" + r.Item3)}")), "sd1=done");
    Same("...read as the drive's ORGANISER, a person - not the admin, not a group", string.Join(",", fake.SharedListedAs.Distinct()), "fin@techvein.local");
    Same("...into ORGANISATIONAL folders: Google Shared Drives/Finance/Q3",
        await Super("""
            WITH RECURSIVE p AS (
                SELECT id, name::text AS path FROM space.folders WHERE parent_folder_id IS NULL AND ownership_type = 'organisational' AND deleted_at IS NULL
                UNION ALL SELECT f.id, p.path || '/' || f.name FROM space.folders f JOIN p ON f.parent_folder_id = p.id
                 WHERE f.ownership_type = 'organisational' AND f.deleted_at IS NULL)
            SELECT string_agg(p.path || '/' || x.name || ' ' || x.ownership_type, ', ') FROM space.files x JOIN p ON p.id = x.folder_id WHERE x.name = 'budget.xlsx'
            """), "Google Shared Drives/Finance/Q3/budget.xlsx organisational");
    await using (var c = new NpgsqlConnection(appConn))
    {
        await c.OpenAsync();
        await new NpgsqlCommand($"SELECT set_config('app.tenant_id', '{TECHVEIN}', false), set_config('app.user_id', '{HR}', false)", c).ExecuteNonQueryAsync();
        Same("hr sees the organisation's file - it is not amit's",
            (await new NpgsqlCommand("SELECT count(*) FROM space.files WHERE name = 'budget.xlsx'", c).ExecuteScalarAsync())?.ToString(), "1");
    }
    var again = await source.WriteAsync(sjob, (await source.FetchAsync(sjob, CancellationToken.None)).Items[0], CancellationToken.None);
    Same("again: already in Space", again.Reason, "already in Space");
}
finally { Directory.Delete(blobRoot, true); }

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

sealed class OneAccount(GoogleServiceAccount a) : IGoogleCredentialProvider
{
    public Task<GoogleServiceAccount?> ForTenantAsync(Guid tenantId, CancellationToken ct) => Task.FromResult<GoogleServiceAccount?>(a);
}

// A fake Drive: My Drive (root0) > A > B, six files over three pages of two.
sealed class FakeDrive : HttpMessageHandler
{
    public readonly List<string> FolderLookups = [];
    /// <summary>Whose token listed the Finance shared drive's files.</summary>
    public readonly List<string> SharedListedAs = [];
    private readonly Dictionary<string, string> _tokens = [];
    static readonly Dictionary<string, (string Name, string? Parent)> Folders = new()
    {
        ["root0"] = ("My Drive", null), ["A"] = ("A", "root0"), ["B"] = ("B", "A"),
        ["SD1"] = ("Finance", null), ["Q3"] = ("Q3", "SD1"),
    };
    static readonly (string Id, string Name, string Mime, string Parent, string? Body)[] Files =
    [
        ("f1", "report.pdf", "application/pdf", "A", "HELLO"),
        ("f2", "photo.jpg", "image/jpeg", "B", "PHOTO!"),
        ("f3", "Plan", "application/vnd.google-apps.document", "A", null),
        ("f4", "notes.txt", "text/plain", "root0", "NOTE"),
        ("f5", "Survey", "application/vnd.google-apps.form", "root0", null),
        ("f6", "big.bin", "application/octet-stream", "root0", new string('x', 2000)),
    ];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        var q = req.RequestUri.Query;
        if (path == "/token")
        {
            var form = await req.Content!.ReadAsStringAsync(ct);
            var part = Uri.UnescapeDataString(form.Split("assertion=")[1].Split('&')[0]).Split('.')[1].Replace('-', '+').Replace('_', '/');
            var sub = JsonDocument.Parse(Convert.FromBase64String(part + new string('=', (4 - part.Length % 4) % 4))).RootElement.GetProperty("sub").GetString()!;
            var tok = $"ya29.fake{_tokens.Count}"; _tokens[tok] = sub;
            return await Json($$"""{"access_token":"{{tok}}","expires_in":3600}""");
        }
        var who = _tokens.GetValueOrDefault(req.Headers.Authorization?.Parameter ?? "") ?? "";
        if (path.EndsWith("/drives"))
            return await Json("""{"drives":[{"id":"SD1","name":"Finance"}]}""");
        if (path.EndsWith("/SD1/permissions"))
            return await Json("""{"permissions":[{"type":"group","role":"organizer","emailAddress":"all@techvein.local"},{"type":"user","role":"reader","emailAddress":"reader@techvein.local"},{"type":"user","role":"organizer","emailAddress":"fin@techvein.local"}]}""");
        if (path.EndsWith("/files") && q.Contains("driveId=SD1"))
        {
            SharedListedAs.Add(who);
            return await Json("""{"files":[{"id":"sd1","name":"budget.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","parents":["Q3"],"size":"7"}]}""");
        }
        if (path.EndsWith("/sd1") && q.Contains("alt=media"))
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.ASCII.GetBytes("BUDGET!")) };
        if (path.EndsWith("/files"))
        {
            var from = q.Contains("pageToken=") ? int.Parse(q.Split("pageToken=")[1].Split('&')[0]) : 0;
            var page = Files.Skip(from).Take(2).Select(f =>
                $$"""{"id":"{{f.Id}}","name":"{{f.Name}}","mimeType":"{{f.Mime}}","parents":["{{f.Parent}}"]{{(f.Body is null ? "" : $",\"size\":\"{f.Body.Length}\"")}}}""");
            var next = from + 2 < Files.Length ? $",\"nextPageToken\":\"{from + 2}\"" : "";
            return await Json($"{{\"files\":[{string.Join(",", page)}]{next}}}");
        }
        var id = path.Split('/')[^1];
        if (q.Contains("alt=media"))
        {
            var f = Files.Single(x => x.Id == id);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Encoding.ASCII.GetBytes(f.Body!)) };
        }
        FolderLookups.Add(id);
        var (name, parent) = Folders[id];
        return await Json($$"""{"id":"{{id}}","name":"{{name}}","mimeType":"application/vnd.google-apps.folder"{{(parent is null ? "" : $",\"parents\":[\"{parent}\"]")}}}""");
    }

    static Task<HttpResponseMessage> Json(string body) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
}
