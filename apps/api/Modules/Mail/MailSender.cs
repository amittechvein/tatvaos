using MailKit;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using MimeKit.Utils;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail;

// ============================================================================
//  Sending a message — the one path, extracted from the send endpoint
// ============================================================================
//
//  THIS IS A MOVE, NOT A REWRITE. Every line below was inside
//  MailEndpoints.SendAsync and behaves exactly as it did there. It was lifted
//  out because Calendar needs to send an iMIP invitation, and the only shapes
//  available to it were an HTTP handler that reads a multipart form, or a
//  fifth hand-rolled SmtpClient beside the four this codebase already has
//  (Notify, VacationReplyWorker, ConnectMinutesMailer, and this one).
//
//  A fifth would have been the cheapest thing to write and the worst thing to
//  own: five places that each decide what a Sent copy is, whether to thread,
//  whether to charge the quota. They would not stay in agreement, and the one
//  that drifted would be discovered by a customer.
//
//  WHAT DELIBERATELY STAYED IN THE ENDPOINT: form parsing, the permission
//  check, and the 25 MB gate. The gate reads IFormFile.Length BEFORE any file
//  is read into memory, and that ordering is the point of it — moving it here,
//  where attachments arrive as byte[], would mean reading half a gigabyte to
//  decide it was too big.
// ============================================================================

/// <summary>
/// One attachment, already in memory. Deliberately not IFormFile: this is not
/// an HTTP type and a caller that has no request should not have to invent one.
/// </summary>
/// <remarks>
/// ContentType is non-nullable to match IFormFile, which is where every
/// caller's value comes from today. A caller that genuinely does not know
/// passes "application/octet-stream" - the same thing this would have
/// defaulted to - rather than pushing a null through the compose path.
/// </remarks>
public sealed record MailAttachment(string FileName, string ContentType, byte[] Content);

/// <summary>
/// What to send. The mailbox is NOT in here — it is passed separately and is
/// already resolved, because resolving it is a permission decision and belongs
/// to whoever is entitled to make it, not to the thing that builds the message.
/// </summary>
public sealed record MailSubmission(
    IReadOnlyList<MailboxAddress> To,
    IReadOnlyList<MailboxAddress> Cc,
    string Subject,
    string BodyText,
    string BodyHtml,
    IReadOnlyList<MailAttachment> Attachments,
    // A message of ours this answers; threads the Sent copy.
    Guid? InReplyToMessageId = null,
    // Removed from Drafts once the send succeeds.
    Guid? DraftId = null,
    // The VCALENDAR text, folded per RFC 5545 by whoever built it. Null for
    // every caller that is not Calendar, which is all of them today.
    string? ICalendar = null,
    // REQUEST | CANCEL | REPLY. Must agree with the METHOD: line inside
    // ICalendar; SubmitAsync refuses the send if it does not.
    string? ICalendarMethod = null,
    // The envelope sender (Return-Path) to submit with. Null — the default,
    // and every interactive send — leaves the envelope as the From address,
    // so a person's bounces come back to their own mailbox. The send API sets
    // this to a per-recipient VERP bounce address so a DSN correlates to the
    // exact api_sends row. Setting it switches SendAsync to the overload that
    // takes an explicit sender and recipient list.
    MailboxAddress? EnvelopeSender = null);

public enum SendOutcome
{
    /// <summary>Submitted and filed. MessageId and FolderId are set.</summary>
    Sent,

    /// <summary>
    /// Submitted, but the mailbox has no Sent folder so no copy was filed.
    /// The message HAS gone out — this is not a failure and must never be
    /// reported as one.
    /// </summary>
    SentButNotFiled,

    /// <summary>Postfix said no. Error carries its words.</summary>
    Refused,

    /// <summary>The mail server could not be reached. Nothing was sent.</summary>
    Unreachable,
}

public sealed record SendResult(
    SendOutcome Outcome, Guid? MessageId, Guid? FolderId, string? Error);

public static class MailSender
{
    /// <summary>
    /// Compose, submit, file the Sent copy, thread it, index its attachments,
    /// charge the quota, offer the recipients to contacts, and audit a
    /// delegated send. In that order, and the order matters: nothing is filed
    /// before the submit succeeds, and nothing that writes after the commit is
    /// allowed to fail the message.
    /// </summary>
    public static async Task<SendResult> SubmitAsync(
        Mailbox box,
        MailSubmission s,
        AppDbContext db,
        TenantContext tenant,
        IConfiguration config,
        ILogger log,
        ContactAutoSave autoSave,
        AuditWriter audit,
        CancellationToken ct)
    {
        // Whether this is somebody else's queue changes the display name and
        // the audit trail. It changes nothing else: the message is built,
        // submitted and filed through exactly the same path either way.
        var isShared = box.UserId != tenant.UserId;

        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);

