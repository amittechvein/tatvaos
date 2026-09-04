using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// The quota gate, answered while the sender still owns the message.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY HERE AND NOT IN THE INGEST WORKER
///
///  MaildirIngestWorker polls the maildir on a timer. By the time it sees a
///  message, Postfix answered 250, Dovecot wrote the file, and the SMTP
///  session closed seconds ago — there is nobody left to refuse. A quota check
///  there could only skip indexing (the message exists on disk but never
///  appears in the client: a silent disappearance after the sender was told
///  it was delivered) or delete the file (mail loss, and it breaks the
///  one-writer-per-store rule).
///
///  RCPT time is the last moment a refusal is honest, because the sender's
///  own server still holds the message and will retry.
/// ─────────────────────────────────────────────────────────────────────────
///
///  FAIL OPEN, ALWAYS. Every failure path here answers DUNNO: a database
///  blip, a parse error, an unknown address, an unhandled exception. A quota
///  checker that stops mail when it breaks is worse than no quota checker,
///  and Postfix is configured with smtpd_policy_service_default_action=DUNNO
///  so a dead API is also harmless.
///
///  Speaks Postfix's policy delegation protocol: attribute=value lines, blank
///  line, then one "action=..." line and a blank line back. Postfix reuses the
///  connection for many requests, so this loops until the peer goes away.
/// </summary>
public sealed class PostfixPolicyWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<PostfixPolicyWorker> log) : BackgroundService
{
    /// <summary>
    /// observe = evaluate and log, refuse nothing. The default, deliberately.
    ///
    /// The usage figures this decides on only recently started being computed
    /// correctly. Enforcing against a wrong number silently rejects real mail,
    /// which is a worse failure than the one enforcement fixes — so the
    /// rollout is: run in observe, read the would-defer lines for a few days,
    /// then flip Mail:QuotaEnforcement to "enforce" with evidence in hand.
    /// </summary>
    private bool Enforcing =>
        string.Equals(config["Mail:QuotaEnforcement"], "enforce", StringComparison.OrdinalIgnoreCase);

    private const string Dunno = "DUNNO";

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var port = int.TryParse(config["Mail:PolicyPort"], out var p) ? p : 10025;
        var listener = new TcpListener(IPAddress.Any, port);

        try
        {
            listener.Start();
        }
        catch (Exception ex)
        {
            // Not fatal to the API. Postfix's default action covers us.
            log.LogError(ex, "Quota policy service could not bind port {Port}; mail will not be quota-checked", port);
            return;
        }

        log.LogInformation(
            "Quota policy service listening on {Port} in {Mode} mode",
            port, Enforcing ? "ENFORCE" : "observe-only");

