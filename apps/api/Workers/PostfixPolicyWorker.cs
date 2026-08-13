using System.Net;
using System.Net.Sockets;
using System.Text;
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

            return Map(result, address);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Quota check failed; accepting the message");
            return Dunno;
        }
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
