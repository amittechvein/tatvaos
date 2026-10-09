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
