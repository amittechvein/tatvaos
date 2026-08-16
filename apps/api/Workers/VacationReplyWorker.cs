using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Sends out-of-office replies.
///
/// ─────────────────────────────────────────────────────────────────────────
///  AN AUTORESPONDER'S FAILURES ARE NOT BUGS, THEY ARE LOOPS. Two of them
///  pointed at each other will send mail until somebody notices; one pointed
///  at a mailing list will answer every post; one that answers a bounce will
///  answer its own bounce. Every rule below exists because of one of those,
///  and none of them should be removed to make the feature "work more".
///
///  Refused, always:
///    - Auto-Submitted present and not "no"   (RFC 3834 - the standard's own
///      rule, and the reason our replies carry the header too)
///    - Precedence: bulk / list / junk
///    - List-Id or List-Unsubscribe present   (a mailing list)
///    - X-Auto-Response-Suppress asking us not to
///    - an empty Return-Path                  (a bounce; answering it loops)
///    - the sender is this mailbox            (answering yourself)
///    - anything filed to Junk
///    - anybody already told inside the interval
///
///  WHERE THE REPLY GOES. The Return-Path, which is the envelope sender and
///  the address that actually asked for this mail - not From, which anybody
///  can write anything into.
///
///  NOT FILED IN SENT. An automatic reply is not correspondence the person
///  wrote, and filing hundreds of them would bury what they did write. The
///  vacation_sends row is the record that it happened.
///
///  DATES ARE READ IN THE OWNER'S TIMEZONE. "First day 15 August" begins at
///  midnight where they are. The platform default fills in for anybody who has
///  not set one, and it lives here rather than in the schema because a default
///  written down twice drifts.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class VacationReplyWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<VacationReplyWorker> log) : BackgroundService
{
    /// <summary>How often the same correspondent may be told. Gmail uses four days.</summary>
    private static readonly TimeSpan RepeatAfter = TimeSpan.FromDays(4);

    /// <summary>
    /// How far back a sweep looks. Anything older was either already answered
    /// or arrived before the responder was switched on - turning one on must
    /// not answer a fortnight of accumulated mail.
    /// </summary>
    private static readonly TimeSpan Lookback = TimeSpan.FromMinutes(30);

    private const int BatchSize = 50;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(
            int.TryParse(config["Mail:AwayIntervalSeconds"], out var s) ? Math.Max(15, s) : 60);

        while (!ct.IsCancellationRequested)
        {
            try { await SweepAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { log.LogWarning(ex, "Away-reply sweep failed; retrying"); }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var probe = scopeFactory.CreateScope();
        var db0 = probe.ServiceProvider.GetRequiredService<AppDbContext>();

        // mail.mailboxes carries no RLS; everything after is tenant-scoped.
        var boxes = (await db0.Mailboxes.IgnoreQueryFilters().AsNoTracking()
                .Where(m => m.IsActive && m.UserId != null)
                .Select(m => new { m.Id, m.TenantId, m.UserId, m.Address })
                .ToListAsync(ct))
            .Select(m => (m.Id, m.TenantId, Owner: m.UserId!.Value, m.Address))
            .ToList();

        foreach (var box in boxes)
        {
            if (ct.IsCancellationRequested) return;
            try { await ForMailboxAsync(box, ct); }
            catch (Exception ex) { log.LogWarning(ex, "Away replies failed for {Address}", box.Address); }
        }
    }

    private async Task ForMailboxAsync(
        (Guid Id, Guid TenantId, Guid Owner, string Address) box, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        tenant.EnterPlatformScope(box.TenantId, box.Owner);
        await db.SyncTenantAsync(ct);

        var responder = await db.VacationResponders.AsNoTracking()
            .FirstOrDefaultAsync(v => v.MailboxId == box.Id && v.Enabled, ct);
        if (responder is null) return;

        var zone = await ZoneForAsync(db, box.Owner, ct);
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone).DateTime);

        if (today < responder.FirstDay) return;
        if (responder.LastDay is DateOnly last && today > last) return;

        var since = DateTimeOffset.UtcNow - Lookback;
        // Never older than the moment the responder was last saved: switching
        // one on must not answer everything already sitting in the Inbox.
        if (responder.UpdatedAt > since) since = responder.UpdatedAt;

        var inbox = await db.Folders.AsNoTracking()
            .FirstOrDefaultAsync(f => f.MailboxId == box.Id && f.SpecialUse == "\\Inbox", ct);
        if (inbox is null) return;

        var candidates = await db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == box.Id
                        && m.FolderId == inbox.Id
                        && m.ReceivedAt >= since
                        && m.RawBody != null)
            .OrderBy(m => m.ReceivedAt)
            .Take(BatchSize)
            .Select(m => new { m.Id, m.RawBody, m.Subject, m.MessageIdHeader })
            .ToListAsync(ct);

        if (candidates.Count == 0) return;

        foreach (var candidate in candidates)
        {
            if (ct.IsCancellationRequested) return;

            MimeMessage mime;
            try { mime = MailContent.Parse(candidate.RawBody!); }
            catch { continue; }

            if (!ShouldReply(mime, box.Address, out var replyTo, out var why))
            {
                log.LogDebug("No away reply for {Id} in {Address}: {Why}", candidate.Id, box.Address, why);
                continue;
            }

            if (!await AudienceAllowsAsync(db, responder, box.Owner, box.TenantId, replyTo!, ct))
                continue;

            var already = await db.VacationSends
                .FirstOrDefaultAsync(v => v.MailboxId == box.Id && v.Address == replyTo, ct);
            if (already is not null && DateTimeOffset.UtcNow - already.LastSentAt < RepeatAfter)
                continue;

            if (!await SendAsync(responder, box, mime, replyTo!, ct)) continue;

            if (already is null)
                db.VacationSends.Add(new VacationSend
                {
                    TenantId = box.TenantId,
                    MailboxId = box.Id,
                    Address = replyTo!,
                    LastSentAt = DateTimeOffset.UtcNow,
                });
            else
                already.LastSentAt = DateTimeOffset.UtcNow;

            await db.SaveChangesAsync(ct);
            log.LogInformation("Away reply from {Address} to {To}", box.Address, replyTo);
        }
    }

    /// <summary>Every loop-prevention rule, in one place, with its reason.</summary>
    private static bool ShouldReply(MimeMessage mime, string self, out string? replyTo, out string why)
    {
        replyTo = null;

        var auto = mime.Headers["Auto-Submitted"];
        if (!string.IsNullOrWhiteSpace(auto) && !auto.Trim().Equals("no", StringComparison.OrdinalIgnoreCase))
        { why = "Auto-Submitted"; return false; }

        var precedence = mime.Headers["Precedence"]?.Trim().ToLowerInvariant();
        if (precedence is "bulk" or "list" or "junk") { why = "Precedence"; return false; }

        if (!string.IsNullOrWhiteSpace(mime.Headers["List-Id"])
            || !string.IsNullOrWhiteSpace(mime.Headers["List-Unsubscribe"]))
        { why = "mailing list"; return false; }

        var suppress = mime.Headers["X-Auto-Response-Suppress"] ?? "";
        if (suppress.Contains("All", StringComparison.OrdinalIgnoreCase)
            || suppress.Contains("OOF", StringComparison.OrdinalIgnoreCase)
            || suppress.Contains("AutoReply", StringComparison.OrdinalIgnoreCase))
        { why = "X-Auto-Response-Suppress"; return false; }

        // The envelope sender. "<>" is a bounce, and answering a bounce is the
        // shortest loop there is.
        var returnPath = mime.Headers["Return-Path"]?.Trim();
        if (returnPath is "<>" or "") { why = "null return path"; return false; }

        string? address = null;
        if (returnPath is not null && MailboxAddress.TryParse(returnPath.Trim('<', '>'), out var rp))
            address = rp.Address;
        else if (mime.From.Mailboxes.FirstOrDefault() is MailboxAddress from)
            address = from.Address;

        if (string.IsNullOrWhiteSpace(address)) { why = "no usable sender"; return false; }

        address = address.ToLowerInvariant();
        if (address == self.ToLowerInvariant()) { why = "self"; return false; }

        replyTo = address;
        why = "";
        return true;
    }

    private static async Task<bool> AudienceAllowsAsync(
        AppDbContext db, VacationResponder responder, Guid owner, Guid tenantId,
        string sender, CancellationToken ct)
    {
        if (responder.OrgOnly)
        {
            // Somebody with a mailbox here. Aliases count: a person writing
            // from their alias is still a colleague.
            var inside = await db.Mailboxes.IgnoreQueryFilters().AsNoTracking()
                .AnyAsync(m => m.TenantId == tenantId && m.Address.ToLower() == sender, ct);
            if (!inside)
                inside = await db.Aliases.IgnoreQueryFilters().AsNoTracking()
                    .AnyAsync(a => a.TenantId == tenantId && a.Address.ToLower() == sender && a.IsActive, ct);
            if (!inside) return false;
        }

        if (responder.ContactsOnly)
        {
            var known = await (
                from e in db.ContactEmails.AsNoTracking()
                join c in db.Contacts.AsNoTracking() on e.ContactId equals c.Id
                where e.EmailNormalised == sender
                      && (c.OwnerUserId == owner || c.OwnerUserId == null)
                select e.Id).AnyAsync(ct);
            if (!known) return false;
        }

        return true;
    }

    private async Task<bool> SendAsync(
        VacationResponder responder,
        (Guid Id, Guid TenantId, Guid Owner, string Address) box,
        MimeMessage original, string to, CancellationToken ct)
    {
        try
        {
            var builder = new BodyBuilder { TextBody = responder.BodyText };
            if (!string.IsNullOrWhiteSpace(responder.BodyHtml)) builder.HtmlBody = responder.BodyHtml;

            var reply = new MimeMessage();
            reply.From.Add(new MailboxAddress(box.Address, box.Address));
            reply.To.Add(MailboxAddress.Parse(to));
            reply.Subject = string.IsNullOrWhiteSpace(responder.Subject)
                ? $"Re: {original.Subject}"
                : responder.Subject;
            reply.Body = builder.ToMessageBody();

            // So the next autoresponder in the chain refuses to answer this,
            // exactly as we refuse to answer theirs.
            reply.Headers.Add("Auto-Submitted", "auto-replied");
            reply.Headers.Add("X-Auto-Response-Suppress", "All");
            reply.Headers.Add("Precedence", "bulk");

            if (original.MessageId is string mid && mid.Length > 0)
            {
                reply.InReplyTo = mid;
                reply.References.Add(mid);
            }

            var host = config["Smtp:Host"] ?? "postfix";
            var port = int.TryParse(config["Smtp:Port"], out var p) ? p : 587;

            using var client = new SmtpClient();
            await client.ConnectAsync(host, port, SecureSocketOptions.None, ct);
            await client.SendAsync(reply, ct);
            await client.DisconnectAsync(true, ct);
            return true;
        }
        catch (Exception ex)
        {
            // Not fatal and not retried in this pass: the correspondent simply
            // is not told. Better a missing courtesy than a send loop.
            log.LogWarning(ex, "Away reply from {Address} to {To} failed", box.Address, to);
            return false;
        }
    }

    private async Task<TimeZoneInfo> ZoneForAsync(AppDbContext db, Guid owner, CancellationToken ct)
    {
        var name = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == owner).Select(u => u.Timezone).FirstOrDefaultAsync(ct);

        name = string.IsNullOrWhiteSpace(name)
            ? config["Mail:DefaultTimezone"] ?? "Asia/Kolkata"
            : name;

        try { return TimeZoneInfo.FindSystemTimeZoneById(name!); }
        catch
        {
            // An unknown zone must not stop somebody's responder working.
            log.LogWarning("Unknown timezone {Zone}; using UTC for the away window", name);
            return TimeZoneInfo.Utc;
        }
    }
}
