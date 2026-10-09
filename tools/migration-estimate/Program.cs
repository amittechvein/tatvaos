// ============================================================================
//  migration-estimate: how much a Google Workspace would bring, and whether
//  it fits. Measures; migrates nothing.
// ============================================================================
//
//  Migration design, section 11, week one: "Build the size estimate ...
//  One screen, real numbers, nothing migrated. It proves the Google client
//  works end to end." This is that, before there is a screen: a command run
//  by a person, against a Google account whose admin has granted delegation.
//
//    dotnet run --project tools/migration-estimate -- \
//        --key ~/keys/migration-test.json --admin admin@customer.example \
//        [--disk /var/mail/vhosts] [--space-disk /var/lib/space/blobs] \
//        [--mail-left-gib N] [--space-left-gib N] [--per-user-quota-gib N]
//
//  THE KEY (design section 9 - where a key may REST goes to Mr. Singh first).
//  This reads it from the file named, into memory, for the length of the run,
//  and stores it nowhere. It refuses a key file that is:
//    * inside a git working tree - one `git add .` from being committed; or
//    * readable by anyone but its owner (chmod 600) - on a shared machine
//      that is a key handed to every account on it.
//  It never prints the key; it prints the service account's address.
//
//  WHAT IT CANNOT KNOW from a laptop: the organisation's own storage (that
//  is in the database). Pass it with --mail-left-gib / --space-left-gib, or
//  the verdict says "not checked" and stays incomplete - never "fits".
//  --disk defaults to the current directory, and the output names the path
//  and the machine, so a laptop's disk is never mistaken for the server's.
//
//  Exit: 0 fits, 1 refused or incomplete, 2 could not run.
// ============================================================================

using System.Diagnostics;
using System.Globalization;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Shared.Google;

var opts = ParseArgs(args);
if (opts is null)
{
    Console.Error.WriteLine("usage: migration-estimate --key <service-account.json> --admin <admin@domain> " +
                            "[--disk <path>] [--space-disk <path>] [--mail-left-gib N] [--space-left-gib N] [--per-user-quota-gib N]");
    return 2;
}

var keyPath = Path.GetFullPath(Environment.ExpandEnvironmentVariables(
    opts["key"].StartsWith("~/") ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), opts["key"][2..]) : opts["key"]));
