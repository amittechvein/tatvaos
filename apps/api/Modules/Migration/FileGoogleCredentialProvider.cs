using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// TatvaOS's own Google service account, from a key FILE on the server
/// (decision 0019 §1, proposed), handed out only for an organisation whose
/// admin has granted it access.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE FILE. Migration:Google:KeyFile names it. It is mounted read-only into
///  the API container; it is NOT in the database, NOT in infra/docker/.env
///  (backup.sh copies .env verbatim beside the database dump - with the
///  settings-encryption key derived from it), and so not in any backup.
///  A file other accounts can read is refused, by name, with the chmod.
///  Unset = the migration cannot read Google at all; nothing else changes.
///
///  THE GRANT. ForTenantAsync returns the account only for an organisation
///  with an ACTIVE migration.grants row for THIS key's client ID. A grant
///  made for a previous key (rotated since) does not count: the customer
///  authorised a different client ID, and Google would refuse anyway.
///
///  EVERY USE IS LOGGED - organisation and service account, never the key -
///  which is design section 9's "audited per read" for a key that is read
///  once per page of a migration, not once per request.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class FileGoogleCredentialProvider(
    IConfiguration config,
    IServiceScopeFactory scopes,
    ILogger<FileGoogleCredentialProvider> log) : IGoogleCredentialProvider, IDisposable
{
    private readonly Lock _gate = new();
    private GoogleServiceAccount? _account;

    public static bool IsConfigured(IConfiguration config) =>
        !string.IsNullOrWhiteSpace(config["Migration:Google:KeyFile"]);

    /// <summary>The service account, loaded once. Throws, saying why, if the file is missing or unsafe.</summary>
    public GoogleServiceAccount Account
    {
        get
        {
            lock (_gate)
            {
                if (_account is not null) return _account;
                var path = config["Migration:Google:KeyFile"]
                           ?? throw new InvalidOperationException("Migration:Google:KeyFile is not set");
                if (!File.Exists(path))
                    throw new InvalidOperationException($"the Google key file named by Migration:Google:KeyFile does not exist ({path})");
                if (!OperatingSystem.IsWindows()
                    && (File.GetUnixFileMode(path) & (UnixFileMode.GroupRead | UnixFileMode.OtherRead | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) != 0)
                    throw new InvalidOperationException($"the Google key file can be read by other accounts on this machine; run: chmod 600 {path}");
                _account = GoogleServiceAccount.FromJson(File.ReadAllText(path));
                log.LogInformation("Google service account loaded: {Account}", _account.ClientEmail);
                return _account;
            }
        }
    }

    public async Task<GoogleServiceAccount?> ForTenantAsync(Guid tenantId, CancellationToken ct)
    {
        var account = Account;
        await using var scope = scopes.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<TenantContext>().EnterAnonymousScope(tenantId, "system");
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.SyncTenantAsync(ct);

        var granted = await db.MigrationGrants.AsNoTracking()
            .AnyAsync(g => g.Source == "google_workspace" && g.RevokedAt == null && g.ClientId == account.ClientId, ct);
        if (!granted)
        {
            log.LogWarning("Google access refused for organisation {TenantId}: no active grant for {Account}", tenantId, account.ClientEmail);
            return null;
        }
        log.LogInformation("Google access used for organisation {TenantId} as {Account}", tenantId, account.ClientEmail);
        return account;
    }

    public void Dispose() => _account?.Dispose();
}
