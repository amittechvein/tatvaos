using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail.Endpoints;

/// <summary>
/// POST /api/v1/mail/send — the programmatic send endpoint.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS IS A WRAPPER, NOT A MAIL SERVER. Everything that makes a send safe
///  already exists and this file must not reimplement any of it:
///
///   · The verified-domain gate lives in Postfix
///     (sql/sender-external-gate.cf) and runs on the submission port. We do
///     not re-express it; MailSender submits through 587 and the gate applies.
///   · DKIM signing, the refusal WORDING, the queue — all Postfix's.
///   · MailSender is the ONE send path. Its own header warns against a fifth
///     hand-rolled SmtpClient, and this endpoint would have been the fifth.
///
///  So the whole of this file is: authenticate a key, resolve the sender to a
///  real mailbox, hand it to MailSender, write a row.
/// ─────────────────────────────────────────────────────────────────────────
///
///  AUTHENTICATION IS DONE HERE, NOT IN THE MIDDLEWARE, on purpose. A second
///  AuthenticationHandler beside the JWT scheme is the tidier long-term
///  answer, but it changes TenantMiddleware — a shared file on the platform's
///  authentication path — which is a conversation, not an afternoon. This
///  route is AllowAnonymous and does its own bearer check, so the blast
///  radius is one file and a reviewer can read all of it.
///
///  NOT IN THIS VERSION, and the list is deliberate: suppression, bounce
///  tracking, delivery states beyond accepted/refused, bulk, rate limits,
///  scopes. Those matter when a customer sends to strangers. They go in
///  before the first EXTERNAL customer gets a key — that is the line.
/// </summary>
public static class MailSendApiEndpoints
{
    /// <summary>
    /// Five. Enough for a genuine cc-style send, small enough that nobody
    /// mistakes this for the bulk endpoint and discovers at two thousand
    /// recipients that it never was one. Bulk is a separate endpoint with
    /// its own expansion, suppression and per-recipient rows.
    ///
    /// Note also what a longer list would do: every recipient would see every
    /// other recipient's address. For a school mailing parents that is a
    /// disclosure of the parent list, sent by us, on the customer's behalf.
    /// </summary>
    private const int MaxRecipients = 5;

    public static void MapMailSendApiEndpoints(this IEndpointRouteBuilder app)
    {
        // The /api prefix is not decoration - it is the routing contract.
        // Caddy on core.tatvaos.com sends /api/* to this service and EVERY
        // other path to Next.js. A route mapped at bare /v1/mail/send builds,
        // starts, and answers perfectly on localhost while returning the web
        // app's 404 to every real customer. Found before merge by reading the
        // Caddyfile, not after by a support ticket.
        //
        // The Resend-shaped api.tatvaos.com/v1/... URL stays unavailable on
        // purpose: there is no api.tatvaos.com, so that Core and Mail share a
        // registrable domain and one auth cookie. Changing that is a domain
        // and certificate decision, not a routing tweak.
        app.MapPost("/api/v1/mail/send", SendAsync)
           .AllowAnonymous()
           .WithTags("Mail API");
    }

    public sealed record SendRequest(
        string? From, string? To, string? Subject,
        string? Html, string? Text, string? ReplyTo,
        // Default true: one copy of the call is filed in the sender's Sent
        // folder, addressed to every recipient, charged to quota once. A bulk
        // or machine-generated job that does not want its output in a
        // person's mailbox sends false; api_sends is its record regardless.
        bool? SaveToSent = null);

