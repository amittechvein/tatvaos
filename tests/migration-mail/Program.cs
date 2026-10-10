using Microsoft.Extensions.Logging;
// ============================================================================
//  GMAIL INTO OUR DOVECOT: labels to folders, once, and safe to repeat
// ============================================================================
//
//  Migration design, phase 1 and section 5. A fake Gmail on one side (behind
//  the client's own HttpClient) and the REAL local Dovecot on the other, so
//  what is asserted is what an IMAP client would see:
//
//    * INBOX/SENT/TRASH/SPAM become INBOX/Sent/Trash/Junk; user labels become
//      folders, nested; a label named like a special folder goes under Labels/
//    * a message with three labels is APPENDED once and COPIED to the others
//    * an archived message (no label) lands in Archive; TRASH beats INBOX
//    * UNREAD -> no \Seen; STARRED -> \Flagged; Gmail's received time kept
//    * a second Gmail message with the same Message-ID is not appended again
//    * running the whole migration AGAIN changes nothing - the kill-and-resume
//      case, where a page is written twice
//
//  Needs the local stack (local/docker-compose.yml): Dovecot on
//  localhost:1143, the seeded mailbox amit@techvein.local with the
//  development password local/scripts/test-mail.sh uses. Everything goes
//  under one folder of its own (Migration:Mail:FolderRoot), deleted at the
//  end, pass or fail. Exit 0 pass, 1 fail, 2 could not run.
//
//  It drives the source page by page as MigrationJobRunner does, without the
//  runner's database ledger - the ledger is tests/migration/test-job-runner.sh's
//  subject. Here every message reaches Dovecot, so the APPEND-side checks are
//  the only thing between a re-run and a duplicate.
// ============================================================================

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using Microsoft.Extensions.Configuration;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Shared.Google;

var host = Environment.GetEnvironmentVariable("TATVAOS_IMAP_HOST") ?? "localhost";
var port = int.Parse(Environment.GetEnvironmentVariable("TATVAOS_IMAP_PORT") ?? "1143");
const string Person = "amit@techvein.local";
var password = Environment.GetEnvironmentVariable("MAIL_PASS") ?? "devpass123";
string? LastCursor = null;
var root = $"MigTest-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}-{Random.Shared.Next(1000, 9999)}";

var passed = 0; var failed = 0;
void Ok(string what) { passed++; Console.WriteLine($"  ok    {what}"); }
void Fail(string what) { failed++; Console.WriteLine($"  FAIL  {what}"); }
void Same<T>(string what, T got, T want)
{
    if (EqualityComparer<T>.Default.Equals(got, want)) Ok($"{what}  [got {got}]");
    else Fail($"{what} - got [{got}], wanted [{want}]");
}

Console.WriteLine($"\n  Gmail into Dovecot\n  Dovecot {host}:{port} as {Person}, under {root}/");

// ---- Pure: the label map and the Message-ID reader ---------------------------
Console.WriteLine("\n>> the label map");
var names = new Dictionary<string, string> { ["Label_1"] = "Clients/Acme", ["Label_2"] = "Invoices", ["Label_3"] = "Archive", ["Label_4"] = " /x// y/ " };
Same("order of labelIds does not change the APPEND folder",
    GmailLabelMap.Place(["Label_2", "INBOX", "Label_1"], names).Folders[0], "INBOX");
Same("three labels: one folder each, system first",
    string.Join(",", GmailLabelMap.Place(["Label_2", "INBOX", "Label_1"], names).Folders), "INBOX,Clients/Acme,Invoices");
Same("TRASH wins over everything", string.Join(",", GmailLabelMap.Place(["INBOX", "TRASH", "Label_1"], names).Folders), "Trash");
Same("no folder label: Archive", string.Join(",", GmailLabelMap.Place(["IMPORTANT", "CATEGORY_UPDATES"], names).Folders), "Archive");
Same("a label named like a special folder goes under Labels/", GmailLabelMap.FolderName("Archive"), "Labels/Archive");
Same("empty path parts are dropped", GmailLabelMap.FolderName(" /x// y/ "), "x/y");
Same("UNREAD: not seen; STARRED: flagged", string.Join(",", GmailLabelMap.Place(["INBOX", "UNREAD", "STARRED"], names).Flags), @"\Flagged");
Same("Message-ID read from the headers alone", GmailMailSource.MessageIdOf(Encoding.ASCII.GetBytes("Message-ID: <abc@x.test>\r\nSubject: s\r\n\r\nbody")), "abc@x.test");
Same("no Message-ID: null, not empty", GmailMailSource.MessageIdOf(Encoding.ASCII.GetBytes("Subject: s\r\n\r\nbody")), null);