if (!File.Exists(keyPath)) { Console.Error.WriteLine($"no key file at {keyPath}"); return 2; }
if (InsideGitWorkTree(keyPath) is string repo)
{
    Console.Error.WriteLine($"refusing: the key file is inside the git working tree {repo}. Move it outside any repository.");
    return 2;
}
if (!OperatingSystem.IsWindows())
{
    var mode = File.GetUnixFileMode(keyPath);
    if ((mode & (UnixFileMode.GroupRead | UnixFileMode.OtherRead | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) != 0)
    {
        Console.Error.WriteLine($"refusing: the key file can be read by other accounts on this machine. Run: chmod 600 \"{keyPath}\"");
        return 2;
    }
}

GoogleServiceAccount account;
try { account = GoogleServiceAccount.FromJson(await File.ReadAllTextAsync(keyPath)); }
catch (GoogleKeyFormatException ex) { Console.Error.WriteLine($"the key file cannot be used: {ex.Message}"); return 2; }

using (account)
{
    var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
    var api = new GoogleApi(http, new GoogleTokenSource(http));
    var estimator = new MigrationSizeEstimator(new GoogleWorkspaceClient(api));

    Console.WriteLine($"\n  Google Workspace size estimate - {DateTimeOffset.UtcNow:yyyy-MM-dd HH:mm} UTC");
    Console.WriteLine($"  as {account.ClientEmail}, listing people as {opts["admin"]}\n");

    MigrationSizeReport report;
    try { report = await estimator.MeasureAsync(account, opts["admin"], CancellationToken.None); }
    catch (Exception ex) when (ex is GoogleAuthException or GoogleApiException or GoogleScopeRefusedException)
    {
        Console.Error.WriteLine($"  could not list the domain's people: {ex.Message}");
        return 2;
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        Console.Error.WriteLine($"  could not reach Google ({ex.GetType().Name}: {ex.Message})");
        return 2;
    }

    var width = Math.Max(20, report.People.Select(p => p.Email.Length).DefaultIfEmpty(0).Max());
    Console.WriteLine($"  {"person".PadRight(width)}  {"mail*",10}  {"drive",10}");
    foreach (var p in report.People)
        Console.WriteLine($"  {p.Email.PadRight(width)}  {MigrationFit.Size(p.MailBytes),10}  {MigrationFit.Size(p.DriveBytes),10}");
    Console.WriteLine($"  {new string('-', width)}  {"----------",10}  {"----------",10}");
    Console.WriteLine($"  {$"{report.People.Count} people".PadRight(width)}  {MigrationFit.Size(report.MailBytes),10}  {MigrationFit.Size(report.DriveBytes),10}");
    Console.WriteLine("  * mail includes Google Photos (an over-estimate); Google Docs/Sheets count as nothing in Google's");
    Console.WriteLine("    quota but arrive as .docx/.xlsx files, so the Drive column under-counts them.");

    foreach (var n in report.NotMigrated) Console.WriteLine($"  not migrated: {n.Email} ({n.Reason})");
    foreach (var n in report.Unmeasured) Console.WriteLine($"  UNMEASURED:   {n.Email} ({n.Reason})");

    var mailDisk = DiskFigures.Of(opts.GetValueOrDefault("disk", "."));
    var spaceDisk = DiskFigures.Of(opts.GetValueOrDefault("space-disk", opts.GetValueOrDefault("disk", ".")));
    Console.WriteLine($"\n  disk measured on {Environment.MachineName}:");
    Console.WriteLine($"    mail   {Path.GetFullPath(mailDisk.Path)}: {MigrationFit.Size(mailDisk.FreeBytes)} free of {MigrationFit.Size(mailDisk.TotalBytes)}");
    Console.WriteLine($"    Space  {Path.GetFullPath(spaceDisk.Path)}: {MigrationFit.Size(spaceDisk.FreeBytes)} free of {MigrationFit.Size(spaceDisk.TotalBytes)}");

    var verdict = MigrationFit.Judge(report, mailDisk, spaceDisk,
        Left(opts, "mail-left-gib"), Left(opts, "space-left-gib"),
        opts.TryGetValue("per-user-quota-gib", out var q) ? Gib(q) : null);

    Console.WriteLine($"\n  VERDICT: {verdict.State.ToUpperInvariant()}");
    foreach (var r in verdict.Reasons) Console.WriteLine($"    - {r}");
    Console.WriteLine();
    return verdict.State == "fits" ? 0 : 1;
}

static StorageAllocator.Capacity? Left(Dictionary<string, string> o, string name) =>
    o.TryGetValue(name, out var v) && Gib(v) is long left
        ? new StorageAllocator.Capacity("given", left, 0, left, 0, false, false, 0, null, true, "given on the command line")
        : null;

static long? Gib(string s) =>
    double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var g) && g >= 0
        ? (long)(g * 1024 * 1024 * 1024) : null;

static Dictionary<string, string>? ParseArgs(string[] a)
{
    var o = new Dictionary<string, string>();
    for (var i = 0; i + 1 < a.Length; i += 2)
    {
        if (!a[i].StartsWith("--")) return null;
        o[a[i][2..]] = a[i + 1];
    }
    if (a.Length % 2 != 0) return null;
    return o.ContainsKey("key") && o.ContainsKey("admin") ? o : null;
}

static string? InsideGitWorkTree(string file)
{
    try
    {
        var psi = new ProcessStartInfo("git", ["-C", Path.GetDirectoryName(file)!, "rev-parse", "--show-toplevel"])
            { RedirectStandardOutput = true, RedirectStandardError = true };
        using var p = Process.Start(psi)!;
        var top = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit();
        return p.ExitCode == 0 && top.Length > 0 ? top : null;
    }
    catch { return null; }   // no git on PATH: nothing to be inside
}
