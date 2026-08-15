using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Scans stored attachments and records what the scanner actually said.
///
/// ─────────────────────────────────────────────────────────────────────────
///  scan_status has existed since the first schema with a default of
///  'pending', and until now nothing ever moved it. Every attachment on this
///  platform is unscanned, on a system serving schools and hospitals. This
///  worker is the thing that makes the column mean something.
///
///  IT IS OFF UNTIL Mail:ClamAv POINTS AT A SCANNER. No configuration, no
///  worker: it logs once and idles. It does not fall back to marking things
///  clean, ever - that is the bug it was written to remove.
///
///  BYTES ARE NOT STORED TWICE. An attachment is a part of the stored raw
///  message, so scanning re-parses the message and decodes the one part, the
///  same way the download endpoint does. One canonical copy.
///
///  NOTHING IS DELETED OR QUARANTINED. An infected attachment keeps its row
///  and its bytes and is marked infected; the download endpoint refuses it.
///  Destroying a customer's mail on the say-so of a signature match is a
///  bigger decision than this worker gets to make, and a false positive that
///  merely blocks a download is recoverable in a way that one which deletes
///  evidence is not.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class AttachmentScanWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<AttachmentScanWorker> log) : BackgroundService
{
    /// <summary>Attachments per mailbox per cycle. Each one is a full scan.</summary>
    private const int BatchSize = 20;

    private bool _idleLogged;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(
            int.TryParse(config["Mail:ScanIntervalSeconds"], out var s) ? Math.Max(5, s) : 15);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // One bad cycle must not end the worker. A database restart
                // mid-sweep is routine; the queue is still there afterwards.
                log.LogWarning(ex, "Attachment scan cycle failed; retrying next interval");
            }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var probe = scopeFactory.CreateScope();
        var scanner = probe.ServiceProvider.GetRequiredService<ClamAvScanner>();

        if (!scanner.Configured)
        {
            if (!_idleLogged)
            {
                log.LogInformation(
                    "Mail:ClamAv is not set; attachment scanning is idle and every attachment stays pending");
                _idleLogged = true;
            }
            return;
        }
        _idleLogged = false;

        // mail.mailboxes carries no RLS, so this enumeration is cross-tenant by
        // design. Everything after it runs inside one mailbox's tenant scope.
        var db0 = probe.ServiceProvider.GetRequiredService<AppDbContext>();
        var boxes = (await db0.Mailboxes.IgnoreQueryFilters().AsNoTracking()
                .Where(m => m.IsActive)
                .Select(m => new { m.Id, m.TenantId, m.UserId, m.Address })
                .ToListAsync(ct))
            .Select(m => (m.Id, m.TenantId, m.UserId, m.Address))
            .ToList();

        foreach (var box in boxes)
        {
            if (ct.IsCancellationRequested) return;
            try
            {
                await ScanMailboxAsync(box, ct);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Attachment scan failed for {Address}; continuing", box.Address);
            }
        }
    }

    private async Task ScanMailboxAsync(
        (Guid Id, Guid TenantId, Guid? UserId, string Address) box, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var scanner = scope.ServiceProvider.GetRequiredService<ClamAvScanner>();

        tenant.EnterPlatformScope(box.TenantId, actingUserId: box.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);

        // Oldest first, so a backlog drains in the order it arrived rather
        // than starving whatever was there before the scanner existed.
        var pending = await (
                from a in db.Attachments
                join m in db.Messages on a.MessageId equals m.Id
                where m.MailboxId == box.Id && a.ScanStatus == "pending" && a.PartIndex != null
                orderby m.ReceivedAt
                select new { Attachment = a, m.RawBody })
            .Take(BatchSize)
            .ToListAsync(ct);

        if (pending.Count == 0) return;

        var infected = 0;
        var scanned = 0;

        foreach (var row in pending)
        {
            if (ct.IsCancellationRequested) break;

            var att = row.Attachment;

            if (string.IsNullOrEmpty(row.RawBody) || att.PartIndex is not int index)
            {
                // Nothing to scan and nothing that will ever appear. Marking it
                // error rather than leaving it pending stops the sweep picking
                // the same unscannable row up forever.
                att.ScanStatus = ClamAvScanner.Error;
                continue;
            }

            ScanResultFor(row.RawBody, index, out var content, out var reason);
            if (content is null)
            {
                log.LogWarning("Attachment {Id} could not be extracted: {Reason}", att.Id, reason);
                att.ScanStatus = ClamAvScanner.Error;
                continue;
            }

            using (content)
            {
                var verdict = await scanner.ScanAsync(content, ct);
                att.ScanStatus = verdict.Status;
                scanned++;

                if (verdict.Status == ClamAvScanner.Infected)
                {
                    infected++;
                    // Loud, named, and attributable. This is the line somebody
                    // is woken up for.
                    log.LogWarning(
                        "INFECTED attachment in {Address}: {Filename} matched {Signature} (attachment {Id})",
                        box.Address, att.Filename, verdict.Signature, att.Id);
                }
            }
        }

        await db.SaveChangesAsync(ct);

        if (scanned > 0 || infected > 0)
            log.LogInformation(
                "Attachment scan {Address}: {Scanned} scanned, {Infected} infected, {Remaining} still pending",
                box.Address, scanned, infected, Math.Max(0, pending.Count - scanned));
    }

    /// <summary>
    /// Decodes one attachment part out of the stored raw message. Returns null
    /// content with a reason rather than throwing: a message that will not
    /// parse is a fact about the mail, not an error in the worker.
    /// </summary>
    private static void ScanResultFor(string rawBody, int index, out MemoryStream? content, out string? reason)
    {
        content = null;
        reason = null;
        try
        {
            var parts = MailContent.AttachmentParts(MailContent.Parse(rawBody));
            if (index < 0 || index >= parts.Count) { reason = "part index out of range"; return; }

            var part = parts[index];
            if (part.Content is null) { reason = "part carries no content"; return; }

            var buffer = new MemoryStream();
            part.Content.DecodeTo(buffer);
            buffer.Position = 0;
            content = buffer;
        }
        catch (Exception ex)
        {
            reason = ex.GetType().Name;
        }
    }
}