Console.WriteLine("\n>> the startup report (decision 0019 §2: the system notices when the master login is left on)");
{
    var dir = Directory.CreateTempSubdirectory("mm-"); var pw = Path.Combine(dir.FullName, "master.password");
    IConfiguration Cfg(string? p) => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?> { ["Migration:Imap:MasterPasswordFile"] = p }).Build();
    Same("not configured: Information", MasterMailboxLogin.StartupReport(Cfg(null)).Level, LogLevel.Information);
    Same("configured but absent: Information, and it says off", MasterMailboxLogin.StartupReport(Cfg(pw)).Message.Contains("off"), true);
    File.WriteAllText(pw, "");
    Same("empty file (migration-master.sh off): Information", MasterMailboxLogin.StartupReport(Cfg(pw)).Level, LogLevel.Information);
    File.WriteAllText(pw, "not-a-real-secret"); File.SetLastWriteTimeUtc(pw, DateTime.UtcNow.AddDays(-4).AddMinutes(-5));
    var r = MasterMailboxLogin.StartupReport(Cfg(pw));
    Same("non-empty file: CRITICAL", r.Level, LogLevel.Critical);
    Same("...naming the age", r.Message.Contains("(4 day(s))"), true);
    Same("...and how to switch it off", r.Message.Contains("infra/scripts/migration-master.sh off"), true);
    Same("...never the content", r.Message.Contains("not-a-real-secret"), false);
    dir.Delete(true);
}

// ---- The real thing -----------------------------------------------------------
using var probe = new ImapClient();
try
{
    await probe.ConnectAsync(host, port, SecureSocketOptions.None);
    await probe.AuthenticateAsync(Person, password);
}
catch (Exception ex)
{
    Console.WriteLine($"\n  could not sign in to Dovecot at {host}:{port} ({ex.GetType().Name}: {ex.Message}) - is the local stack up?");
    return 2;
}

using var rsa = RSA.Create(2048);
using var account = GoogleServiceAccount.FromJson(JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["type"] = "service_account", ["client_email"] = "m@p.iam.gserviceaccount.com",
    ["private_key"] = rsa.ExportPkcs8PrivateKeyPem(), ["token_uri"] = "https://fake.test/token",
}));
var fake = new FakeGmail();
var http = new HttpClient(fake);
var api = new GoogleApi(http, new GoogleTokenSource(http), new GoogleEndpoints { Gmail = new("https://fake.test/gmail/v1/") },
    (_, _) => Task.CompletedTask);
var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Migration:Imap:Host"] = host, ["Migration:Imap:Port"] = port.ToString(),
    ["Migration:Mail:FolderRoot"] = root, ["Migration:Mail:PageSize"] = "4",
}).Build();
// MAIL_MASTER_FILE set: sign in the way production would (decision 0019 §2),
// as "amit@techvein.local*migration" with the master password from that file.
// tests/migration-mail/test-master-login.sh runs it so.
var masterFile = Environment.GetEnvironmentVariable("MAIL_MASTER_FILE");
var login = masterFile is { Length: > 0 }
    ? new OneLogin($"{Person}*migration", File.ReadAllText(masterFile).Trim())
    : new OneLogin(Person, password);
Console.WriteLine(masterFile is { Length: > 0 } ? "  signing in as the migration MASTER user" : "  signing in as the person");
var source = new GmailMailSource(new GmailClient(api), new OneAccount(account), login,
    new DovecotAppender(config), config);
var job = new MigrationJobView(Guid.NewGuid(), Guid.NewGuid(), "google_workspace", "mail", "alice@customer.test",
    Guid.NewGuid(), null, null, 0);