    private static async Task<IResult> SendAsync(
        HttpContext http,
        AppDbContext db,
        TenantContext tenant,
        IConfiguration config,
        ILoggerFactory logs,
        ContactAutoSave autoSave,
        AuditWriter audit,
        CancellationToken ct)
    {
        var log = logs.CreateLogger("MailSendApi");

        // ---- 1. The key ----------------------------------------------------
        var header = http.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
            return Unauthorized("Provide your API key as: Authorization: Bearer tvos_...");

        var presented = header["Bearer ".Length..].Trim();
        var hash = MailApiKeyEndpoints.Sha256(presented);

        // --------------------------------------------------------------------
        //  Breaking the circle: RLS needs a tenant, and the tenant is not
        //  known until the key is found.
        //
        //  This was first written as EnterPlatformScope(Guid.Empty, ...) and
        //  that was simply wrong. Platform scope deliberately does NOT disable
        //  RLS - it sets a tenant per operation - so the lookup ran with
        //  app.tenant_id all zeros, matched no policy row, and answered "that
        //  API key is not valid" to a perfectly valid key. IgnoreQueryFilters()
        //  disguised it by dropping EF's filter while leaving the DATABASE
        //  policy fully in force.
        //
        //  mail.resolve_api_key is SECURITY DEFINER and does exactly one
        //  thing, exactly as core.resolve_refresh_token does for the refresh
        //  endpoint. It tells a caller nothing they do not already hold.
        // --------------------------------------------------------------------
        Guid keyId;
        Guid keyTenantId;
        bool wasRevoked;
        string[]? allowedAddresses;
        {
            var conn = db.Database.GetDbConnection();

            // Opening the raw connection bypasses TenantConnectionInterceptor,
            // which sets app.tenant_id ONLY in ConnectionOpenedAsync. Leaving
            // it open here would mean every query after this point runs on a
            // connection that never got a tenant - returning zero rows, all
            // request long, for reasons nothing would explain. So it is closed
            // again the moment the resolver is done, and EF opens its own
            // through the interceptor once the scope below is set.
            var openedHere = conn.State != System.Data.ConnectionState.Open;
            if (openedHere) await conn.OpenAsync(ct);
            try
            {
                await using var cmd = conn.CreateCommand();
                cmd.CommandText =
                    "SELECT key_id, tenant_id, was_revoked, allowed_sender_addresses FROM mail.resolve_api_key(@hash)";

                var p = cmd.CreateParameter();
                p.ParameterName = "@hash";
                p.Value = hash;
                cmd.Parameters.Add(p);

                await using var reader = await cmd.ExecuteReaderAsync(ct);

                // Revoked and unknown get the SAME answer. Telling a caller
                // their key once existed is telling an attacker their guess
                // was close.
                if (!await reader.ReadAsync(ct))
                    return Unauthorized("That API key is not valid.");

                keyId       = reader.GetGuid(0);
                keyTenantId = reader.GetGuid(1);
                wasRevoked  = reader.GetBoolean(2);
                
                // Read allowed_sender_addresses - can be NULL for backward compat
                allowedAddresses = reader.IsDBNull(3) ? null : (string[]?)reader.GetFieldValue<string[]>(3);
            }
            finally
            {
                if (openedHere) await conn.CloseAsync();
            }
        }

        if (wasRevoked)
            return Unauthorized("That API key is not valid.");

        // From here on this request is that organisation, and every query is
        // RLS-scoped to it in the ordinary way.
        tenant.EnterAnonymousScope(keyTenantId, "api");

        // ---- 2. The organisation must still be live ------------------------
        // Same gate as every credential store here. A suspended organisation's
        // key stops working, and Postfix's own sender gate carries the same
        // predicate - so this is the fast, clear refusal, not the only one.
        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == keyTenantId, ct);
        if (org is null || org.Status is not ("active" or "trial"))
            return Unauthorized("This organisation is not active.");

        // ---- 3. The request ------------------------------------------------
        // The body is read HERE, not bound by the framework. When a body does
        // not fit SendRequest - most often "to" sent as a JSON array where a
        // string is expected - framework binding answers with an empty 400 and
        // no log line, which took three round-trips to diagnose on 4 Sept.
        // Reading it ourselves lets the refusal name the field. Same JSON
        // options the framework would have used, so a correct body binds
        // exactly as before. It also means the body is only parsed for a
        // caller who has already presented a valid key.
        if (!http.Request.HasJsonContentType())
            return Results.BadRequest(new { error = "Send the request body as JSON (Content-Type: application/json)." });

        SendRequest? req;
        try
        {
            req = await http.Request.ReadFromJsonAsync<SendRequest>(ct);
        }
        catch (JsonException ex)
        {
            return Results.BadRequest(new
            {
                error = "The request body is not in the expected shape. " + ex.Message
                      + " Note: to is a single string; for several recipients, separate them with commas.",
            });
        }

        var from    = (req?.From ?? "").Trim();
        var toRaw   = (req?.To ?? "").Trim();
        var subject = (req?.Subject ?? "").Trim();
        var html    = req?.Html ?? "";
        var text    = req?.Text ?? "";

        if (from.Length == 0 || toRaw.Length == 0 || subject.Length == 0)
            return Results.BadRequest(new { error = "from, to and subject are required." });
        if (html.Length == 0 && text.Length == 0)
            return Results.BadRequest(new { error = "Provide html, text, or both." });

        var toParts = toRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (toParts.Length > MaxRecipients)
            return Results.BadRequest(new
            {
                error = $"At most {MaxRecipients} recipients per request. "
                      + "Send separately, or wait for the bulk endpoint.",
            });

