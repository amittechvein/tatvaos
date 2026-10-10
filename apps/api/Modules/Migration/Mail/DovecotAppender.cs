using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MailKit.Security;
using MimeKit;

namespace TatvaOS.Api.Modules.Migration.Mail;

/// <summary>
/// Puts one migrated message into a person's mailbox in OUR Dovecot, over
/// IMAP, as that person (migration design, section 2).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY IMAP AND NOT THE MAILDIR. MaildirIngestWorker mounts the maildir
///  read-only on purpose: "one writer per store, and Dovecot is the
///  maildir's." Appending through Dovecot inherits its delivery path, its
///  indexes, quota and the ingest worker's indexing for free; a second
///  writer to a mail store is how mailboxes get corrupted.
///
///  SAFE TO REPEAT (IMigrationSource's contract). The runner re-runs the page
///  a killed process was on, so the same message can arrive here twice.
///  Before APPEND the target folder is searched for the message's
///  Message-ID; if it is there, nothing is appended. The same check runs
///  before each COPY into the message's other folders. A message with no
///  Message-ID cannot be checked this way and is appended - the job's ledger
///  still stops it in every case but the page in flight at a kill.
///
///  HOW IT SIGNS IN: IMigrationMailboxLogin supplies the credentials -
///  MasterMailboxLogin, Dovecot's migration master user (decision 0019 §2).
///  OVER TLS in production (STARTTLS on 143, Migration:Imap:Security), the
///  certificate checked against Migration:Imap:TlsName.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class DovecotAppender(IConfiguration config)
{
    private string Host => config["Migration:Imap:Host"] ?? "dovecot";
    private int Port => config.GetValue("Migration:Imap:Port", 143);
    /// <summary>
    /// "none" for the local stack (its Dovecot has ssl = no); "starttls" in
    /// production and staging, whose Dovecot has disable_plaintext_auth = yes
    /// and refuses any sign-in before TLS (local/dovecot/entrypoint.sh). The
    /// compose file sets it; "ssl" is TLS from the first byte (993).
    /// </summary>
    private SecureSocketOptions Security => (config["Migration:Imap:Security"] ?? "none").ToLowerInvariant() switch
    {
        "ssl" => SecureSocketOptions.SslOnConnect,
        "starttls" => SecureSocketOptions.StartTls,
        _ => SecureSocketOptions.None,
    };

    /// <summary>
    /// The name on Dovecot's certificate (mail.tatvaos.com: deploy.sh copies
    /// Caddy's mail.* certificate into the mailcerts volume). The API reaches
    /// Dovecot by its compose name, "dovecot", which is not on the certificate,
    /// so the certificate is checked against THIS name instead - see
    /// <see cref="CertificateIsTrusted"/>. Unset = the host name, as usual.
    /// </summary>
    private string? TlsName => config["Migration:Imap:TlsName"] is { Length: > 0 } n ? n : null;

    /// <summary>
    /// A certificate is accepted when it is valid in every way, or when its
    /// ONLY fault is a name mismatch and it is valid for <paramref name="tlsName"/>.
    /// An untrusted chain, an expired certificate or a different name is
    /// refused - TLS is not switched off, only pointed at the right name.
    /// </summary>
    public static bool CertificateIsTrusted(
        System.Security.Cryptography.X509Certificates.X509Certificate? cert,
        System.Net.Security.SslPolicyErrors errors, string? tlsName)
    {
        if (errors == System.Net.Security.SslPolicyErrors.None) return true;
        if (tlsName is null || cert is null
            || errors != System.Net.Security.SslPolicyErrors.RemoteCertificateNameMismatch) return false;
        using var c2 = new System.Security.Cryptography.X509Certificates.X509Certificate2(cert);
        return c2.MatchesHostname(tlsName);
    }
    /// <summary>
    /// Optional parent for every migrated folder, e.g. "Imported from Google".
    /// Empty (the default) puts INBOX in INBOX. Tests use it to keep to a
    /// folder of their own.
    /// </summary>
    private string FolderRoot => (config["Migration:Mail:FolderRoot"] ?? "").Trim('/');

    public async Task<DovecotSession> OpenAsync(MailboxLogin login, CancellationToken ct)
    {
        var client = new ImapClient();
        var tlsName = TlsName;
        if (Security != SecureSocketOptions.None)
            client.ServerCertificateValidationCallback = (_, cert, _, errors) => CertificateIsTrusted(cert, errors, tlsName);
        try
        {
            await client.ConnectAsync(Host, Port, Security, ct);
            await client.AuthenticateAsync(login.UserName, login.Password, ct);
            return new DovecotSession(client, FolderRoot);
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }
}

/// <summary>Credentials to open one person's mailbox. Never logged; ToString shows the address only.</summary>
public sealed record MailboxLogin(string Address, string UserName, string Password)
{
    public override string ToString() => $"mailbox login for {Address}";
}

/// <summary>Who supplies <see cref="MailboxLogin"/> for a job's target person. See DovecotAppender.</summary>
public interface IMigrationMailboxLogin
{
    Task<MailboxLogin> ForAsync(Guid tenantId, Guid targetUserId, CancellationToken ct);
}

public sealed class DovecotSession(ImapClient client, string folderRoot) : IAsyncDisposable
{
    private readonly Dictionary<string, IMailFolder> _folders = new(StringComparer.Ordinal);

    public bool IsConnected => client.IsConnected && client.IsAuthenticated;

    /// <summary>
    /// The message into its first folder (APPEND) and the rest (COPY), with its
    /// flags and Gmail's received time. Returns the bytes appended - 0 when it
    /// was already there.
    /// </summary>
    public async Task<long> PutAsync(byte[] raw, GmailPlacement placement, DateTimeOffset? receivedAt, CancellationToken ct)
    {
        using var stream = new MemoryStream(raw, writable: false);
        var message = await MimeMessage.LoadAsync(stream, ct);
        var messageId = message.MessageId;

        var first = await FolderAsync(placement.Folders[0], ct);
        await first.OpenAsync(FolderAccess.ReadWrite, ct);
        var uid = messageId is null ? null : await FindAsync(first, messageId, ct);
        long appended = 0;
        if (uid is null)
        {
            var flags = MessageFlags.None;
            foreach (var f in placement.Flags)
                flags |= f switch { @"\Seen" => MessageFlags.Seen, @"\Flagged" => MessageFlags.Flagged, @"\Draft" => MessageFlags.Draft, _ => MessageFlags.None };
            var request = new AppendRequest(message, flags) { InternalDate = receivedAt };
            uid = await first.AppendAsync(request, ct);
            appended = raw.LongLength;
            // Dovecot answers APPEND with UIDPLUS, so the uid is known. If a
            // server ever does not, find it again rather than skip the copies.
            uid ??= messageId is null ? null : await FindAsync(first, messageId, ct);
        }

        foreach (var name in placement.Folders.Skip(1))
        {
            var target = await FolderAsync(name, ct);
            if (messageId is not null)
            {
                await target.OpenAsync(FolderAccess.ReadOnly, ct);
                if (await FindAsync(target, messageId, ct) is not null) continue;
                await first.OpenAsync(FolderAccess.ReadWrite, ct);
            }
            if (uid is UniqueId u) await first.CopyToAsync(u, target, ct);
            else
            {
                // No uid and no Message-ID: append to this folder too. Costs
                // the bytes again, which is better than a message missing
                // from a folder the person filed it in.
                await target.AppendAsync(new AppendRequest(message, MessageFlags.Seen) { InternalDate = receivedAt }, ct);
            }
        }
        return appended;
    }

    private static async Task<UniqueId?> FindAsync(IMailFolder folder, string messageId, CancellationToken ct)
    {
        var hits = await folder.SearchAsync(SearchQuery.HeaderContains("Message-ID", $"<{messageId}>"), ct);
        return hits.Count > 0 ? hits[0] : null;
    }

    private async Task<IMailFolder> FolderAsync(string name, CancellationToken ct)
    {
        var path = folderRoot.Length == 0 ? name : $"{folderRoot}/{name}";
        if (_folders.TryGetValue(path, out var known)) return known;

        IMailFolder folder;
        if (string.Equals(path, "INBOX", StringComparison.OrdinalIgnoreCase)) folder = client.Inbox;
        else
        {
            var ns = client.PersonalNamespaces[0];
            folder = await client.GetFolderAsync(ns.Path, ct);   // the namespace root
            foreach (var part in path.Split(ns.DirectorySeparator))
            {
                var subs = await folder.GetSubfoldersAsync(false, ct);
                var next = subs.FirstOrDefault(s => s.Name == part);
                if (next is null)
                {
                    next = await folder.CreateAsync(part, true, ct)
                           ?? throw new InvalidOperationException($"Dovecot did not create the folder {path}");
                    await next.SubscribeAsync(ct);
                }
                folder = next;
            }
        }
        _folders[path] = folder;
        return folder;
    }

    public async ValueTask DisposeAsync()
    {
        try { if (client.IsConnected) await client.DisconnectAsync(true); }
        catch { /* the connection is going either way */ }
        client.Dispose();
    }
}