        try
        {
            while (!ct.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync(ct);
                }
                catch (OperationCanceledException) { break; }

                // Per connection, unawaited on purpose: Postfix opens several
                // and holds them open. One slow lookup must not queue the rest.
                _ = ServeAsync(client, ct);
            }
        }
        finally
        {
            listener.Stop();
        }
    }

    private async Task ServeAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            try
            {
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.UTF8);
                using var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };

                while (!ct.IsCancellationRequested)
                {
                    var request = await ReadRequestAsync(reader, ct);
                    if (request is null) return;      // peer closed
                    if (request.Count == 0) continue; // stray blank line

                    var action = await DecideAsync(request, ct);
                    await writer.WriteAsync($"action={action}\n\n");
                }
            }
            catch (Exception ex)
            {
                // The connection dies; Postfix reconnects and, failing that,
                // applies its own default action. Never escalate.
                log.LogDebug(ex, "Policy connection ended");
            }
        }
    }

    /// <summary>One request: attribute=value lines terminated by a blank line.</summary>
    private static async Task<Dictionary<string, string>?> ReadRequestAsync(
        StreamReader reader, CancellationToken ct)
    {
        var attrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) return null;
            if (line.Length == 0) return attrs;

            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            attrs[line[..eq]] = line[(eq + 1)..];
        }
    }

    private async Task<string> DecideAsync(Dictionary<string, string> req, CancellationToken ct)
    {
        try
        {
            // Only the recipient stage carries a recipient worth checking.
            if (req.TryGetValue("protocol_state", out var state)
                && !string.Equals(state, "RCPT", StringComparison.OrdinalIgnoreCase))
                return Dunno;

            if (!req.TryGetValue("recipient", out var recipient) || recipient.Length == 0)
                return Dunno;

            // ---- BOUNCE PATH ---------------------------------------------
            //  Branch on the recipient DOMAIN first — one string compare —
            //  before the size read, the DB scope, or any crypto, because
            //  every inbound RCPT on the platform reaches this handler and the
            //  99.9% that is not a bounce must not pay for the 0.1% that is.
            //
            //  Exception-isolated on purpose: a fault in bounce validation
            //  returns defer for THIS recipient and never falls through to the
            //  quota answer below. Quota fails open (DUNNO); an unguarded throw
            //  here would ride that and make real mail flow unmetered. Contained
            //  on purpose, not by luck.
            var bounceDomain = config["Bounce:Domain"];
            if (!string.IsNullOrEmpty(bounceDomain)
                && recipient.EndsWith("@" + bounceDomain, StringComparison.OrdinalIgnoreCase))
            {
                try { return ValidateBounce(recipient); }
                catch (Exception ex)
                {
                    log.LogError(ex, "Bounce validation threw; deferring this bounce only");
                    return "DEFER_IF_PERMIT 451 4.7.0 Bounce validation temporarily unavailable";
                }
            }

            // The size the SENDER announced on MAIL FROM, which many clients
            // omit. Zero is fine and expected: the allocator then asks "is this
            // mailbox already at its limit" with no headroom, and the accrual
            // after delivery does the exact accounting.
            var size = req.TryGetValue("size", out var raw) && long.TryParse(raw, out var s) && s > 0 ? s : 0;

            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

            var address = recipient.Trim().ToLowerInvariant();

            // mail.mailboxes carries no row-level security — the mail edge reads
            // it to route — so this cross-tenant lookup is by design. Everything
            // after it runs inside the mailbox's own tenant.
            var mailbox = await db.Mailboxes.IgnoreQueryFilters()
                .FirstOrDefaultAsync(m => m.Address.ToLower() == address, ct);

            if (mailbox is null)
            {
                // Could be an alias. Aliases deliver into a real mailbox, and it
                // is that mailbox's quota that decides.
                var alias = await db.Aliases.IgnoreQueryFilters()
                    .FirstOrDefaultAsync(a => a.Address.ToLower() == address && a.IsActive, ct);

                if (alias is not null)
                    mailbox = await db.Mailboxes.IgnoreQueryFilters()
                        .FirstOrDefaultAsync(m => m.Id == alias.TargetMailboxId, ct);
            }

            // Not an address we know. Postfix's own reject_unlisted_recipient
            // owns that decision and has already run; second-guessing it here
            // would refuse mail for anything this query happens not to see.
            if (mailbox is null) return Dunno;

            tenant.EnterPlatformScope(mailbox.TenantId, mailbox.UserId ?? Guid.Empty);
            await db.SyncTenantAsync(ct);

            var allocator = scope.ServiceProvider.GetRequiredService<StorageAllocator>();
            var result = await allocator.EvaluateAcceptAsync(mailbox.Id, size, ct);

            // Everything that is not a question about space stays exactly as
            // Core decided it: suspended, closed, gone. Only "is there room"
            // moves to the person.
            if (result.Decision is not (StorageAllocator.AcceptDecision.Accept
                                     or StorageAllocator.AcceptDecision.Full))
                return Map(result, address);

            // A shared mailbox has no owner. Its bytes belong to the
            // organisation, so the mailbox figure is still the right question -
            // charging support@ to whoever last answered it would move a
            // colleague's remaining space and orphan the queue's storage the
            // day that person leaves.
            if (mailbox.UserId is not Guid owner || mailbox.Type == "shared")
                return Map(result, address);

            var person = await PersonStorageAsync(db, allocator, mailbox, owner, ct);
            if (person is null)
            {
                // We could not establish the person's allowance. Fail open, in
                // keeping with the rest of this worker: refusing mail on a
                // figure we could not read is the worse of the two mistakes.
                log.LogWarning("No storage figure for the owner of {Address}; accepting", address);
                return Dunno;
            }

            var (quota, used) = person.Value;

            // Zero or negative means unbounded, not full.
            if (quota <= 0) return Dunno;

            if (used + Math.Max(0, size) <= quota)
                return Dunno;

            return Map(
                new StorageAllocator.AcceptResult(
                    StorageAllocator.AcceptDecision.Full,
                    $"person over allowance: {used} + {Math.Max(0, size)} > {quota} bytes"),
                address);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Quota check failed; accepting the message");
            return Dunno;
        }
    }

    /// <summary>
    /// The recipient owner's allowance and usage, or null if either cannot be
    /// established.
    ///
    /// ONE SQL FUNCTION ANSWERS THIS, for this lane and for Space both. The
    /// storage model names the trap directly: two implementations of "is there
    /// room" will disagree, and the one that refuses is the one the customer
    /// notices. If this method ever grows a SUM over used_bytes, that is the
    /// second implementation and it is the bug.
    ///
    /// A NULL allowance means the person inherits, so inheritance is resolved
    /// through Core's own resolver rather than guessed at here.
    /// </summary>
    private static async Task<(long Quota, long Used)?> PersonStorageAsync(
        AppDbContext db, StorageAllocator allocator, Mailbox mailbox, Guid owner, CancellationToken ct)
    {
        var rows = await db.Set<UserStorageRow>()
            .FromSqlRaw("SELECT quota_bytes, used_bytes FROM core.user_storage({0})", owner)
            .AsNoTracking()
            .ToListAsync(ct);

        if (rows.Count == 0) return null;
        var row = rows[0];

        if (row.QuotaBytes is long explicitQuota && explicitQuota > 0)
            return (explicitQuota, row.UsedBytes);

        var departmentId = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == owner)
            .Select(u => u.DepartmentId)
            .FirstOrDefaultAsync(ct);

        var inherited = await allocator.ResolveQuotaAsync(
            mailbox.TenantId, departmentId, null, "mail", ct);

        return (inherited, row.UsedBytes);
    }

    // A bounce local part is exactly: 32-hex id . keyid . ts . 16-hex sig.
    // The shape check is the CHEAP first gate (§ design): a public catch-all
    // attracts floods, and every RCPT in a flood would otherwise be an HMAC on
    // the same handler that answers quota for real mail. Anything that is not
    // this shape is refused before a single hash is computed.
    private static readonly Regex BounceLocalPart =
        new(@"^([0-9a-f]{32})\.([A-Za-z0-9]{1,16})\.([0-9]{1,7})\.([0-9a-f]{16})$",
            RegexOptions.Compiled);

    /// <summary>
    /// Validate a VERP bounce address at RCPT time. Returns a Postfix action:
    /// DUNNO (valid — let it through to the intake transport), a 5xx REJECT
    /// (malformed, forged, stale, wrong/absent key), or — only from the caller's
    /// catch — a 4xx defer on an internal fault.
    ///
    /// NO SECRET IS A REJECT, NOT AN ACCEPT. Once bounces.tatvaos.com is a
    /// relay domain the config is live whether or not Bounce:Secret is set. If
    /// a missing secret meant "can't check, allow", a single absent config
    /// value would turn the whole domain into an accept-everything catch-all
    /// that looked healthy while doing it. So an unset secret, or a keyid this
    /// server does not hold, rejects every address on the domain — loudly
    /// wrong beats silently wrong. (VERP is dormant until the secret is set, so
    /// there is no legitimate traffic to lose while it is unset.)
    /// </summary>
    private string ValidateBounce(string recipient)
    {
        var at = recipient.LastIndexOf('@');
        var local = at > 0 ? recipient[..at] : recipient;

        // Cheap shape gate — no crypto yet.
        var m = BounceLocalPart.Match(local);
        if (!m.Success)
            return "REJECT 5.7.1 Not a valid bounce address";

        var idHex = m.Groups[1].Value;
        var keyId = m.Groups[2].Value;
        var ts    = m.Groups[3].Value;
        var sig   = m.Groups[4].Value;

        // No secret, or a keyid we do not hold: reject the whole domain.
        var secret = config["Bounce:Secret"];
        var currentKeyId = config["Bounce:KeyId"] ?? "k1";
        if (string.IsNullOrEmpty(secret)
            || !string.Equals(keyId, currentKeyId, StringComparison.OrdinalIgnoreCase))
            return "REJECT 5.7.1 Bounce address not recognised";

        // Expiry — a captured address must not be replayable for years. The
        // send-day stamp is in the SIGNED payload, so forging it just fails the
        // HMAC; checking it first keeps a replay flood off the crypto path.
        // 30 days is generous against the ~5-day DSN retry reality.
        if (!long.TryParse(ts, out var tsDays))
            return "REJECT 5.7.1 Not a valid bounce address";
        var nowDays = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 86_400;
        if (nowDays - tsDays > 30 || tsDays - nowDays > 1)
            return "REJECT 5.7.1 Bounce address expired";

        // Constant-time HMAC check — it is a signature check reachable by
        // anyone who can talk to port 25. Compare the raw bytes, never the hex.
        var mac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret),
            Encoding.ASCII.GetBytes($"{idHex}.{keyId}.{ts}"));
        var expected = mac.AsSpan(0, 8).ToArray();
        var provided = Convert.FromHexString(sig);
        if (!CryptographicOperations.FixedTimeEquals(expected, provided))
            return "REJECT 5.7.1 Bounce address failed verification";

        // Valid — let it continue to `permit` and the intake transport. The
        // intake (a later slice) does the idempotent bounced_at write; this
        // gate's only job is to keep everything unsigned out of the queue.
        return Dunno;
    }

    /// <summary>
    /// Decision to wire response. The mapping is Core's, recorded in
    /// StorageAllocator.AcceptDecision — read that before changing anything here.
    /// </summary>
    private string Map(StorageAllocator.AcceptResult result, string address)
    {
        switch (result.Decision)
        {
            case StorageAllocator.AcceptDecision.Accept:
                return Dunno;

            // Take the mail. Suspension is enforced at sign-in, where it is
            // real; refusing delivery would also punish everyone writing to
            // them, and their mail would be gone rather than waiting.
            case StorageAllocator.AcceptDecision.Suspended:
                return Dunno;

            case StorageAllocator.AcceptDecision.Full:
                if (!Enforcing)
                {
                    log.LogInformation("would-defer {Address}: {Detail}", address, result.Detail);
                    return Dunno;
                }
                log.LogInformation("deferring {Address}: {Detail}", address, result.Detail);
                // 452, never 552. Temporary: the sending server keeps the
                // message and retries, so a wrong reading costs a delay. A
                // permanent 5xx would discard mail we cannot get back.
                return "DEFER_IF_PERMIT 452 4.2.2 Mailbox is full, try again later";

            case StorageAllocator.AcceptDecision.NoSuchMailbox:
                if (!Enforcing)
                {
                    log.LogInformation("would-reject {Address}: {Detail}", address, result.Detail);
                    return Dunno;
                }
                log.LogInformation("rejecting {Address}: {Detail}", address, result.Detail);
                return "REJECT 5.1.1 No such user here";

            default:
                // A new case Core adds and this has not learned yet. Accepting
                // is the safe reading of an unknown verdict.
                log.LogWarning("Unmapped accept decision {Decision} for {Address}; accepting",
                    result.Decision, address);
                return Dunno;
        }
    }
}