try
{
    Console.WriteLine("\n>> first run");
    var (first, total) = await RunAll(source, job);
    Same("Gmail's own count reached the job (items_total)", total, 8L);
    Same("written", first.Count(r => r.Outcome == "done"), 7);
    Same("skipped: the second message with m1's Message-ID", string.Join(",", first.Where(r => r.Outcome == "skipped").Select(r => r.Id)), "g6");
    Same("...because it is already there", first.Single(r => r.Id == "g6").Reason, "already in INBOX");
    Same("failed: none", first.Count(r => r.Outcome == "failed"), 0);

    var before = await Snapshot(probe);
    Same("INBOX: m1, m3, m7 (m5 went to Trash, m6 was not appended)", Ids(before, "INBOX"), "m1,m3,m7");
    Same("Sent: m2", Ids(before, "Sent"), "m2");
    Same("Clients/Acme: m3 (a COPY)", Ids(before, "Clients/Acme"), "m3");
    Same("Invoices: m3 (a COPY)", Ids(before, "Invoices"), "m3");
    Same("Archive: m4, which had no label", Ids(before, "Archive"), "m4");
    Same("Trash: m5, though it was also in INBOX", Ids(before, "Trash"), "m5");
    Same("Labels/Archive: m8, a user label named Archive", Ids(before, "Labels/Archive"), "m8");
    Same("m1 was UNREAD: no \\Seen", before["INBOX"]["m1"].Flags.HasFlag(MessageFlags.Seen), false);
    Same("m2 was read: \\Seen", before["Sent"]["m2"].Flags.HasFlag(MessageFlags.Seen), true);
    Same("m7 was STARRED: \\Flagged", before["INBOX"]["m7"].Flags.HasFlag(MessageFlags.Flagged), true);
    Same("m2 keeps Gmail's received time", before["Sent"]["m2"].Date, DateTimeOffset.FromUnixTimeMilliseconds(FakeGmail.Date("g2")));
    Same("the copy keeps the original's flags (m3 in Invoices: seen)", before["Invoices"]["m3"].Flags.HasFlag(MessageFlags.Seen), true);

    Console.WriteLine("\n>> the same migration again (a resumed job re-writing its pages)");
    var (second, _) = await RunAll(source, job);
    Same("written the second time", second.Count(r => r.Outcome == "done"), 0);
    Same("skipped the second time (all eight)", second.Count(r => r.Outcome == "skipped"), 8);
    var after = await Snapshot(probe);
    before["INBOX"]["m9"] = default;   // the one message the catch-up added
    Same("the full copy leaves the job at Gmail's history marker from BEFORE it began", LastCursor, "d:100");

    Console.WriteLine("\n>> catch-up: mail that arrived after the full copy");
    FakeGmail.Arrive("g9", "m9", ["INBOX"], historyBefore: "100", historyAfter: "120");
    FakeGmail.Arrive("g10", "m10", ["INBOX"], historyBefore: "100", historyAfter: "120", deletedBeforeFetch: true);
    var (catchUp, _, catchUpCursor) = await RunFrom(source, job, "d:100");
    Same("only what was added: g9 written, g10 (deleted since) skipped by name",
        string.Join(",", catchUp.Select(r => $"{r.Id}={r.Outcome}:{r.Reason}")), "g9=done:,g10=skipped:no longer in Gmail");
    Same("...the job now holds the newer marker", catchUpCursor, "d:120");
    Same("...m9 is in INBOX", Ids(await Snapshot(probe), "INBOX"), "m1,m3,m7,m9");
    var (stale, _, staleCursor) = await RunFrom(source, job, "d:1");
    Same("history too old (Google 404s): falls back to a full listing that writes nothing",
        stale.Count(r => r.Outcome == "done"), 0);
    Same("...and re-reads Gmail's marker", staleCursor, "d:120");
    after = await Snapshot(probe);

    Same("no folder gained or lost a message",
        string.Join(";", after.OrderBy(k => k.Key).Select(k => $"{k.Key}={k.Value.Count}")),
        string.Join(";", before.OrderBy(k => k.Key).Select(k => $"{k.Key}={k.Value.Count}")));
}
finally
{
    await source.DisposeAsync();
    // A FRESH connection, with nothing selected: Dovecot drops a connection
    // whose selected folder is deleted under it. Removes this run's folder and
    // any a killed earlier run left behind.
    using var cleaner = new ImapClient();
    await cleaner.ConnectAsync(host, port, SecureSocketOptions.None);
    await cleaner.AuthenticateAsync(Person, password);
    var top = await cleaner.GetFolderAsync(cleaner.PersonalNamespaces[0].Path);
    foreach (var f in (await top.GetSubfoldersAsync(false)).Where(f => f.Name.StartsWith("MigTest-")))
    {
        await DeleteTree(cleaner, f.FullName);
        Console.WriteLine($"\n  removed {f.Name}/");
    }
    await cleaner.DisconnectAsync(true);
}

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

