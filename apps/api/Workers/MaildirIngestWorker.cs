using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Indexes delivered mail into mail.messages, so the webmail can read it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS. Postfix hands inbound mail to Dovecot over LMTP, and
///  Dovecot writes a maildir. That path is battle-tested, it is what the
///  SMTP unblock ticket described to Linode, and IMAP clients depend on it —
///  so it is not touched. But the webmail reads mail.messages, and nothing
///  wrote that table. This worker closes the gap: it watches the maildir
///  (the vmail volume, mounted READ-ONLY into the api container) and indexes
///  every new file into Postgres.
///
///  The maildir stays canonical for delivery; the database row carries the
///  raw copy for the client. The worker never writes to the maildir — one
///  writer per store, and Dovecot is the maildir's.
///
///  KNOWN LIMIT, on purpose: webmail actions (read, move, delete) do not
///  write back to the maildir, so an IMAP client sees delivery state, not
///  webmail state. Acceptable while webmail is the only client anyone uses;
///  becomes a real sync problem the day IMAP is offered — solve it then,
///  with Dovecot's doveadm or JMAP, not by teaching this worker to write.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MaildirIngestWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<MaildirIngestWorker> log) : BackgroundService
{
    /// <summary>
    /// Files that failed to parse or index. Remembered so one poisoned
    /// message logs once instead of every five seconds forever.
    /// </summary>
    private readonly HashSet<string> _failed = [];

    private bool _warnedMissingRoot;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var root = config["Mail:VmailRoot"] ?? "/var/mail/vhosts";
        var interval = TimeSpan.FromSeconds(
            int.TryParse(config["Mail:IngestIntervalSeconds"], out var s) ? Math.Max(2, s) : 5);

        log.LogInformation("Maildir ingest watching {Root} every {Interval}s",
            root, interval.TotalSeconds);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await ScanAsync(root, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // The worker must outlive any single bad cycle. A database
                // restart mid-scan is routine, not fatal.
                log.LogWarning(ex, "Ingest cycle failed; retrying next interval");
            }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ScanAsync(string root, CancellationToken ct)
    {
        if (!Directory.Exists(root))
        {
            // Normal when running the API bare on a dev machine with no mail
            // stack. Say it once, then stay quiet.
            if (!_warnedMissingRoot)
            {
                log.LogInformation("Vmail root {Root} does not exist; ingest idle", root);
                _warnedMissingRoot = true;
            }
            return;
        }
        _warnedMissingRoot = false;

        // vhosts/{domain}/{localpart}/(new|cur)/{file}
        foreach (var domainDir in Directory.EnumerateDirectories(root))
        {
            var domain = Path.GetFileName(domainDir);
            foreach (var boxDir in Directory.EnumerateDirectories(domainDir))
            {
                var localPart = Path.GetFileName(boxDir);
                // Maildir++ subfolders (.Sent, .Junk…) are Dovecot's own
                // filing; only the root — the INBOX — is delivery.
                if (localPart.StartsWith('.')) continue;

                var files = EnumerateMessageFiles(boxDir).ToList();
                if (files.Count == 0) continue;

                await IngestMailboxAsync($"{localPart}@{domain}", domain, localPart, files, ct);
            }
        }
    }

    /// <summary>
    /// Message files in new/ and cur/. The key strips Dovecot's ":2,flags"
    /// suffix — the base name is assigned once at delivery and never changes,
    /// while the flags change every time an IMAP client touches the message.
    /// Keying on the full name would re-ingest a message each time it was
    /// read somewhere.
    /// </summary>
    private static IEnumerable<(string Key, string Path)> EnumerateMessageFiles(string boxDir)
    {
        foreach (var sub in new[] { "new", "cur" })
        {
            var dir = Path.Combine(boxDir, sub);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.EnumerateFiles(dir))
            {
                var name = Path.GetFileName(file);
                var colon = name.IndexOf(':');
                yield return (colon >= 0 ? name[..colon] : name, file);
            }
        }
    }

    private async Task IngestMailboxAsync(
        string address, string domain, string localPart,
        List<(string Key, string Path)> files, CancellationToken ct)
    {
        // One scope per mailbox: TenantContext and DbContext are scoped, and
        // SaveChanges stamps TenantId from the CURRENT tenant — so the save
        // happens before the loop ever moves to another tenant's mailbox.
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        // mail.mailboxes carries no RLS (the mail edge reads it to route), so
        // this cross-tenant lookup is by design. Everything after it is
        // scoped to the mailbox's own tenant.
        var box = await db.Mailboxes.IgnoreQueryFilters()
            .FirstOrDefaultAsync(m => m.Address == address, ct);
        if (box is null) return; // a maildir with no mailbox row — not ours to invent

        tenant.EnterPlatformScope(box.TenantId, actingUserId: box.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);

        var keys = files.Select(f => $"{domain}/{localPart}/{f.Key}").ToList();
        var known = (await db.Messages
                .Where(m => m.MailboxId == box.Id && m.BlobKey != null && keys.Contains(m.BlobKey))
                .Select(m => m.BlobKey!)
                .ToListAsync(ct))
            .ToHashSet();

        var inbox = await db.Folders.FirstOrDefaultAsync(
            f => f.MailboxId == box.Id && f.SpecialUse == "\\Inbox", ct);
        if (inbox is null)
        {
            log.LogWarning("Mailbox {Address} has no Inbox folder; skipping ingest", address);
            return;
        }

        var added = 0;
        foreach (var (key, path) in files)
        {
            var blobKey = $"{domain}/{localPart}/{key}";
            if (known.Contains(blobKey) || _failed.Contains(blobKey)) continue;

            try
            {
                var info = new FileInfo(path);
                var rawBytes = await File.ReadAllBytesAsync(path, ct);
                var raw = MailContent.RawEncoding.GetString(rawBytes);
                var mime = MailContent.Parse(raw);

                var (fromName, fromAddr) = MailContent.FirstFrom(mime);
                var attachments = MailContent.AttachmentParts(mime);

                var message = new Message
                {
                    TenantId = box.TenantId,
                    MailboxId = box.Id,
                    FolderId = inbox.Id,
                    ImapUid = inbox.UidNext,
                    MessageIdHeader = string.IsNullOrEmpty(mime.MessageId) ? null : mime.MessageId,
                    FromAddr = Truncate(fromAddr, 320),
                    FromName = Truncate(fromName, 320),
                    ToAddrs = MailContent.Addresses(mime.To),
                    CcAddrs = mime.Cc.Count > 0 ? MailContent.Addresses(mime.Cc) : null,
                    Subject = Truncate(mime.Subject, 1000),
                    Snippet = MailContent.Snippet(mime),
                    SentAt = mime.Date == DateTimeOffset.MinValue ? null : mime.Date,
                    ReceivedAt = info.LastWriteTimeUtc,
                    SizeBytes = info.Length,
                    IsRead = false,
                    HasAttachments = attachments.Count > 0,
                    BlobKey = blobKey,
                    RawBody = raw,
                };
                inbox.UidNext++;

                db.Messages.Add(message);

                for (var i = 0; i < attachments.Count; i++)
                {
                    var part = attachments[i];
                    db.Attachments.Add(new Attachment
                    {
                        TenantId = box.TenantId,
                        MessageId = message.Id,
                        Filename = Truncate(part.FileName, 512) ?? $"attachment-{i + 1}",
                        ContentType = Truncate(part.ContentType?.MimeType, 200),
                        SizeBytes = PartSize(part),
                        PartIndex = i,
                        ScanStatus = "pending",
                    });
                }

                box.UsedBytes += info.Length;
                added++;
            }
            catch (Exception ex)
            {
                _failed.Add(blobKey);
                log.LogWarning(ex, "Could not ingest {BlobKey}; will not retry until restart", blobKey);
            }
        }

        if (added > 0)
        {
            await db.SaveChangesAsync(ct);
            log.LogInformation("Ingested {Count} message(s) for {Address}", added, address);
        }
    }

    private static long PartSize(MimePart part)
    {
        try
        {
            // Content is null for a part that declares an attachment but
            // carries no body — malformed, but mail is full of malformed.
            if (part.Content is null) return 0;
            using var counter = new CountingStream();
            part.Content.DecodeTo(counter);
            return counter.Length;
        }
        catch
        {
            return 0;
        }
    }

    private static string? Truncate(string? s, int max) =>
        s is null ? null : (s.Length <= max ? s : s[..max]);

    /// <summary>Counts bytes without buffering them — attachment sizes can be 25 MB.</summary>
    private sealed class CountingStream : Stream
    {
        private long _written;
        public override long Length => _written;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Position { get => _written; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => _written += count;
    }
}