        // ---- Compose with a body builder --------------------------------
        //  HtmlBody + TextBody makes a multipart/alternative the receiver's
        //  client picks from; attachments make it multipart/mixed around that.
        //  MimeKit assembles the right structure from what we set here.
        var builder = new BodyBuilder();
        if (!string.IsNullOrWhiteSpace(s.BodyHtml)) builder.HtmlBody = s.BodyHtml;
        if (!string.IsNullOrWhiteSpace(s.BodyText)) builder.TextBody = s.BodyText;
        else if (string.IsNullOrWhiteSpace(s.BodyHtml)) builder.TextBody = "";

        foreach (var file in s.Attachments)
        {
            var contentType = ContentType.Parse(
                string.IsNullOrWhiteSpace(file.ContentType) ? "application/octet-stream" : file.ContentType);
            builder.Attachments.Add(file.FileName, file.Content, contentType);
        }

        var mime = new MimeMessage();
        // A reply from a shared queue goes out AS the queue, display name and
        // all. Putting the individual's name here is how an answer comes back
        // to one person's inbox and dies there the week they are on leave.
        mime.From.Add(new MailboxAddress(
            // The mailbox's own name when it has one ("Admissions Office"),
            // falling back to the local part for mailboxes created before
            // display names existed.
            isShared ? box.DisplayName ?? box.LocalPart : user?.DisplayName ?? box.LocalPart,
            box.Address));
        foreach (var a in s.To) mime.To.Add(a);
        foreach (var a in s.Cc) mime.Cc.Add(a);
        mime.Subject = s.Subject;
        // Message-ID on the SENDER'S domain, not the machine's. MimeKit
        // defaults it to the hostname, and inside a container the hostname
        // is a random hex Docker ID: "<...@50f84e0af825>" is what Gmail
        // received on 3 Sept. Receivers check that the part after the @ is a
        // real domain; one that resolves to nothing is a spam signal stamped
        // on every message this platform has ever sent, webmail included.
        mime.MessageId = MimeUtils.GenerateMessageId(box.Address[(box.Address.IndexOf('@') + 1)..]);
        // An invitation is assembled by hand; everything else goes through
        // BodyBuilder exactly as it always has.
        if (s.ICalendar is { Length: > 0 } ical)
        {
            // ONE CALL for both outcomes. Assembling and checking the method
            // are not two steps a caller can get out of order, because a
            // caller who has to remember the check is one who will forget -
            // and an invitation whose header and body disagree is silent at
            // every layer until it reaches somebody's calendar.
            var (body, refusal) = InvitationBody.TryBuild(
                s.BodyText, s.BodyHtml, ical, s.ICalendarMethod ?? string.Empty);

            if (body is null)
            {
                log.LogError("Refusing an invitation from {From}: {Refusal}", box.Address, refusal);
                return new SendResult(SendOutcome.Refused, null, null,
                    "This invitation is inconsistent and was not sent.");
            }

            // The ordinary attachments, which are not the invitation's
            // business and so are not TryBuild's either.
            foreach (var file in s.Attachments)
                body.Add(InvitationBody.FileAttachment(file.FileName, file.ContentType, file.Content));

            mime.Body = body;
        }
        else
        {
            mime.Body = builder.ToMessageBody();
        }

        // Threading headers, so replies land in the same conversation in
        // every client that receives them — including ours, later.
        if (s.InReplyToMessageId is Guid replyId)
        {
            var original = await db.Messages.AsNoTracking()
                .FirstOrDefaultAsync(x => x.Id == replyId && x.MailboxId == box.Id, ct);
            if (original?.MessageIdHeader is string origId && origId.Length > 0)
            {
                mime.InReplyTo = origId.Trim('<', '>');
                mime.References.Add(origId.Trim('<', '>'));
            }
        }

        // ---- Submit through our own Postfix -----------------------------
        //  :10587 - the INTERNAL API submission service in master.cf, not
        //  :587. 587 is the customer port: production requires TLS and a
        //  SASL password there, and this code has neither (a shared mailbox
        //  has no password by design). While this pointed at 587, every send
        //  through the API on production failed - Postfix answered MAIL FROM
        //  with 530, MailKit raised ServiceNotAuthenticatedException, and the
        //  catch-all below reported "could not be reached". Nothing was
        //  unreachable; it was the wrong door. The fallback here is 10587 so
        //  that a missing Smtp:Port can never quietly reproduce that.
        //
        //  The verified-domain outbound gate lives in Postfix, in
        //  sender-external-gate.cf, on BOTH ports - deliberately not
        //  re-implemented here, because two copies of one rule drift and the
        //  Postfix one is the one Linode was told about.
        var host = config["Smtp:Host"] ?? "postfix";
        var port = int.TryParse(config["Smtp:Port"], out var p) ? p : 10587;