// Drive the source as the runner does: fetch a page, write each item, move the cursor.
async Task<(List<(string Id, string Outcome, string? Reason)>, long?)> RunAll(GmailMailSource s, MigrationJobView j)
{
    var (results, total, cursor) = await RunFrom(s, j, null);
    LastCursor = cursor;
    return (results, total);
}

// As the runner does: from a cursor, page by page, to the last page; the
// cursor the job is left holding is returned (the runner stores it).
async Task<(List<(string Id, string Outcome, string? Reason)>, long?, string?)> RunFrom(GmailMailSource s, MigrationJobView j, string? cursor)
{
    var results = new List<(string, string, string?)>();
    long? total = null;
    j = j with { Cursor = cursor };
    while (true)
    {
        var page = await s.FetchAsync(j, CancellationToken.None);
        total ??= page.ItemsTotal;
        foreach (var item in page.Items)
        {
            var r = await s.WriteAsync(j, item, CancellationToken.None);
            results.Add((item.SourceId, r.Outcome, r.Reason));
        }
        if (page.IsLast) return (results, total, page.NextCursor);
        j = j with { Cursor = page.NextCursor };
    }
}

// Folder (relative to root) -> Message-ID stem -> its flags and internal date.
async Task<Dictionary<string, Dictionary<string, (MessageFlags Flags, DateTimeOffset? Date)>>> Snapshot(ImapClient c)
{
    var result = new Dictionary<string, Dictionary<string, (MessageFlags, DateTimeOffset?)>>();
    var ns = c.PersonalNamespaces[0];
    var top = await c.GetFolderAsync(root);
    async Task Walk(IMailFolder f, string rel)
    {
        await f.OpenAsync(FolderAccess.ReadOnly);
        var msgs = new Dictionary<string, (MessageFlags, DateTimeOffset?)>();
        foreach (var s in await f.FetchAsync(0, -1, MessageSummaryItems.Envelope | MessageSummaryItems.Flags | MessageSummaryItems.InternalDate))
        {
            // A duplicate gets its own key ("m1#2"), never overwrites: keyed
            // by Message-ID alone, two copies counted as one and the "no
            // folder gained a message" check stayed green while every message
            // was appended twice (found by calibrating this test).
            var stem = (s.Envelope?.MessageId ?? "(none)").Split('@')[0];
            var key = stem;
            for (var n = 2; msgs.ContainsKey(key); n++) key = $"{stem}#{n}";
            msgs[key] = (s.Flags ?? MessageFlags.None, s.InternalDate);
        }
        if (rel.Length > 0) result[rel] = msgs;
        foreach (var sub in await f.GetSubfoldersAsync(false))
            await Walk(sub, rel.Length == 0 ? sub.Name : $"{rel}{ns.DirectorySeparator}{sub.Name}");
    }
    foreach (var sub in await top.GetSubfoldersAsync(false)) await Walk(sub, sub.Name);
    return result;
}

static string Ids(Dictionary<string, Dictionary<string, (MessageFlags, DateTimeOffset?)>> snap, string folder) =>
    snap.TryGetValue(folder, out var m) ? string.Join(",", m.Keys.Order()) : "(no folder)";

static async Task DeleteTree(ImapClient c, string path)
{
    try
    {
        var f = await c.GetFolderAsync(path);
        foreach (var sub in await f.GetSubfoldersAsync(false)) await DeleteTree(c, sub.FullName);
        await f.UnsubscribeAsync();
        await f.DeleteAsync();
    }
    catch (FolderNotFoundException) { }
}

sealed class OneAccount(GoogleServiceAccount a) : IGoogleCredentialProvider
{
    public Task<GoogleServiceAccount?> ForTenantAsync(Guid tenantId, CancellationToken ct) => Task.FromResult<GoogleServiceAccount?>(a);
}

sealed class OneLogin(string user, string password) : IMigrationMailboxLogin
{
    public Task<MailboxLogin> ForAsync(Guid tenantId, Guid targetUserId, CancellationToken ct) =>
        Task.FromResult(new MailboxLogin(user.Split('*')[0], user, password));
}

