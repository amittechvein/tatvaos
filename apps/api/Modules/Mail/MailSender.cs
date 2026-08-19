using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using MimeKit;
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
    Guid? DraftId = null);

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
        mime.Body = builder.ToMessageBody();

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
        //  :587, same path as system mail. The verified-domain outbound gate
        //  lives THERE, in sender-external-gate.cf — deliberately not
        //  re-implemented here, because two copies of one rule drift and the
        //  Postfix one is the one Linode was told about.
        var host = config["Smtp:Host"] ?? "postfix";
        var port = int.TryParse(config["Smtp:Port"], out var p) ? p : 587;

        try
        {
            using var client = new SmtpClient();
            await client.ConnectAsync(host, port, SecureSocketOptions.None, ct);
            await client.SendAsync(mime, ct);
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
        catch (Exception ex)
        {
            log.LogError(ex, "Send from {From} failed", box.Address);
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