        try
        {
            using var client = new SmtpClient();
            // The name this client introduces itself with (EHLO) and the one
            // that lands in the first Received: header. Same container-ID
            // problem as Message-ID above. Mail:Host is the platform's public
            // mail identity, which is exactly what this hop is.
            if (config["Mail:Host"] is { Length: > 0 } helo) client.LocalDomain = helo;
            // NOT THE PLAINTEXT PROBLEM main.cf FIXES, and worth saying so
            // where somebody grepping for TLS during an incident will find it.
            // This is the API talking to our own Postfix inside the compose
            // network, on a hop that never leaves the host. What Gmail saw
            // unencrypted was Postfix's onward delivery, governed by
            // smtp_tls_security_level. Different hop, different setting;
            // "fixing" this one would break submission and leave the leak open.
            await client.ConnectAsync(host, port, SecureSocketOptions.None, ct);
            if (s.EnvelopeSender is { } envelope)
            {
                // Explicit envelope sender: the Return-Path the receiving
                // server bounces to, deliberately different from the visible
                // From. Recipients are To + Cc, unfolded from the message.
                var recipients = mime.To.Mailboxes.Concat(mime.Cc.Mailboxes).ToList();
                await client.SendAsync(mime, envelope, recipients, ct);
            }
            else
            {
                await client.SendAsync(mime, ct);
            }
            await client.DisconnectAsync(true, ct);
        }
        catch (SmtpCommandException ex)
        {
            // Postfix said no — most usefully, the outbound gate's own words:
            // "Sending outside your organisation requires a verified domain."
            // Pass the reason through; a generic "send failed" would send the
            // admin hunting through server logs for a policy working as built.
            log.LogInformation(ex, "Send from {From} refused by SMTP", box.Address);
            return new SendResult(SendOutcome.Refused, null, null, CleanSmtpError(ex.Message));
        }
        catch (ServiceNotAuthenticatedException ex)
        {
            // Postfix demanded credentials. That is a configuration fault on
            // OUR side - this code is pointed at a port that requires SASL -
            // and calling it "unreachable" cost an hour on 3 September. Say
            // what it is.
            log.LogError(ex, "Send from {From} refused: Postfix on {Host}:{Port} requires " +
                             "authentication. The API must submit on the internal port.",
                         box.Address, host, port);
            return new SendResult(SendOutcome.Refused, null, null,
                "The mail server requires authentication on this port. This is a " +
                "server configuration fault, not a problem with your message.");
        }
        catch (Exception ex)
        {
            // Everything else: socket, DNS, timeout, unexpected disconnect.
            // The exception TYPE is in the log line; the response stays
            // generic because the caller cannot act on it.
            log.LogError(ex, "Send from {From} failed ({Kind})", box.Address, ex.GetType().Name);
            return new SendResult(SendOutcome.Unreachable, null, null,
                "The mail server could not be reached. Nothing was sent.");
        }

        // ---- File the Sent copy -----------------------------------------
        //  After the submit succeeds, never before: a Sent copy of a message
        //  that was refused would be a record of something that did not happen.
        var sent = await db.Folders.FirstOrDefaultAsync(
            f => f.MailboxId == box.Id && f.SpecialUse == "\\Sent", ct);
        if (sent is null)
        {
            // The message went out; only the filing failed. Say exactly that.
            log.LogError("Mailbox {Address} has no Sent folder — default-folders trigger missing",
                box.Address);
            return new SendResult(SendOutcome.SentButNotFiled, null, null, null);
        }

        var raw = mime.ToString();
        var attParts = MailContent.AttachmentParts(mime);

        // The Sent copy joins the conversation it answers.
        //
        // Without this, thread_id is set on every message people send US and
        // on none of the ones we send back, so a conversation renders as the
        // other side's half with our replies silently missing. That reads as
        // complete and is therefore worse than no threading at all.
        //
        // Same resolver the ingest worker calls, deliberately: one definition
        // of what a conversation is, in one place. The pending-batch argument
        // is empty because there is no batch here - one message, one call -
        // and mime already carries the In-Reply-To/References set above.
        var threadId = await MailThreads.ResolveAsync(
            db, box.Id, mime, new Dictionary<string, Guid>(), ct);

