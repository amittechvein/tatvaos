using Microsoft.Extensions.Logging;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Migration.Mail;

/// <summary>
/// Signs in to a person's mailbox as Dovecot's migration MASTER user:
/// "person@domain*migration" with the master password (decision 0019 §2,
/// proposed). Dovecot checks the master password, then opens the person's
/// mailbox as if they had signed in - quota, folders and indexes all theirs.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE PASSWORD IS A FILE, never configuration text: Migration:Imap:
///  MasterPasswordFile names it, generated on the server straight into the
///  file (house rule 5) and mounted into the API. Unset or absent = this
///  class is not registered and the Gmail source is not either.
///
///  WHICH MAILBOX: the target person's OWN mailbox (type 'user', theirs, in
///  their organisation, read under RLS). A person with no mailbox has no
///  mail to migrate into, and the job says so rather than guessing.
///
///  Dovecot's side is the master passdb in local/dovecot/dovecot.conf (which
///  production mounts too): its one entry carries allow_nets, so the login is
///  refused from any network infra/scripts/migration-master.sh did not name.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MasterMailboxLogin(IConfiguration config, IServiceScopeFactory scopes) : IMigrationMailboxLogin
{
    /// <summary>
    /// The SETTING, not the file: migration-master.sh turns the login on and
    /// off by writing and emptying the file, and the API must not need a
    /// restart to follow. A missing file fails the page, saying so.
    /// </summary>
    public static bool IsConfigured(IConfiguration config) =>
        config["Migration:Imap:MasterPasswordFile"] is { Length: > 0 };

    /// <summary>
    /// What the API says about the master login at every start (decision 0019
    /// §2, Mr. Singh 10 Oct 2026): CRITICAL while its password file is
    /// non-empty, naming since when - the file's mtime, which
    /// migration-master.sh sets on "on" - and how to switch it off. One
    /// Information line otherwise, so the state is in the log either way. A
    /// guarantee that lives in a person's memory is not a guarantee; this and
    /// its cron twin, infra/scripts/migration-master-alert.sh, are the
    /// system noticing. Size and time only: the content is never read.
    /// </summary>
    public static (LogLevel Level, string Message) StartupReport(IConfiguration config, DateTimeOffset? now = null)
    {
        var path = config["Migration:Imap:MasterPasswordFile"];
        if (string.IsNullOrWhiteSpace(path))
            return (LogLevel.Information, "migration master login: not configured on this server (Migration:Imap:MasterPasswordFile is not set)");
        FileInfo f;
        try
        {
            f = new FileInfo(path);
            if (!f.Exists || f.Length == 0)
                return (LogLevel.Information, $"migration master login: off ({path} is empty or absent)");
        }
        catch (Exception ex)
        {
            return (LogLevel.Warning, $"migration master login: could not read {path} ({ex.GetType().Name}) - treat as unknown and check it by hand: infra/scripts/migration-master.sh status");
        }
        var since = new DateTimeOffset(f.LastWriteTimeUtc, TimeSpan.Zero);
        var days = (int)((now ?? DateTimeOffset.UtcNow) - since).TotalDays;
        return (LogLevel.Critical,
            $"MIGRATION MASTER LOGIN IS ON since {since:yyyy-MM-dd'T'HH:mm:ss'Z'} ({days} day(s)): a credential that can open ANY mailbox on this server. " +
            "It is for the days a migration runs. Switch it off when the migration is done: infra/scripts/migration-master.sh off");
    }

    public static void ReportAtStartup(IConfiguration config, ILogger log)
    {
        var (level, message) = StartupReport(config);
        log.Log(level, "{Message}", message);
    }

    private string MasterUser => config["Migration:Imap:MasterUser"] ?? "migration";

    public async Task<MailboxLogin> ForAsync(Guid tenantId, Guid targetUserId, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantContext>().EnterAnonymousScope(tenantId, "system");
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.SyncTenantAsync(ct);

        var address = await db.Mailboxes.AsNoTracking()
            .Where(m => m.UserId == targetUserId && m.Type == "user" && m.IsActive)
            .Select(m => m.Address).FirstOrDefaultAsync(ct)
            ?? throw new InvalidOperationException("this person has no active mailbox in TatvaOS to migrate mail into");

        var path = config["Migration:Imap:MasterPasswordFile"]
                   ?? throw new InvalidOperationException("Migration:Imap:MasterPasswordFile is not set");
        if (!File.Exists(path) || new FileInfo(path).Length == 0)
            throw new InvalidOperationException("the migration master login is off (infra/scripts/migration-master.sh on)");
        var password = (await File.ReadAllTextAsync(path, ct)).Trim();
        return new MailboxLogin(address, $"{address.ToLowerInvariant()}*{MasterUser}", password);
    }
}