        List<MailboxAddress> to;
        MailboxAddress replyTo;
        try
        {
            to = toParts.Select(MailboxAddress.Parse).ToList();
            replyTo = string.IsNullOrWhiteSpace(req?.ReplyTo)
                ? MailboxAddress.Parse(from)
                : MailboxAddress.Parse(req!.ReplyTo!);
        }
        catch (ParseException)
        {
            return Results.BadRequest(new { error = "One of the addresses is not a valid email address." });
        }

        // ---- 4. The sender must be a real mailbox of this organisation -----
        // Ruled 31 August. Postfix's gate is keyed on a mailbox that exists,
        // and rewriting the view that gate rests on - the abuse control our
        // Linode unblock rests on - to allow address-only senders is a change
        // nobody has asked for by name. A noreply@ that exists is also the
        // better product: a reply lands somewhere instead of vanishing.
        string fromAddress;
        try { fromAddress = MailboxAddress.Parse(from).Address; }
        catch (ParseException) { return Results.BadRequest(new { error = "from is not a valid email address." }); }

        var box = await db.Mailboxes
            .FirstOrDefaultAsync(m => m.Address == fromAddress && m.IsActive, ct);
        if (box is null)
            return Results.BadRequest(new
            {
                error = $"{fromAddress} is not a mailbox on this organisation. "
                      + "Create it under Mailboxes, on a domain you have verified.",
            });

        // ---- 4b. Sender must be one of the key's allowed addresses ---------
        // An empty (or null) list means the key may not send at all. It does
        // NOT mean "unrestricted" - that inversion was the September 2026 hole.
        if (allowedAddresses is null || allowedAddresses.Length == 0)
            return Results.BadRequest(new
            {
                error = "This API key has no allowed sender addresses, so it cannot send. "
                      + "Add at least one under Platform → API keys → [this key] → Edit, "
                      + "or create a new key with the addresses it should send from.",
            });

        var isAllowed = allowedAddresses.Any(addr =>
            addr.Equals(fromAddress, StringComparison.OrdinalIgnoreCase));
        if (!isAllowed)
            return Results.BadRequest(new
            {
                error = $"This API key is restricted to: {string.Join(", ", allowedAddresses)}",
            });
        // ---- 5. Hand it to the one send path -------------------------------
        // ---- 5. Send, ONE MESSAGE PER RECIPIENT ----------------------------
        //  Per-recipient because the bounce key is per-recipient: each message
        //  leaves with its OWN envelope sender carrying its OWN api_sends row
        //  id, so a DSN days later names the exact row (see the bounce
        //  migration). It also means no recipient sees another's address —
        //  the disclosure the low MaxRecipients was guarding against.
        //
        //  The VERP address switches ON only once the bounce subdomain and its
        //  signing secret are configured; until then EnvelopeSender is null and
        //  this sends exactly as before. That is deliberate: this endpoint must
        //  not wait on the Postfix + DNS routing PR to keep working.
        var bounceSecret = config["Bounce:Secret"];
        var bounceDomain = config["Bounce:Domain"];
        var bounceKeyId  = config["Bounce:KeyId"] ?? "k1";
        var bounceOn = !string.IsNullOrEmpty(bounceSecret) && !string.IsNullOrEmpty(bounceDomain);

        // NOTE for v1.5 (bulk): each SubmitAsync opens and closes its own SMTP
        // connection. Fine at five recipients; at bulk it must pool one
        // connection across the batch instead of one per message.
        // One Sent copy per CALL, not per recipient. The first submit that
        // Postfix accepts files it (addressed to everyone — see
        // SentCopyRecipients); every later submit passes false. If the first
        // recipient is refused, the next accepted one files instead, so a
        // call that reached anybody leaves exactly one entry in Sent.
        var saveToSent = req.SaveToSent ?? true;
        var allRecipients = to.ToList();
        var filed = false;
        var sends = new List<(MailboxAddress Recipient, Guid Id, bool Accepted, string? Error)>();
        foreach (var recipient in to)
        {
            var sendId = Guid.NewGuid();
            MailboxAddress? envelope = bounceOn
                ? new MailboxAddress(string.Empty, BuildBounceAddress(sendId, bounceKeyId, bounceSecret!, bounceDomain!))
                : null;

            var result = await MailSender.SubmitAsync(
                box,
                new MailSubmission(
                    To: new[] { recipient },
                    Cc: Array.Empty<MailboxAddress>(),
                    Subject: subject,
                    BodyText: text,
                    BodyHtml: html,
                    Attachments: Array.Empty<MailAttachment>(),
                    EnvelopeSender: envelope,
                    // Filed once for the whole call (see above), never once
                    // per recipient — that would put N near-identical copies
                    // in Sent and charge the quota N times for one API call.
                    FileSentCopy: saveToSent && !filed,
                    SentCopyRecipients: allRecipients),
                db, tenant, config, log, autoSave, audit, ct);

            var ok = result.Outcome is SendOutcome.Sent or SendOutcome.SentButNotFiled;
            // Only a real filing counts — SentButNotFiled (no Sent folder, or
            // FileSentCopy was false) must not stop a later recipient trying.
            if (saveToSent && !filed && result.Outcome == SendOutcome.Sent) filed = true;
            sends.Add((recipient, sendId, ok, ok ? null : result.Error));
        }

