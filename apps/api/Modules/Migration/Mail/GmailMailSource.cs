using System.Collections.Concurrent;
using MimeKit;
using MimeKit.Utils;
using TatvaOS.Api.Shared.Google;

namespace TatvaOS.Api.Modules.Migration.Mail;

/// <summary>
/// Phase 1: one person's Gmail into their TatvaOS mailbox, as a migration
/// job's source ('google_workspace' / 'mail').
///
/// ─────────────────────────────────────────────────────────────────────────
///  A PAGE is one page of Gmail's message list (its pageToken is the job's
///  cursor), with every message on it fetched raw. The dedupe key is the
///  Message-ID read from the raw headers, so the runner can skip a message
///  already written under the same id (design section 5) before it costs an
///  APPEND.
///
///  A WRITE is GmailLabelMap's placement, put by DovecotAppender: APPEND once,
///  COPY to the other folders, nothing if it is already there. A message
///  found already in place is recorded 'skipped' with that reason, so the
///  ledger tells a re-run from a first run.
///
///  NOT REGISTERED IN Program.cs YET, deliberately. It needs two things that
///  are Mr. Singh's to decide first:
///    IGoogleCredentialProvider - where a customer's service-account key
///        rests and how it is read (design section 9);
///    IMigrationMailboxLogin    - how we sign in to a person's mailbox
///        (probably a Dovecot master user - an auth change to the mail server).
///  Until both exist the runner says "no source for google_workspace/mail in
///  this build" and leaves the job pending.
///
///  MAIL THAT ARRIVES DURING THE MIGRATION is brought by a catch-up run
///  (the cursor's "d:" mode, below), as many times as needed until the
///  customer switches MX; the last one after the switch brings the rest.
///
///  KNOWN GAP, said rather than hidden:
///   * a message bigger than Dovecot's limits fails on its own and is
///     recorded 'failed' with the reason; the job goes on
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GmailMailSource(
    GmailClient gmail,
    IGoogleCredentialProvider credentials,
    IMigrationMailboxLogin logins,
    DovecotAppender appender,
    IConfiguration config) : IMigrationSource, IAsyncDisposable
{
    public string Source => "google_workspace";
    public string DataType => "mail";

    private int PageSize => Math.Clamp(config.GetValue("Migration:Mail:PageSize", 25), 1, 100);
    private static readonly TimeSpan SessionIdle = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<Guid, IReadOnlyDictionary<string, string>> _labels = new();
    private readonly ConcurrentDictionary<Guid, (DovecotSession Session, DateTimeOffset Used)> _sessions = new();

    // ── THE CURSOR ──────────────────────────────────────────────────────────
    //
    //   null            a first, full copy: Gmail's historyId H is read FIRST
    //   f:H:<token>     the full copy, at Gmail's page <token>
    //   d:H             finished: what has been added since H is still to come
    //   d:H:<token>     a catch-up, at history page <token>
    //
    //  The full copy ends at "d:H" with H taken BEFORE its first page, so mail
    //  that arrived while it ran is exactly what the next catch-up brings.
    //  MigrationEnrolment.CatchUpAsync re-queues completed mail jobs; each run
    //  ends at the newer "d:H". If Google no longer keeps history back to H
    //  (404), the catch-up falls back to a full listing - safe, because the
    //  ledger and the Message-ID check skip everything already here.
    public async Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        await CloseIdleSessionsAsync();
        var account = await AccountAsync(job, ct);
        // Fetched afresh at the start of each page: a person can add a label
        // between two runs, and an unknown label id would drop its folder.
        _labels[job.Id] = await gmail.UserLabelNamesAsync(account, job.SourceUser, ct);

        var parts = job.Cursor?.Split(':', 3);
        if (parts is ["d", var since, ..])
        {
            var token = parts.Length == 3 ? parts[2] : null;
            var history = await gmail.ListAddedSinceAsync(account, job.SourceUser, since, token, ct);
            if (history is not null)
            {
                var added = await ItemsAsync(account, job, history.Ids, ct);
                return history.NextPageToken is { } next
                    ? new MigrationPage(added, $"d:{since}:{next}", IsLast: false)
                    : new MigrationPage(added, $"d:{history.HistoryId ?? since}", IsLast: true);
            }
            parts = null;   // history too old: a full listing, from the top
        }

        string historyId;
        string? pageToken;
        long? total = null;
        if (parts is ["f", var h, var t]) (historyId, pageToken) = (h, t);
        else
        {
            var profile = await gmail.GetProfileAsync(account, job.SourceUser, ct);
            (historyId, pageToken, total) = (profile.HistoryId ?? "0", null, profile.MessagesTotal);
        }

        var page = await gmail.ListMessageIdsAsync(account, job.SourceUser, pageToken, PageSize, ct);
        var items = await ItemsAsync(account, job, page.Ids, ct);
        return page.NextPageToken is { } nextPage
            ? new MigrationPage(items, $"f:{historyId}:{nextPage}", IsLast: false, ItemsTotal: total)
            : new MigrationPage(items, $"d:{historyId}", IsLast: true, ItemsTotal: total);
    }

    private async Task<List<MigrationSourceItem>> ItemsAsync(
        GoogleServiceAccount account, MigrationJobView job, IReadOnlyList<string> ids, CancellationToken ct)
    {
        var items = new List<MigrationSourceItem>(ids.Count);
        foreach (var id in ids)
        {
            try
            {
                var raw = await gmail.GetRawAsync(account, job.SourceUser, id, ct);
                items.Add(new MigrationSourceItem(id, MessageIdOf(raw.Raw), raw));
            }
            catch (GoogleApiException ex) when (ex.Status == 404)
            {
                // Deleted in Gmail between the listing and the fetch. Recorded
                // as skipped, by name, rather than failing the page for ever.
                items.Add(new MigrationSourceItem(id, null, null));
            }
        }
        return items;
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        if (item.Payload is not GmailRawMessage raw)
            return MigrationWriteResult.Skipped("no longer in Gmail");
        var names = _labels.TryGetValue(job.Id, out var n) ? n : new Dictionary<string, string>();
        var placement = GmailLabelMap.Place(raw.LabelIds, names);

        var session = await SessionAsync(job, ct);
        long appended;
        try { appended = await session.PutAsync(raw.Raw, placement, raw.InternalDate, ct); }
        catch (MailKit.Net.Imap.ImapCommandException ex)
        {
            // Dovecot refused THIS message (too big, malformed). Record it
            // and go on; a connection-level failure is not caught here and
            // fails the page instead, to be retried whole.
            return MigrationWriteResult.Failed($"Dovecot refused it: {ex.Response} {ex.ResponseText}");
        }
        return appended > 0
            ? MigrationWriteResult.Done(appended)
            : MigrationWriteResult.Skipped($"already in {placement.Folders[0]}");
    }

    /// <summary>The Message-ID from the raw headers only - the body is not parsed.</summary>
    public static string? MessageIdOf(byte[] raw)
    {
        try
        {
            using var s = new MemoryStream(raw, writable: false);
            var headers = HeaderList.Load(s);
            var id = headers[HeaderId.MessageId];
            return string.IsNullOrWhiteSpace(id) ? null : MimeUtils.EnumerateReferences(id).FirstOrDefault() ?? id.Trim();
        }
        catch (FormatException) { return null; }
    }

    private async Task<GoogleServiceAccount> AccountAsync(MigrationJobView job, CancellationToken ct) =>
        await credentials.ForTenantAsync(job.TenantId, ct)
        ?? throw new InvalidOperationException("this organisation has no Google service account on file");

    private async Task<DovecotSession> SessionAsync(MigrationJobView job, CancellationToken ct)
    {
        if (_sessions.TryGetValue(job.Id, out var s) && s.Session.IsConnected)
        {
            _sessions[job.Id] = (s.Session, DateTimeOffset.UtcNow);
            return s.Session;
        }
        if (s.Session is not null) await s.Session.DisposeAsync();
        var login = await logins.ForAsync(job.TenantId, job.TargetUserId, ct);
        var session = await appender.OpenAsync(login, ct);
        _sessions[job.Id] = (session, DateTimeOffset.UtcNow);
        return session;
    }

    private async Task CloseIdleSessionsAsync()
    {
        var cutoff = DateTimeOffset.UtcNow - SessionIdle;
        foreach (var (id, s) in _sessions.ToArray())
            if (s.Used < cutoff && _sessions.TryRemove(id, out _)) await s.Session.DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, s) in _sessions) await s.Session.DisposeAsync();
        _sessions.Clear();
    }
}

/// <summary>
/// A customer's Google service account, for the length of a migration. Where
/// it rests and how it is read is design section 9 - Mr. Singh's to rule on
/// before any implementation exists. The provider owns the account's
/// lifetime; callers do not dispose it.
/// </summary>
public interface IGoogleCredentialProvider
{
    Task<GoogleServiceAccount?> ForTenantAsync(Guid tenantId, CancellationToken ct);
}