// A fake Gmail: eight messages over two pages of four, raw, with labels.
sealed class FakeGmail : HttpMessageHandler
{
    // Gmail id -> (Message-ID stem, labelIds)
    static readonly (string Id, string Mid, string[] Labels)[] Messages =
    [
        ("g1", "m1", ["INBOX", "UNREAD"]),
        ("g2", "m2", ["SENT"]),
        ("g3", "m3", ["INBOX", "Label_1", "Label_2"]),
        ("g4", "m4", []),
        ("g5", "m5", ["INBOX", "TRASH"]),
        ("g6", "m1", ["INBOX"]),
        ("g7", "m7", ["INBOX", "STARRED", "CATEGORY_PROMOTIONS"]),
        ("g8", "m8", ["Label_3"]),
    ];
    public static long Date(string id) => 1_700_000_000_000L + int.Parse(id[1..]) * 86_400_000L;
    static string History = "100";
    static readonly List<(string Id, string Mid, string[] Labels, string Before, bool Gone)> Arrived = [];
    /// <summary>A message delivered to Gmail after the full copy began.</summary>
    public static void Arrive(string id, string mid, string[] labels, string historyBefore, string historyAfter, bool deletedBeforeFetch = false)
    {
        Arrived.Add((id, mid, labels, historyBefore, deletedBeforeFetch));
        History = historyAfter;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        var query = req.RequestUri.Query;
        if (path == "/token") return Json("""{"access_token":"ya29.fake","expires_in":3600}""");
        if (path.EndsWith("/profile")) return Json($$"""{"emailAddress":"alice@customer.test","messagesTotal":8,"historyId":"{{History}}"}""");
        if (path.EndsWith("/history"))
        {
            var since = query.Split("startHistoryId=")[1].Split('&')[0];
            if (since == "1") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
                { Content = new StringContent("""{"error":{"code":404,"message":"Requested entity was not found.","errors":[{"reason":"notFound"}]}}""") });
            var added = Arrived.Where(a => a.Before == since).Select(a => $$$"""{"messagesAdded":[{"message":{"id":"{{{a.Id}}}"}}]}""");
            return Json($$"""{"history":[{{string.Join(",", added)}}],"historyId":"{{History}}"}""");
        }
        if (path.EndsWith("/labels"))
            return Json("""{"labels":[{"id":"INBOX","name":"INBOX","type":"system"},{"id":"Label_1","name":"Clients/Acme","type":"user"},{"id":"Label_2","name":"Invoices","type":"user"},{"id":"Label_3","name":"Archive","type":"user"}]}""");
        if (path.EndsWith("/messages"))
        {
            var second = query.Contains("pageToken=p2");
            var ids = Messages.Skip(second ? 4 : 0).Take(4).Select(m => $$"""{"id":"{{m.Id}}"}""");
            return Json($$"""{"messages":[{{string.Join(",", ids)}}]{{(second ? "" : ",\"nextPageToken\":\"p2\"")}},"resultSizeEstimate":8}""");
        }
        var id = path.Split('/')[^1];
        if (Arrived.FirstOrDefault(a => a.Id == id) is { Id: not null } late)
        {
            if (late.Gone) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
                { Content = new StringContent("""{"error":{"code":404,"message":"Requested entity was not found.","errors":[{"reason":"notFound"}]}}""") });
            var lraw = $"Message-ID: <{late.Mid}@customer.test>\r\nFrom: someone@else.test\r\nSubject: late {late.Id}\r\n\r\nLate.\r\n";
            var lb64 = Convert.ToBase64String(Encoding.ASCII.GetBytes(lraw)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return Json($$"""{"id":"{{id}}","labelIds":[{{string.Join(",", late.Labels.Select(l => $"\"{l}\""))}}],"internalDate":"{{Date("g1")}}","raw":"{{lb64}}"}""");
        }
        var msg = Messages.Single(m => m.Id == id);
        var raw = $"Message-ID: <{msg.Mid}@customer.test>\r\nFrom: someone@else.test\r\nTo: alice@customer.test\r\n" +
                  $"Subject: migration test {msg.Id}\r\nDate: Tue, 14 Nov 2023 10:00:00 +0000\r\n\r\nBody of {msg.Id}.\r\n";
        var b64 = Convert.ToBase64String(Encoding.ASCII.GetBytes(raw)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var labels = string.Join(",", msg.Labels.Select(l => $"\"{l}\""));
        return Json($$"""{"id":"{{id}}","labelIds":[{{labels}}],"internalDate":"{{Date(id)}}","raw":"{{b64}}"}""");
    }

    static Task<HttpResponseMessage> Json(string body) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
}