        var message = new Message
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            FolderId = sent.Id,
            ThreadId = threadId,
            MessageIdHeader = mime.MessageId,
            FromAddr = box.Address,
            FromName = isShared ? box.DisplayName ?? box.LocalPart : user?.DisplayName,
            ToAddrs = s.To.Select(a => a.Address).ToArray(),
            CcAddrs = s.Cc.Count > 0 ? s.Cc.Select(a => a.Address).ToArray() : null,
            Subject = mime.Subject,
            Snippet = MailContent.Snippet(mime),
            // Same as ingest: give search a body to index. Without this, mail
            // you sent would be findable by subject but not by what you wrote.
            BodyText = mime.TextBody ?? mime.HtmlBody,
            SentAt = DateTimeOffset.UtcNow,
            ReceivedAt = DateTimeOffset.UtcNow,
            // Who pressed send. Recorded for every send, not only shared ones:
            // one rule is easier to trust than "sometimes populated".
            SentByUserId = tenant.UserId,
            SizeBytes = raw.Length,
            IsRead = true,
            HasAttachments = attParts.Count > 0,
            RawBody = raw,
        };
        db.Messages.Add(message);

        // The draft this was composed from has become a sent message. Leaving
        // it in Drafts is how someone sends the same mail twice, having found
        // what looks like an unsent copy of it later.
        if (s.DraftId is Guid draftId)
        {
            var draftsFolder = await db.Folders.FirstOrDefaultAsync(
                f => f.MailboxId == box.Id && f.SpecialUse == "\\Drafts", ct);
            if (draftsFolder is not null)
            {
                var draft = await db.Messages.FirstOrDefaultAsync(
                    m => m.Id == draftId && m.MailboxId == box.Id
                         && m.FolderId == draftsFolder.Id, ct);
                if (draft is not null) db.Messages.Remove(draft);
            }
        }

        // Index the Sent copy's attachments so they show as chips and download
        // through the same part-index path as received mail.
        for (var i = 0; i < attParts.Count; i++)
        {
            var part = attParts[i];
            db.Attachments.Add(new Attachment
            {
                TenantId = box.TenantId,
                MessageId = message.Id,
                Filename = part.FileName ?? $"attachment-{i + 1}",
                ContentType = part.ContentType?.MimeType,
                SizeBytes = s.Attachments.ElementAtOrDefault(i)?.Content.LongLength ?? 0,
                PartIndex = i,
                // "pending", not "clean". Nothing on this platform scans an
                // attachment, so a row saying clean is a security claim we
                // cannot support - and it is worse than an honest unknown,
                // because a client would be right to trust it. Inbound mail
                // has always recorded pending; this makes outbound agree, so
                // the day a scanner exists it has one backlog, not two.
                ScanStatus = "pending",
            });
        }

        box.UsedBytes += message.SizeBytes;
        await db.SaveChangesAsync(ct);

        // Offer the recipients to the sender's address book. Off by default —
        // see ContactSettings.AutoSaveSent — and after the commit, because a
        // failure here must not lose a message that has already gone out.
        // tenant.UserId, NOT box.UserId: recipients learned from a send belong
        // to the HUMAN who pressed send. For a personal mailbox the two are the
        // same id; for a shared mailbox box.UserId is NULL, and passing it made
        // every delegated send silently skip contact auto-save.
        await autoSave.RecordAsync(db, tenant, tenant.UserId, [message], "recipient", ct);

        // Audited only when the mailbox is not your own. The question this
        // trail exists to answer is "who answered as admissions@"; a row for
        // every personal send would bury it. After the commit, like the
        // contact write above - a failure to record must never lose a message
        // that has already gone out.
        if (isShared)
            await audit.WriteAsync(
                "mail.sent_as",
                targetType: "mail.mailbox",
                targetId: box.Id.ToString(),
                after: new { messageId = message.Id, from = box.Address, recipients = s.To.Count },
                ct: ct,
                productCode: "mail");

        return new SendResult(SendOutcome.Sent, message.Id, message.FolderId, null);
    }

    /// <summary>
    /// Postfix's refusal, with the SMTP scaffolding trimmed off.
    ///
    /// Moved here with the send path: the outbound gate's own words ("Sending
    /// outside your organisation requires a verified domain") are the useful
    /// part, and a generic "send failed" would send an administrator hunting
    /// through server logs for a policy working exactly as built.
    /// </summary>
    private static string CleanSmtpError(string message)
    {
        var idx = message.LastIndexOf("rejected:", StringComparison.OrdinalIgnoreCase);
        var cleaned = idx >= 0 ? message[(idx + "rejected:".Length)..].Trim() : message.Trim();
        return cleaned.Length > 0 ? cleaned : "The mail server refused the message.";
    }
}
