using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Modules.Family;
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
        var autoSave = scope.ServiceProvider.GetRequiredService<ContactAutoSave>();

        // Filled as messages are staged, drained after the save. Family's
        // contact_sources has a foreign key to mail.messages, so nothing can
        // reference these rows until they are committed.
        var ingested = new List<Message>();

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

        // Every folder, tracked: filing increments the target's UidNext, and a
        // rule may move mail into any of them. One query rather than one lookup
        // per special-use folder.
        var folders = await db.Folders.Where(f => f.MailboxId == box.Id).ToListAsync(ct);
        var folderById = folders.ToDictionary(f => f.Id);

        var inbox = folders.FirstOrDefault(f => f.SpecialUse == "\\Inbox");
        if (inbox is null)
        {
            log.LogWarning("Mailbox {Address} has no Inbox folder; skipping ingest", address);
            return;
        }

        // Blocked senders are filed to Junk instead of Inbox. Nothing is
        // dropped: blocking is a filing rule, not a refusal, so unblocking
        // makes past mail findable again where it already sits.
        //
        // Both this and the rules below are best-effort. A mailbox with no Junk
        // folder, or a failed query, degrades to "everything lands in Inbox" —
        // losing the blocklist can never cost mail.
        var junk = folders.FirstOrDefault(f => f.SpecialUse == "\\Junk");

        var blocked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            blocked = (await db.BlockedSenders.AsNoTracking()
                    .Where(x => x.MailboxId == box.Id)
                    .Select(x => x.Address)
                    .ToListAsync(ct))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not read the blocklist for {Address}; filing everything to Inbox", address);
        }

        // Filter rules, parsed once per mailbox rather than per message.
        var rules = new List<(List<MailFilters.Condition> Conditions, bool MatchAll, MailFilters.Actions Actions)>();
        try
        {
            var rows = await db.FilterRules.AsNoTracking()
                .Where(r => r.MailboxId == box.Id && r.Enabled)
                .OrderBy(r => r.Position).ThenBy(r => r.CreatedAt)
                .ToListAsync(ct);

            foreach (var r in rows)
            {
                var conditions = MailFilters.ParseConditions(r.Conditions);
                // A rule with no readable conditions matches nothing; drop it
                // here rather than evaluate it per message.
                if (conditions.Count == 0) continue;
                rules.Add((conditions, r.MatchAll, MailFilters.ParseActions(r.Actions)));
            }
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not read filter rules for {Address}; delivering unfiltered", address);
        }

        // Message-Id -> thread for messages added in THIS sweep. A reply can
        // arrive in the same batch as the message it answers, and that parent is
        // only in the change tracker until the save at the end — without this
        // the pair would split into two conversations.
        var pendingThreads = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);

        // Calendar replies found in this sweep: (payload, the address that the
        // envelope says sent it). Collected during the loop, HANDED OVER ONLY
        // AFTER THE COMMIT — a calendar reply that cannot be understood must
        // not affect whether the mail was delivered (the sink's own contract).
        var calendarReplies = new List<(string Payload, string From)>();

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

                // ── THE §4 JOIN: does this message carry a calendar reply? ──
                //
                // Registered in Program.cs since the seam was designed, called
                // by NOTHING until 27 August 2026 — Mail found the missing
                // caller by grepping before running a test written from
                // intention. This is the caller.
                //
                // Only METHOD:REPLY and COUNTER are handed over. REQUESTs and
                // CANCELs arriving in mail are somebody inviting US — a
                // different feature, deliberately not smuggled in through a
                // fix. The address handed to Calendar is Return-Path (what
                // the envelope authenticated) over the From header (what the
                // sender typed), because the sink's whole design rests on
                // "the address that authenticated wins".
                foreach (var part in mime.BodyParts.OfType<MimePart>())
                {
                    if (part.ContentType?.IsMimeType("text", "calendar") != true) continue;
                    // Null for a part that declares a body and carries none —
                    // malformed, but mail is full of malformed (PartSize below
                    // learned the same lesson). Skip, never dereference.
                    if (part.Content is null) continue;

                    string payload;
                    using (var ms = new MemoryStream())
                    {
                        part.Content.DecodeTo(ms);
                        payload = System.Text.Encoding.UTF8.GetString(ms.ToArray());
                    }

                    var isReply = payload.Contains("METHOD:REPLY", StringComparison.OrdinalIgnoreCase)
                               || payload.Contains("METHOD:COUNTER", StringComparison.OrdinalIgnoreCase);
                    if (!isReply) continue;

                    var envelopeFrom = mime.Headers[HeaderId.ReturnPath] is { Length: > 0 } rp
                        ? rp.Trim('<', '>', ' ')
                        : fromAddr;
                    if (!string.IsNullOrWhiteSpace(envelopeFrom))
                        calendarReplies.Add((payload, envelopeFrom));
                }

                // Where this one lands. UIDs are per folder, so the target has
                // to be chosen before ImapUid is read — filing to Junk while
                // taking the Inbox's UID would corrupt both folders' sequences.
                var isBlocked = fromAddr is not null && blocked.Contains(fromAddr);
                var target = (junk is not null && isBlocked) ? junk : inbox;

                // Filter rules. Blocking wins: someone who blocked a sender does
                // not want a rule quietly pulling that mail back out of Junk, so
                // rules only run when the sender is not blocked.
                //
                // ALL matching rules apply, in position order. A later move
                // overrides an earlier one; the flags accumulate.
                var markRead = false;
                var flag = false;
                if (!isBlocked && rules.Count > 0)
                {
                    var subject = new MailFilters.Subject(
                        fromAddr,
                        MailContent.Addresses(mime.To),
                        mime.Subject,
                        mime.TextBody ?? mime.HtmlBody);

                    foreach (var (conditions, matchAll, actions) in rules)
                    {
                        if (!MailFilters.Matches(conditions, matchAll, subject)) continue;
                        if (actions.MarkRead) markRead = true;
                        if (actions.Flag) flag = true;
                        // Only into a folder that still exists in this mailbox —
                        // a rule outlives the folder it pointed at.
                        if (actions.MoveToFolderId is Guid fid
                            && folderById.TryGetValue(fid, out var dest))
                            target = dest;
                    }
                }

                var threadId = await MailThreads.ResolveAsync(
                    db, box.Id, mime, pendingThreads, ct);

                var message = new Message
                {
                    TenantId = box.TenantId,
                    MailboxId = box.Id,
                    FolderId = target.Id,
                    ThreadId = threadId,
                    ImapUid = target.UidNext,
                    MessageIdHeader = string.IsNullOrEmpty(mime.MessageId) ? null : mime.MessageId,
                    FromAddr = Truncate(fromAddr, 320),
                    FromName = Truncate(fromName, 320),
                    ToAddrs = MailContent.Addresses(mime.To),
                    CcAddrs = mime.Cc.Count > 0 ? MailContent.Addresses(mime.Cc) : null,
                    Subject = Truncate(mime.Subject, 1000),
                    Snippet = MailContent.Snippet(mime),
                    // Extracted once, here, so search has a body to index
                    // without re-parsing MIME per query. HtmlBody is the
                    // fallback for senders who ship no text alternative.
                    BodyText = mime.TextBody ?? mime.HtmlBody,
                    // .ToUniversalTime() is not optional: an email's Date
                    // header carries the sender's offset (+05:30 for IST), and
                    // Npgsql refuses to write a non-UTC DateTimeOffset to a
                    // timestamptz column — it fails the whole insert batch.
                    SentAt = mime.Date == DateTimeOffset.MinValue ? null : mime.Date.ToUniversalTime(),
                    ReceivedAt = info.LastWriteTimeUtc,
                    SizeBytes = info.Length,
                    IsRead = markRead,
                    IsFlagged = flag,
                    HasAttachments = attachments.Count > 0,
                    BlobKey = blobKey,
                    RawBody = raw,
                };
                target.UidNext++;

                if (message.MessageIdHeader is string mid && mid.Length > 0)
                    pendingThreads[mid.Trim('<', '>')] = threadId;

                db.Messages.Add(message);
                ingested.Add(message);

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

            // After the commit, never before, and never inside the same
            // SaveChanges: a failure to update the address book must not roll
            // back delivered mail. box.UserId is null for a shared mailbox,
            // which RecordAsync treats as "no address book to write to".
            await autoSave.RecordAsync(db, tenant, box.UserId, ingested, "sender", ct);
        }

        // ── KNOWN AND ACCEPTED: THE SAME REPLY CAN BE HANDED OVER TWICE. ──
        //
        // One acceptance from Gmail was observed to produce two "applied"
        // lines on 27 Aug 2026 — the reply landed in two mailboxes (both
        // attendee addresses were on the invitation), each sweep of each
        // maildir found the calendar part, and the sink ran once per copy.
        //
        // Harmless TODAY because the sink is idempotent: setting the same
        // PARTSTAT twice is a no-op. It stops being harmless THE MOMENT the
        // sink notifies, counts, or audits per call — whoever adds any of
        // those must dedupe here first (the VCALENDAR's UID+SEQUENCE+attendee
        // is the natural key), or one click becomes two notifications.
        // Mail's observation, recorded where the next person will trip on it.
        //
        // ── Hand collected calendar replies to Calendar — AFTER the commit,
        // exactly like the address book above and for the same reason: a
        // reply Calendar cannot understand must not roll back delivered
        // mail. FALSE IS NORMAL per the sink's contract (a stranger's
        // fragment, an unknown UID, a stale sequence); it earns one debug
        // line and nothing else. TRUE is the whole feature working — a Yes
        // clicked in Gmail landing on our attendance row — and that deserves
        // to be visible in the log.
        if (calendarReplies.Count > 0)
        {
            var sink = scope.ServiceProvider
                .GetRequiredService<TatvaOS.Api.Modules.Calendar.ICalendarImipSink>();
            foreach (var (payload, from) in calendarReplies)
            {
                try
                {
                    if (await sink.HandleReplyAsync(payload, from, ct))
                        log.LogInformation("Calendar reply from {From} applied", from);
                    else
                        log.LogDebug("Calendar reply from {From} was not for us", from);
                }
                catch (Exception ex)
                {
                    // The sink promises never to throw; this catch is for the
                    // day that promise breaks, so one bad payload cannot stop
                    // the mailbox after it in the sweep.
                    log.LogWarning(ex, "Calendar reply from {From} threw in the sink", from);
                }
            }
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