        // ---- 6. One row per recipient, keyed by the id its bounce carries --
        foreach (var s in sends)
        {
            db.MailApiSends.Add(new MailApiSend
            {
                Id = s.Id,               // the same id encoded in the VERP address
                TenantId = keyTenantId,
                ApiKeyId = keyId,
                FromAddress = fromAddress,
                ToAddress = s.Recipient.Address,
                Subject = subject,
                Outcome = s.Accepted ? "accepted" : "refused",
                Error = s.Accepted ? null : s.Error,
                SentAt = DateTimeOffset.UtcNow,
            });
        }

        var acceptedCount = sends.Count(s => s.Accepted);
        var firstError = sends.FirstOrDefault(s => !s.Accepted).Error;

        if (acceptedCount > 0)
        {
            // Has a writer, so a NULL genuinely means never used.
            var tracked = await db.MailApiKeys.FirstOrDefaultAsync(k => k.Id == keyId, ct);
            if (tracked is not null) tracked.LastUsedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);

        // PER-RECIPIENT RESULTS in the body, because sends are per-recipient.
        // A caller cannot read api_sends rows, so without this a partial
        // failure (three accepted, two refused) returns one status and a
        // blanket retry sends the three accepted ones a second time. Each
        // result carries the id so a retry is targeted and de-dupable.
        var results = sends.Select(x => new
        {
            to = x.Recipient.Address,
            id = x.Id,
            status = x.Accepted ? "accepted" : "refused",
            error = x.Accepted ? null : x.Error,
        }).ToArray();

        if (acceptedCount == 0)
        {
            // Postfix's own words, passed through. A generic "send failed"
            // sends the customer hunting through server logs for a policy
            // working exactly as built - most usefully the verified-domain
            // refusal, which tells them precisely what to do next.
            return Results.Json(new
            {
                outcome = "refused",
                error = firstError ?? "The mail server refused the message.",
                results,
            }, statusCode: StatusCodes.Status502BadGateway);
        }

        if (acceptedCount < sends.Count)
        {
            // Some accepted, some refused. 207 so a caller cannot read it as a
            // clean success and retry everything; results says which to retry.
            return Results.Json(new
            {
                outcome = "partial",
                accepted = acceptedCount,
                total = sends.Count,
                note = "Some recipients were accepted and some refused. Retry only the refused ids.",
                sentCopy = filed,
                results,
            }, statusCode: StatusCodes.Status207MultiStatus);
        }

        // "accepted" and never "sent" or "delivered": Postfix has taken
        // custody, and that is the last thing this code can honestly observe.
        return Results.Json(new
        {
            outcome = "accepted",
            recipients = acceptedCount,
            note = "Accepted for delivery. This is not confirmation of arrival.",
            sentCopy = filed,
            results,
        }, statusCode: StatusCodes.Status202Accepted);
    }

    /// <summary>
    /// The per-recipient VERP bounce address: id.keyid.hmac@bounce-domain.
    /// The id is the api_sends primary key (correlation); keyid names the
    /// signing secret so it can rotate without invalidating bounces in flight;
    /// hmac signs "id.keyid" so a random address to the subdomain is rejected
    /// before any lookup. The secret is never stored in a row — it lives in
    /// config (infra/docker/.env) and the intake recomputes to validate.
    /// </summary>
    private static string BuildBounceAddress(Guid id, string keyId, string secret, string domain)
    {
        var idHex = id.ToString("N"); // 32 hex, no hyphens: a clean local part
        using var mac = new System.Security.Cryptography.HMACSHA256(
            System.Text.Encoding.UTF8.GetBytes(secret));
        var sig = mac.ComputeHash(System.Text.Encoding.ASCII.GetBytes(idHex + "." + keyId));
        var sigHex = Convert.ToHexString(sig, 0, 8).ToLowerInvariant(); // 16 hex chars
        return $"{idHex}.{keyId}.{sigHex}@{domain}";
    }

    private static IResult Unauthorized(string message)
        => Results.Json(new { error = message }, statusCode: StatusCodes.Status401Unauthorized);
}
