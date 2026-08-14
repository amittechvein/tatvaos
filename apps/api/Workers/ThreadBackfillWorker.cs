using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// One-off repair: fills thread_id on messages written before threading existed.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY. mail.messages has carried thread_id since the first schema and
///  nothing set it until the ingest worker learned to, and nothing set it on
///  outgoing mail until SendAsync learned to. Both fixes are forward-only:
///  every message already stored keeps its null, so a conversation that began
///  before the fix stays permanently half-visible no matter how good the
///  conversation view is. This closes that gap once.
///
///  IT IS OFF BY DEFAULT AND IT IS NOT A MIGRATION. Mail:ThreadBackfill has
///  to be set to "report" or "run" deliberately. Unset - which is how it
///  ships, and how it should be left afterwards - this worker returns
///  immediately and touches nothing. Putting it in the SQL init set instead
///  would mean re-running header parsing on every deploy forever.
///
///  report  parses everything, decides everything, WRITES NOTHING, and logs
///          the counts. Run this first. There is no staging environment, so
///          the dry run is the only rehearsal available.
///  run     the same work, committed.
///
///  It only ever fills a NULL. No existing thread_id is reassigned, so a
///  conversation someone is already reading cannot be reorganised underneath
///  them, and a second run is a no-op rather than a reshuffle.
///
///  Threading itself is NOT reimplemented here. It calls the same
///  MailThreads.ResolveAsync the ingest worker and the send path call, so
///  there is one definition of what a conversation is and a backfilled thread
///  is indistinguishable from a live one. Hand-rolling header matching in SQL
///  would have been quicker and would have created a second definition that
///  drifts from the first the day either changes.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ThreadBackfillWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<ThreadBackfillWorker> log) : BackgroundService
{
    /// <summary>
    /// Deliberately small. Each row carries its whole raw MIME body, and this
    /// platform has already stored a single message over 3 MB - a chunk of a
    /// few hundred of those is how a repair job becomes an outage.
    /// </summary>
    private const int ChunkSize = 50;

    private sealed class Counts
    {
        public int Examined;
        /// <summary>Carried In-Reply-To or References: a reply to something.</summary>
        public int WithReplyHeaders;
        /// <summary>No ancestry headers at all: genuinely starts a conversation.</summary>
        public int Starters;
        /// <summary>No raw body, or a body MimeKit would not parse.</summary>
        public int Skipped;

        public void Add(Counts o)
        {
            Examined += o.Examined;
            WithReplyHeaders += o.WithReplyHeaders;
            Starters += o.Starters;
            Skipped += o.Skipped;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var mode = (config["Mail:ThreadBackfill"] ?? "off").Trim().ToLowerInvariant();
        if (mode is not ("report" or "run")) return;

        // The API answers mail while this runs. Let it finish starting first;
        // a repair job is never the most urgent thing in the container.
        try { await Task.Delay(TimeSpan.FromSeconds(15), ct); }
        catch (OperationCanceledException) { return; }

        log.LogInformation("Thread backfill starting in {Mode} mode", mode);

        var totals = new Counts();
        List<(Guid Id, Guid TenantId, Guid? UserId, string Address)> boxes;

        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            // mail.mailboxes carries no RLS and this is a platform-wide job,
            // so the enumeration is cross-tenant by design. Everything after
            // it runs inside one mailbox's own tenant scope.
            boxes = (await db.Mailboxes.IgnoreQueryFilters().AsNoTracking()
                    .OrderBy(m => m.Address)
                    .Select(m => new { m.Id, m.TenantId, m.UserId, m.Address })
                    .ToListAsync(ct))
                .Select(m => (m.Id, m.TenantId, m.UserId, m.Address))
                .ToList();
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Thread backfill could not list mailboxes; nothing was done");
            return;
        }

        foreach (var box in boxes)
        {
            if (ct.IsCancellationRequested) break;

            try
            {
                var c = await BackfillMailboxAsync(box, mode, ct);
                totals.Add(c);

                if (c.Examined > 0)
                    log.LogInformation(
                        "Thread backfill {Mode} {Address}: examined {Examined}, "
                        + "with reply headers {Replies}, conversation starters {Starters}, skipped {Skipped}",
                        mode, box.Address, c.Examined, c.WithReplyHeaders, c.Starters, c.Skipped);
            }
            catch (Exception ex)
            {
                // One mailbox failing is not a reason to abandon the rest.
                // Whatever this mailbox kept, it kept: nothing is deleted here.
                log.LogError(ex, "Thread backfill failed for {Address}; continuing", box.Address);
            }
        }

        log.LogInformation(
            "Thread backfill {Mode} finished: examined {Examined}, with reply headers {Replies}, "
            + "conversation starters {Starters}, skipped {Skipped}. {Outcome}",
            mode, totals.Examined, totals.WithReplyHeaders, totals.Starters, totals.Skipped,
            mode == "report"
                ? "REPORT ONLY - nothing was written."
                : "Committed. Unset Mail:ThreadBackfill before the next deploy.");
    }

    private async Task<Counts> BackfillMailboxAsync(
        (Guid Id, Guid TenantId, Guid? UserId, string Address) box,
        string mode,
        CancellationToken ct)
    {
        var counts = new Counts();

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        tenant.EnterPlatformScope(box.TenantId, actingUserId: box.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);

        // Ids first, oldest first, and the set is FIXED before any write.
        // Paging a filter that the loop itself is emptying is how a backfill
        // silently skips half its rows; and in report mode the filter never
        // empties at all, so that same loop would never terminate.
        var ids = await db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == box.Id && m.ThreadId == null)
            .OrderBy(m => m.ReceivedAt)
            .Select(m => m.Id)
            .ToListAsync(ct);

        if (ids.Count == 0) return counts;

        // Message-Id -> thread for rows decided during this run. ResolveAsync
        // looks for ancestors in the database and cannot see anything still
        // sitting unsaved in the change tracker, so without this a reply
        // handled in the same chunk as its parent would split off alone.
        var pending = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);

        for (var i = 0; i < ids.Count; i += ChunkSize)
        {
            var chunk = ids.GetRange(i, Math.Min(ChunkSize, ids.Count - i));

            var rows = await db.Messages
                .Where(m => chunk.Contains(m.Id))
                .OrderBy(m => m.ReceivedAt)
                .ToListAsync(ct);

            foreach (var m in rows)
            {
                // Already decided, as somebody else's stitched-in ancestor.
                if (m.ThreadId is not null) continue;

                counts.Examined++;

                if (string.IsNullOrEmpty(m.RawBody)) { counts.Skipped++; continue; }

                MimeMessage mime;
                try
                {
                    mime = MailContent.Parse(m.RawBody);
                }
                catch (Exception ex)
                {
                    // A message that will not parse is one we cannot thread.
                    // It keeps its null and stays exactly as it was.
                    log.LogWarning(ex, "Thread backfill could not parse message {Id}", m.Id);
                    counts.Skipped++;
                    continue;
                }

                var isReply = !string.IsNullOrWhiteSpace(mime.InReplyTo) || mime.References.Count > 0;

                var thread = await MailThreads.ResolveAsync(db, box.Id, mime, pending, ct);
                m.ThreadId = thread;

                if (isReply) counts.WithReplyHeaders++; else counts.Starters++;

                if (m.MessageIdHeader is string mid && mid.Length > 0)
                    pending[mid.Trim('<', '>')] = thread;
            }

            if (mode == "run") await db.SaveChangesAsync(ct);

            // Raw bodies are the biggest thing in this table. Letting the
            // change tracker hold every chunk would turn a long backfill into
            // a memory problem; pending carries everything the next chunk
            // actually needs to know.
            db.ChangeTracker.Clear();
        }

        return counts;
    }
}
