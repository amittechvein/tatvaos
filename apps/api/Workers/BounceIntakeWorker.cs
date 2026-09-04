using System.Data;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Workers;

/// <summary>
/// The bounce intake: where a delivered, RCPT-validated DSN is turned into a
/// row stamp on mail.api_sends.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHERE THIS SITS
///
///  A returning bounce for an API send comes back to a VERP address on
///  bounces.tatvaos.com carrying the api_sends row id. Postfix has already,
///  at RCPT time, run the HMAC gate (PostfixPolicyWorker.ValidateBounce) and
///  refused everything unsigned — nothing reaches here that did not verify.
///  main.cf then routes the accepted bounce to the `bounce-intake` transport
///  (master.cf), an LMTP client that hands the whole message to THIS listener.
///
///  LMTP, not a pipe or a maildir poll, for the same reason the validator is a
///  branch in the existing policy service rather than a new daemon: it reuses
///  the pattern already blessed on this box (an API socket on the compose
///  network that Postfix speaks to — :10025 quota, :10587 submission), adds no
///  tooling to the Postfix container, no new HTTP surface, and no writable
///  volume. LMTP is the standard Postfix→application handoff — it is exactly
///  how Dovecot receives mail here.
/// ─────────────────────────────────────────────────────────────────────────
///
///  DEFENCE IN DEPTH. This re-verifies the HMAC even though the policy gate
///  already did. If the transport is ever reachable without the gate (a
///  main.cf edit, a staging box wired differently), an unsigned address must
///  still write nothing. The signing format lives in ONE place, BounceAddress,
///  which both the gate and this share.
///
///  FAIL SAFE, BUT NOT FAIL-SILENT. A transient database error while recording
///  answers the LMTP client with 4xx, so Postfix requeues and retries and the
///  bounce is not lost. Everything else — an orphaned id, a duplicate delivery,
///  a message that is not a failure DSN, an address that somehow fails
///  re-verification — is CONSUMED with 250 and logged, never bounced back
///  (replying 5xx to a DSN's null sender is backscatter to nowhere).
/// </summary>
public sealed class BounceIntakeWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration config,
    ILogger<BounceIntakeWorker> log) : BackgroundService
{
    // Bounces are low-volume and small. Anything larger than this claiming to
    // be a DSN is not one we will trust; the cap keeps a hostile "bounce" from
    // growing the buffer without bound.
    private const int MaxMessageBytes = 2 * 1024 * 1024;
    private const int MaxCommandBytes = 4096;
    private const int MaxDataLineBytes = 16 * 1024;

    private string BounceDomain => config["Bounce:Domain"] ?? string.Empty;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var port = int.TryParse(config["Mail:BounceIntakePort"], out var p) ? p : 10035;
        var listener = new TcpListener(IPAddress.Any, port);

        try
        {
            listener.Start();
        }
        catch (Exception ex)
        {
            // Not fatal to the API. Bounces defer at the transport (the far MTA
            // retries for days) rather than being lost, and nothing else the
            // API does depends on this socket.
            log.LogError(ex, "Bounce intake could not bind port {Port}; bounces will not be recorded", port);
            return;
        }

        log.LogInformation("Bounce intake LMTP listening on {Port}", port);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync(ct); }
                catch (OperationCanceledException) { break; }

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
                var reader = new LineReader(stream);

                await WriteAsync(stream, $"220 {Hostname()} LMTP TatvaOS bounce intake ready\r\n", ct);

                var rcpts = new List<string>();

                while (!ct.IsCancellationRequested)
                {
                    var lineBytes = await reader.ReadLineAsync(MaxCommandBytes, ct);
                    if (lineBytes is null) return; // peer closed
                    var line = Encoding.ASCII.GetString(lineBytes);
                    var verb = Verb(line);

                    switch (verb)
                    {
                        case "LHLO":
                            rcpts.Clear();
                            await WriteAsync(stream,
                                $"250-{Hostname()}\r\n250-PIPELINING\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250-ENHANCEDSTATUSCODES\r\n250 SIZE {MaxMessageBytes}\r\n",
                                ct);
                            break;

                        case "MAIL":
                            rcpts.Clear();
                            await WriteAsync(stream, "250 2.1.0 Ok\r\n", ct);
                            break;

                        case "RCPT":
                            var rcpt = ExtractAddress(line);
                            if (string.IsNullOrEmpty(rcpt))
                            {
                                await WriteAsync(stream, "501 5.1.3 Bad recipient address\r\n", ct);
                                break;
                            }
                            rcpts.Add(rcpt);
                            await WriteAsync(stream, "250 2.1.5 Ok\r\n", ct);
                            break;

                        case "DATA":
                            if (rcpts.Count == 0)
                            {
                                await WriteAsync(stream, "554 5.5.1 No valid recipients\r\n", ct);
                                break;
                            }
                            await WriteAsync(stream, "354 End data with <CR><LF>.<CR><LF>\r\n", ct);
                            var (raw, overflowed) = await ReadDataAsync(reader, ct);

                            // ONE reply line per recipient, in order — LMTP's
                            // defining difference from SMTP. In our scheme there
                            // is exactly one (a VERP envelope has one recipient),
                            // but the loop is honest about the general case.
                            var replies = await ProcessAsync(rcpts, raw, overflowed, ct);
                            foreach (var reply in replies)
                                await WriteAsync(stream, reply, ct);

                            rcpts.Clear();
                            break;

                        case "RSET":
                            rcpts.Clear();
                            await WriteAsync(stream, "250 2.0.0 Ok\r\n", ct);
                            break;

                        case "NOOP":
                            await WriteAsync(stream, "250 2.0.0 Ok\r\n", ct);
                            break;

                        case "VRFY":
                            await WriteAsync(stream, "252 2.5.2 Cannot VRFY\r\n", ct);
                            break;

                        case "QUIT":
                            await WriteAsync(stream, "221 2.0.0 Bye\r\n", ct);
                            return;

                        default:
                            await WriteAsync(stream, "500 5.5.2 Unrecognized command\r\n", ct);
                            break;
                    }
                }
            }
            catch (Exception ex)
            {
                // The connection dies; Postfix reconnects, and an accepted-but-
                // unanswered transaction stays queued and is retried. Never
                // escalate out of a single connection.
                log.LogDebug(ex, "Bounce intake connection ended");
            }
        }
    }

    /// <summary>
    /// Validate each recipient again, parse the DSN once, and record. Returns
    /// one LMTP reply string per recipient, in the order given.
    /// </summary>
    private async Task<List<string>> ProcessAsync(
        List<string> rcpts, byte[] raw, bool overflowed, CancellationToken ct)
    {
        var replies = new List<string>(rcpts.Count);

        // Parse the message once; the same DSN body applies to every recipient
        // of this transaction.
        BounceInfo? info = null;
        if (!overflowed)
        {
            try
            {
                using var ms = new MemoryStream(raw, writable: false);
                var msg = await MimeMessage.LoadAsync(ms, ct);
                info = ClassifyDsn(msg);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Bounce intake could not parse the delivered message; consuming without a write");
            }
        }
        else
        {
            log.LogWarning("Bounce message exceeded {Cap} bytes; consuming without a write", MaxMessageBytes);
        }

        foreach (var rcpt in rcpts)
        {
            // Defence in depth: the RCPT gate already verified this, but the
            // format lives in BounceAddress and so does the check.
            var verified = BounceAddress.Verify(
                rcpt, keyId => config[$"Bounce:Keys:{keyId}"], DateTimeOffset.UtcNow);

            if (verified.Verdict != BounceAddress.Verdict.Valid)
            {
                // Should be unreachable — Postfix would have rejected it at
                // RCPT. If it happens, write nothing and consume: a 5xx here
                // only makes backscatter. Loud, because it means the gate was
                // bypassed.
                log.LogWarning(
                    "Bounce reached intake but failed re-verification ({Verdict}) for {Recipient}; consuming, no write",
                    verified.Verdict, rcpt);
                replies.Add("250 2.1.5 Ok\r\n");
                continue;
            }

            if (info is null)
            {
                // Validly signed, but not a failure DSN — a delay notice, a
                // read receipt, an autoresponder. Recording it would invent a
                // bounce that did not happen. Consume and move on.
                log.LogInformation(
                    "Bounce address {Id} carried no failure DSN; consuming without a write", verified.Id);
                replies.Add("250 2.1.5 Ok\r\n");
                continue;
            }

            try
            {
                var outcome = await RecordAsync(verified.Id, info, ct);
                switch (outcome.Result)
                {
                    case "recorded":
                        if (!string.IsNullOrEmpty(info.ReportedRecipient)
                            && !string.IsNullOrEmpty(outcome.ToAddress)
                            && !string.Equals(info.ReportedRecipient, outcome.ToAddress, StringComparison.OrdinalIgnoreCase))
                        {
                            // Design §4: the ROW is authoritative for who
                            // bounced; the DSN's claimed recipient is evidence.
                            // Log the mismatch, record against the row anyway.
                            log.LogWarning(
                                "Bounce {Id}: DSN reported {Reported} but the row was sent to {Actual}; recorded against the row",
                                verified.Id, info.ReportedRecipient, outcome.ToAddress);
                        }
                        log.LogInformation("Bounce recorded for {Id} ({Type})", verified.Id, info.Type);
                        break;

                    case "duplicate":
                        log.LogInformation("Bounce for {Id} already recorded; no-op", verified.Id);
                        break;

                    default: // "unknown"
                        // A valid HMAC over a row that is not there — purged,
                        // or never was. Consume so it does not retry forever.
                        log.LogInformation("Bounce for {Id} matched no row; dropping", verified.Id);
                        break;
                }
                replies.Add("250 2.0.0 Ok\r\n");
            }
            catch (Exception ex)
            {
                // Transient — the database, most likely. DEFER so the far MTA
                // keeps the DSN and retries; a real bounce must not be dropped
                // because the DB blinked.
                log.LogError(ex, "Bounce intake failed to record {Id}; deferring", verified.Id);
                replies.Add("451 4.3.0 Temporary failure recording the bounce, retry later\r\n");
            }
        }

        return replies;
    }

    /// <summary>
    /// The idempotent write, through the SECURITY DEFINER function that is the
    /// app's only path to update a delivered row (see the migration). Returns
    /// the function's verdict and the row's own to_address.
    /// </summary>
    private async Task<(string Result, string? ToAddress)> RecordAsync(
        Guid id, BounceInfo info, CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var conn = db.Database.GetDbConnection();

        // Same reason as the send endpoint's key resolution: open the raw
        // connection so this runs on a plain session. record_bounce is
        // SECURITY DEFINER and keys off the primary key, so no tenant is needed
        // and none is set; close it again so EF opens its own, tenant-aware,
        // next time this scope's context is used.
        var openedHere = conn.State != ConnectionState.Open;
        if (openedHere) await conn.OpenAsync(ct);
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText =
                "SELECT result, to_address, tenant_id FROM mail.record_bounce(@id, @type, @reason)";

            AddParam(cmd, "@id", id);
            AddParam(cmd, "@type", info.Type);
            AddParam(cmd, "@reason", Truncate(info.Reason, 4000));

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct))
                return ("unknown", null);   // the function always returns a row, but be defensive

            var result = reader.GetString(0);
            var toAddress = reader.IsDBNull(1) ? null : reader.GetString(1);
            return (result, toAddress);
        }
        finally
        {
            if (openedHere) await conn.CloseAsync();
        }
    }

    // ── DSN parsing ─────────────────────────────────────────────────────────

    private sealed record BounceInfo(string Type, string Reason, string? ReportedRecipient);

    /// <summary>
    /// Read the machine-readable delivery-status report (RFC 3464). Returns the
    /// first FAILED recipient block as hard (5.x) or soft (4.x), or null when
    /// the message is not a failure DSN at all (no report part, or only
    /// delayed/delivered/relayed groups). A failed block with an unreadable
    /// status class defaults to soft — a misread that records-but-does-not-
    /// suppress is the safe direction.
    /// </summary>
    private static BounceInfo? ClassifyDsn(MimeMessage msg)
    {
        var ds = msg.BodyParts.OfType<MessageDeliveryStatus>().FirstOrDefault();
        if (ds is null) return null;

        foreach (var group in ds.StatusGroups)
        {
            var action = group["Action"];
            if (string.IsNullOrWhiteSpace(action)) continue;             // the per-message group
            if (!action.Trim().Equals("failed", StringComparison.OrdinalIgnoreCase)) continue;

            var status = (group["Status"] ?? string.Empty).Trim();
            var type = status.StartsWith("5", StringComparison.Ordinal) ? "hard"
                     : status.StartsWith("4", StringComparison.Ordinal) ? "soft"
                     : "soft";

            var diag = group["Diagnostic-Code"];
            var reported = ExtractDsnAddress(group["Final-Recipient"])
                        ?? ExtractDsnAddress(group["Original-Recipient"]);

            var reason = BuildReason(reported, status, diag);
            return new BounceInfo(type, reason, reported);
        }

        return null;
    }

    // "Final-Recipient: rfc822; user@example.com" → "user@example.com"
    private static string? ExtractDsnAddress(string? headerValue)
    {
        if (string.IsNullOrWhiteSpace(headerValue)) return null;
        var semi = headerValue.IndexOf(';');
        var addr = (semi >= 0 ? headerValue[(semi + 1)..] : headerValue).Trim();
        return addr.Length == 0 ? null : addr;
    }

    private static string BuildReason(string? recipient, string status, string? diagnostic)
    {
        var parts = new List<string>(3);
        if (!string.IsNullOrWhiteSpace(recipient)) parts.Add(recipient!.Trim());
        if (!string.IsNullOrWhiteSpace(status)) parts.Add(status.Trim());
        if (!string.IsNullOrWhiteSpace(diagnostic)) parts.Add(diagnostic!.Trim());
        return parts.Count == 0 ? "bounced (no diagnostic)" : string.Join("; ", parts);
    }

    // ── LMTP line handling ───────────────────────────────────────────────────

    /// <summary>
    /// Read the DATA body: lines until a line that is a single ".". Removes
    /// dot-stuffing, re-inserts CRLF, and caps total size. Always drains to the
    /// terminator even past the cap, so the command stream stays in sync.
    /// </summary>
    private async Task<(byte[] Raw, bool Overflowed)> ReadDataAsync(LineReader reader, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var overflowed = false;

        while (true)
        {
            var line = await reader.ReadLineAsync(MaxDataLineBytes, ct);
            if (line is null) break; // peer closed mid-DATA

            if (line.Length == 1 && line[0] == (byte)'.') break; // end of data

            var start = 0;
            if (line.Length > 0 && line[0] == (byte)'.') start = 1; // un-stuff a leading dot

            if (!overflowed && ms.Length + (line.Length - start) + 2 > MaxMessageBytes)
                overflowed = true;

            if (!overflowed)
            {
                ms.Write(line, start, line.Length - start);
                ms.WriteByte((byte)'\r');
                ms.WriteByte((byte)'\n');
            }
        }

        return (ms.ToArray(), overflowed);
    }

    private static async Task WriteAsync(NetworkStream stream, string text, CancellationToken ct)
    {
        var bytes = Encoding.ASCII.GetBytes(text);
        await stream.WriteAsync(bytes, ct);
        await stream.FlushAsync(ct);
    }

    private static string Verb(string commandLine)
    {
        var sp = commandLine.IndexOf(' ');
        var v = sp >= 0 ? commandLine[..sp] : commandLine;
        return v.Trim().ToUpperInvariant();
    }

    // MAIL FROM:<addr> / RCPT TO:<addr> → addr. Empty for <> (a DSN's sender).
    private static string ExtractAddress(string commandLine)
    {
        var lt = commandLine.IndexOf('<');
        var gt = commandLine.IndexOf('>', lt + 1);
        if (lt >= 0 && gt > lt) return commandLine[(lt + 1)..gt].Trim();

        // No angle brackets — take whatever follows the first ':' up to a space.
        var colon = commandLine.IndexOf(':');
        if (colon < 0) return string.Empty;
        var rest = commandLine[(colon + 1)..].Trim();
        var sp = rest.IndexOf(' ');
        return (sp >= 0 ? rest[..sp] : rest).Trim();
    }

    private static void AddParam(System.Data.Common.DbCommand cmd, string name, object value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = value;
        cmd.Parameters.Add(p);
    }

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max];

    private string Hostname() =>
        config["Mail:Hostname"] is { Length: > 0 } h ? h : "mail.tatvaos.com";

    /// <summary>
    /// A byte-oriented line reader over the socket. LMTP command lines are
    /// ASCII, but the DATA body can be 8-bit, so lines are handed back as raw
    /// bytes with the trailing CRLF stripped. Overlong lines are drained, not
    /// stored past the cap.
    /// </summary>
    private sealed class LineReader(Stream stream)
    {
        private readonly byte[] _buf = new byte[8192];
        private int _pos;
        private int _len;

        public async Task<byte[]?> ReadLineAsync(int maxLen, CancellationToken ct)
        {
            var line = new List<byte>(128);
            while (true)
            {
                if (_pos >= _len)
                {
                    _len = await stream.ReadAsync(_buf.AsMemory(0, _buf.Length), ct);
                    _pos = 0;
                    if (_len == 0)
                        return line.Count == 0 ? null : line.ToArray();
                }

                var b = _buf[_pos++];
                if (b == (byte)'\n')
                {
                    if (line.Count > 0 && line[^1] == (byte)'\r')
                        line.RemoveAt(line.Count - 1);
                    return line.ToArray();
                }

                if (line.Count < maxLen) line.Add(b); // else drain silently to the newline
            }
        }
    }
}
