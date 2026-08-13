using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using MimeKit;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Mail.Endpoints;

/// <summary>
/// The Mail client's API — what mail.tatvaos.com talks to.
///
/// ─────────────────────────────────────────────────────────────────────────
///  EVERY handler resolves the caller's OWN mailbox first, from the
///  authenticated user id, and every query is scoped through that mailbox.
///  A message id arriving in a URL proves nothing — ids leak, get bookmarked
///  and get guessed. The mailbox scope (plus RLS underneath) is what makes a
///  foreign id a 404 rather than a disclosure.
///
///  Shared mailboxes (mail.mailbox_permissions) are deliberately absent from
///  this file. Delegation needs its own attribution rules — "who read it"
///  must stay the human, not the mailbox — and bolting it on here as a
///  second lookup path would decide those rules by accident.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailEndpoints
{
    public static void MapMailEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/mail")
            .RequireAuthorization("User")
            .WithTags("Mail");

        g.MapGet("/bootstrap", BootstrapAsync);
        g.MapGet("/folders", FoldersAsync);
        g.MapGet("/folders/{folderId:guid}/messages", ListMessagesAsync);
        g.MapGet("/search", SearchAsync);
        g.MapGet("/messages/{id:guid}", GetMessageAsync);
        g.MapPost("/messages/{id:guid}/read", SetReadAsync);
        g.MapPost("/messages/{id:guid}/flag", SetFlagAsync);
        g.MapPost("/messages/{id:guid}/move", MoveAsync);
        g.MapDelete("/messages/{id:guid}", DeleteAsync);
        g.MapGet("/messages/{id:guid}/attachments/{attachmentId:guid}", DownloadAttachmentAsync);
        g.MapPost("/send", SendAsync);
    }

    // ------------------------------------------------------------------
    //  The caller's own active mailbox. NULL is a normal state, not an
    //  error — a Payroll-only user, or an admin with no mail product.
    // ------------------------------------------------------------------
    private static Task<Mailbox?> OwnMailboxAsync(AppDbContext db, TenantContext tenant, CancellationToken ct) =>
        // The null-guard matters: shared mailboxes have user_id NULL, and a
        // principal that somehow carried no user id must match NONE of them,
        // not all of them.
        tenant.UserId is not Guid uid
            ? Task.FromResult<Mailbox?>(null)
            : db.Mailboxes.FirstOrDefaultAsync(m => m.UserId == uid && m.IsActive, ct);

    /// <summary>
    /// Stable client-facing name for a special folder, so the inbox is
    /// /mail/inbox in every mailbox rather than a GUID that differs per user.
    /// Custom folders have no slug and are addressed by id.
    /// </summary>
    private static string? SlugFor(string? specialUse) => specialUse switch
    {
        "\\Inbox" => "inbox",
        "\\Sent" => "sent",
        "\\Drafts" => "drafts",
        "\\Junk" => "junk",
        "\\Trash" => "trash",
        _ => null,
    };

    private static async Task<List<object>> FolderListAsync(
        AppDbContext db, Guid mailboxId, CancellationToken ct)
    {
        var folders = await db.Folders.AsNoTracking()
            .Where(f => f.MailboxId == mailboxId)
            .OrderBy(f => f.CreatedAt)
            .ToListAsync(ct);

        // One grouped query for every folder's counts, not one query per
        // folder — this runs on every mailbox open.
        var counts = await db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == mailboxId)
            .GroupBy(m => m.FolderId)
            .Select(gr => new { FolderId = gr.Key, Total = gr.Count(), Unread = gr.Count(x => !x.IsRead) })
            .ToDictionaryAsync(x => x.FolderId, ct);

        // Special folders in the order every mail client uses; custom ones after.
        static int Rank(string? specialUse) => specialUse switch
        {
            "\\Inbox" => 0, "\\Drafts" => 1, "\\Sent" => 2, "\\Junk" => 3, "\\Trash" => 4, _ => 5,
        };

        return folders
            .OrderBy(f => Rank(f.SpecialUse)).ThenBy(f => f.Name)
            .Select(f => (object)new
            {
                id = f.Id,
                // "INBOX" is an IMAP keyword, not a label anyone should read.
                name = f.SpecialUse == "\\Inbox" ? "Inbox" : f.Name,
                specialUse = f.SpecialUse,
                slug = SlugFor(f.SpecialUse),
                unreadCount = counts.TryGetValue(f.Id, out var c) ? c.Unread : 0,
                totalCount = counts.TryGetValue(f.Id, out var t) ? t.Total : 0,
            })
            .ToList();
    }

    // ------------------------------------------------------------------
    //  One definition of "matches", used by folder listing and by the
    //  cross-folder search endpoint, so the two can never disagree about
    //  what a query means.
    //
    //  TWO CLAUSES ON PURPOSE:
    //
    //   * The tsvector clause is the real search — it covers the BODY, it is
    //     backed by the GIN index (15-mail-search.sql), and it understands
    //     quoted phrases and -exclusions via websearch_to_tsquery.
    //
    //   * The ILIKE clause is what makes typing feel right. A tsquery matches
    //     whole lexemes, so "prax" finds nothing in "Prakash" — but a person
    //     typing into a search box expects partial words to narrow as they
    //     go. It is restricted to the short columns so it stays cheap.
    //
    //  Both, OR'd: full-text power without a search box that appears broken
    //  until you finish typing the word.
    // ------------------------------------------------------------------
    private static IQueryable<Message> ApplySearch(IQueryable<Message> query, string q)
    {
        var term = q.Trim();
        var pattern = $"%{term}%";

        return query.Where(m =>
            (m.SearchVector != null
             && m.SearchVector.Matches(EF.Functions.WebSearchToTsQuery("simple", term)))
            || EF.Functions.ILike(m.Subject ?? "", pattern)
            || EF.Functions.ILike(m.FromAddr ?? "", pattern)
            || EF.Functions.ILike(m.FromName ?? "", pattern)
            || EF.Functions.ILike(m.Snippet ?? "", pattern));
    }

    /// <summary>
    /// Search the whole mailbox, not one folder.
    ///
    /// The client used to filter the rows it had already loaded, in the
    /// browser — so a search for last month's mail found nothing and looked
    /// identical to "no such message". This searches every folder and returns
    /// which folder each hit lives in, so the result can be opened.
    /// </summary>
    private static async Task<IResult> SearchAsync(
        string? q, int? skip, int? take, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.Ok(new { total = 0, messages = Array.Empty<object>() });

        var term = (q ?? "").Trim();
        if (term.Length == 0)
            // An empty query is not "everything" — that is the folder listing,
            // and returning the whole mailbox here would be a surprise.
            return Results.Ok(new { total = 0, messages = Array.Empty<object>() });

        var query = ApplySearch(
            db.Messages.AsNoTracking().Where(m => m.MailboxId == box.Id), term);

        var total = await query.CountAsync(ct);

        var rows = await query
            .OrderByDescending(m => m.ReceivedAt)
            .Skip(Math.Max(0, skip ?? 0))
            .Take(Math.Clamp(take ?? 50, 1, 100))
            .Select(m => new
            {
                m.Id, m.FolderId, m.ThreadId, m.FromName, m.FromAddr, m.ToAddrs,
                m.CcAddrs, m.Subject, m.Snippet, m.SentAt, m.ReceivedAt,
                m.SizeBytes, m.IsRead, m.IsFlagged, m.HasAttachments,
            })
            .ToListAsync(ct);

        // Folder names for the hits, so a result can say where it lives —
        // one query for the page rather than one per row.
        var folderIds = rows.Select(r => r.FolderId).Distinct().ToList();
        var folderNames = await db.Folders.AsNoTracking()
            .Where(f => folderIds.Contains(f.Id))
            .ToDictionaryAsync(
                f => f.Id,
                f => new { name = f.SpecialUse == "\\Inbox" ? "Inbox" : f.Name, slug = SlugFor(f.SpecialUse) },
                ct);

        return Results.Ok(new
        {
            total,
            messages = rows.Select(m => new
            {
                id = m.Id,
                folderId = m.FolderId,
                folderName = folderNames.TryGetValue(m.FolderId, out var f) ? f.name : null,
                folderSlug = folderNames.TryGetValue(m.FolderId, out var f2) ? f2.slug : null,
                threadId = m.ThreadId,
                from = new { name = m.FromName, email = m.FromAddr ?? "" },
                to = (m.ToAddrs ?? []).Select(a => new { name = (string?)null, email = a }).ToList(),
                cc = (m.CcAddrs ?? []).Select(a => new { name = (string?)null, email = a }).ToList(),
                subject = m.Subject ?? "",
                snippet = m.Snippet ?? "",
                sentAt = m.SentAt ?? m.ReceivedAt,
                receivedAt = m.ReceivedAt,
                sizeBytes = m.SizeBytes,
                isRead = m.IsRead,
                isFlagged = m.IsFlagged,
                hasAttachments = m.HasAttachments,
            }).ToList(),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> BootstrapAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null)
            // 200 with null, not 404. "You have no mailbox" is an answer the
            // client renders, not a failure it retries.
            return Results.Ok(new { mailbox = (object?)null, folders = Array.Empty<object>() });

        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);

        return Results.Ok(new
        {
            mailbox = new
            {
                id = box.Id,
                address = box.Address,
                displayName = user?.DisplayName ?? box.LocalPart,
                type = box.Type,
                quotaBytes = box.QuotaBytes,
                usedBytes = box.UsedBytes,
            },
            folders = await FolderListAsync(db, box.Id, ct),
        });
    }

    private static async Task<IResult> FoldersAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.Ok(new { folders = Array.Empty<object>() });
        return Results.Ok(new { folders = await FolderListAsync(db, box.Id, ct) });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ListMessagesAsync(
        Guid folderId, AppDbContext db, TenantContext tenant,
        string? q, int? skip, int? take, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var folder = await db.Folders.AsNoTracking()
            .FirstOrDefaultAsync(f => f.Id == folderId && f.MailboxId == box.Id, ct);
        if (folder is null) return Results.NotFound();

        var query = db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == box.Id && m.FolderId == folderId);

        if (!string.IsNullOrWhiteSpace(q))
            query = ApplySearch(query, q);

        var total = await query.CountAsync(ct);

        // Columns first, shaping second. The nested Select over to_addrs is
        // deliberately done in memory — asking EF to translate it invites a
        // runtime translation failure on a query that compiles fine.
        var rows = await query
            .OrderByDescending(m => m.ReceivedAt)
            .Skip(Math.Max(0, skip ?? 0))
            .Take(Math.Clamp(take ?? 50, 1, 100))
            .Select(m => new
            {
                m.Id, m.FolderId, m.ThreadId, m.FromName, m.FromAddr, m.ToAddrs,
                m.Subject, m.Snippet, m.SentAt, m.ReceivedAt, m.SizeBytes,
                m.IsRead, m.IsFlagged, m.HasAttachments,
            })
            .ToListAsync(ct);

        // Attachment names ride along with the list — the client renders them
        // as chips on the row, the way every mail client's list does. One
        // query for the whole page, not one per message.
        var pageIds = rows.Select(r => r.Id).ToList();
        var chips = (await db.Attachments.AsNoTracking()
                .Where(a => pageIds.Contains(a.MessageId))
                .OrderBy(a => a.PartIndex)
                .Select(a => new { a.MessageId, a.Id, a.Filename, a.ContentType, a.SizeBytes })
                .ToListAsync(ct))
            .ToLookup(a => a.MessageId);

        var messages = rows.Select(m => new
        {
            id = m.Id,
            folderId = m.FolderId,
            threadId = m.ThreadId,
            from = new { name = m.FromName, email = m.FromAddr ?? "" },
            to = m.ToAddrs.Select(a => new { email = a }).ToArray(),
            subject = m.Subject ?? "",
            snippet = m.Snippet ?? "",
            sentAt = m.SentAt ?? m.ReceivedAt,
            receivedAt = m.ReceivedAt,
            sizeBytes = m.SizeBytes,
            isRead = m.IsRead,
            isFlagged = m.IsFlagged,
            hasAttachments = m.HasAttachments,
            attachments = chips[m.Id].Select(a => new
            {
                id = a.Id,
                filename = a.Filename,
                contentType = a.ContentType ?? "application/octet-stream",
                sizeBytes = a.SizeBytes,
                isInline = false,
            }).ToArray(),
        });

        return Results.Ok(new { total, messages });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> GetMessageAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null) return Results.NotFound();

        string? bodyHtml = null, bodyText = null;
        if (!string.IsNullOrEmpty(m.RawBody))
        {
            try
            {
                var mime = MailContent.Parse(m.RawBody);
                bodyHtml = mime.HtmlBody;
                bodyText = mime.TextBody;
            }
            catch
            {
                // A message that fails to parse still renders its snippet
                // rather than 500ing the reading pane. The raw copy is kept;
                // a better parser can revisit it.
                bodyText = m.Snippet;
            }
        }

        var attachments = await db.Attachments.AsNoTracking()
            .Where(a => a.MessageId == m.Id)
            .OrderBy(a => a.PartIndex)
            .Select(a => new
            {
                id = a.Id,
                filename = a.Filename,
                contentType = a.ContentType ?? "application/octet-stream",
                sizeBytes = a.SizeBytes,
                isInline = false,
            })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            id = m.Id,
            folderId = m.FolderId,
            threadId = m.ThreadId,
            from = new { name = m.FromName, email = m.FromAddr ?? "" },
            to = m.ToAddrs.Select(a => new { email = a }).ToArray(),
            cc = (m.CcAddrs ?? []).Select(a => new { email = a }).ToArray(),
            subject = m.Subject ?? "",
            snippet = m.Snippet ?? "",
            bodyHtml,
            bodyText,
            sentAt = m.SentAt ?? m.ReceivedAt,
            receivedAt = m.ReceivedAt,
            sizeBytes = m.SizeBytes,
            isRead = m.IsRead,
            isFlagged = m.IsFlagged,
            hasAttachments = m.HasAttachments,
            attachments,
        });
    }

    // ------------------------------------------------------------------
    public sealed record SetReadRequest(bool IsRead);
    public sealed record SetFlagRequest(bool IsFlagged);
    public sealed record MoveRequest(Guid FolderId);

    private static async Task<IResult> SetReadAsync(
        Guid id, SetReadRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null) return Results.NotFound();

        m.IsRead = req.IsRead;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { m.Id, m.IsRead });
    }

    private static async Task<IResult> SetFlagAsync(
        Guid id, SetFlagRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null) return Results.NotFound();

        m.IsFlagged = req.IsFlagged;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { m.Id, m.IsFlagged });
    }

    private static async Task<IResult> MoveAsync(
        Guid id, MoveRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null) return Results.NotFound();

        // The destination must be MY folder. Without this check a crafted
        // folder id would let a message be filed into another mailbox's tree.
        var target = await db.Folders.FirstOrDefaultAsync(
            f => f.Id == req.FolderId && f.MailboxId == box.Id, ct);
        if (target is null)
            return Results.BadRequest(new { error = "That folder does not exist." });

        m.FolderId = target.Id;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { m.Id, m.FolderId });
    }

    /// <summary>
    /// Delete follows the convention every mail client has taught people:
    /// first delete moves to Trash, delete FROM Trash is permanent. Nothing
    /// is ever permanently removed by a single click from the inbox.
    /// </summary>
    private static async Task<IResult> DeleteAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null) return Results.NotFound();

        var currentFolder = await db.Folders.AsNoTracking()
            .FirstOrDefaultAsync(f => f.Id == m.FolderId, ct);

        if (currentFolder?.SpecialUse == "\\Trash")
        {
            db.Messages.Remove(m);
            // Attachments cascade in the database; the quota ledger does not.
            box.UsedBytes = Math.Max(0, box.UsedBytes - m.SizeBytes);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { deleted = true });
        }

        var trash = await db.Folders.FirstOrDefaultAsync(
            f => f.MailboxId == box.Id && f.SpecialUse == "\\Trash", ct);
        if (trash is null)
            return Results.BadRequest(new { error = "This mailbox has no Trash folder." });

        m.FolderId = trash.Id;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { deleted = false, movedTo = trash.Id });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> DownloadAttachmentAsync(
        Guid id, Guid attachmentId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var m = await db.Messages.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (m is null || string.IsNullOrEmpty(m.RawBody)) return Results.NotFound();

        var att = await db.Attachments.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == attachmentId && a.MessageId == m.Id, ct);
        if (att?.PartIndex is not int index) return Results.NotFound();

        var parts = MailContent.AttachmentParts(MailContent.Parse(m.RawBody));
        if (index < 0 || index >= parts.Count) return Results.NotFound();

        // A declared attachment with no body content is malformed MIME, not
        // impossible MIME. 404 beats a 500 on somebody else's bad message.
        var part = parts[index];
        if (part.Content is null) return Results.NotFound();

        using var buffer = new MemoryStream();
        await part.Content.DecodeToAsync(buffer, ct);

        // application/octet-stream regardless of the declared type: the bytes
        // are sender-controlled, and serving text/html here would hand any
        // correspondent a stored-XSS page on our origin. Browsers download
        // octet-stream; they do not render it.
        return Results.File(buffer.ToArray(), "application/octet-stream", att.Filename);
    }

    // ------------------------------------------------------------------
    //  Send accepts multipart/form-data, not JSON — because it now carries
    //  file attachments as well as a rich HTML body. Fields: to, cc, subject,
    //  bodyText, bodyHtml, inReplyToId; files under the "files" part.
    // ------------------------------------------------------------------

    /// <summary>
    /// The whole message, attachments included, may not exceed this. Matches
    /// Postfix's message_size_limit (25 MB, the same ceiling Gmail enforces) —
    /// gating here means an over-size message is refused with a clear reason
    /// instead of accepted and then bounced by Postfix minutes later.
    /// </summary>
    private const long MaxMessageBytes = 26_214_400;

    private static async Task<IResult> SendAsync(
        HttpRequest request, AppDbContext db, TenantContext tenant, IConfiguration config,
        ILoggerFactory logFactory, ContactAutoSave autoSave, CancellationToken ct)
    {
        var log = logFactory.CreateLogger("MailSend");

        if (!request.HasFormContentType)
            return Results.BadRequest(new { error = "Send expects a multipart form." });
        var form = await request.ReadFormAsync(ct);

        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null)
            return Results.BadRequest(new { error = "You have no mailbox to send from." });

        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);

        // ---- Recipients -------------------------------------------------
        var to = ParseAddressLine(form["to"]);
        var cc = ParseAddressLine(form["cc"]);
        if (to is null || cc is null)
            return Results.BadRequest(new { error = "One of the addresses is not valid." });
        if (to.Count == 0)
            return Results.BadRequest(new { error = "At least one recipient is required." });

        var subject = form["subject"].ToString().Trim();
        var bodyText = form["bodyText"].ToString();
        var bodyHtml = form["bodyHtml"].ToString();
        var files = request.Form.Files;

        // ---- Size gate BEFORE reading any file into memory --------------
        long total = bodyText.Length + bodyHtml.Length;
        foreach (var f in files) total += f.Length;
        if (total > MaxMessageBytes)
            return Results.BadRequest(new
            {
                error = "This message is over the 25 MB limit. Remove an attachment and try again.",
            });

        // ---- Compose with a body builder --------------------------------
        //  HtmlBody + TextBody makes a multipart/alternative the receiver's
        //  client picks from; attachments make it multipart/mixed around that.
        //  MimeKit assembles the right structure from what we set here.
        var builder = new BodyBuilder();
        if (!string.IsNullOrWhiteSpace(bodyHtml)) builder.HtmlBody = bodyHtml;
        if (!string.IsNullOrWhiteSpace(bodyText)) builder.TextBody = bodyText;
        else if (string.IsNullOrWhiteSpace(bodyHtml)) builder.TextBody = "";

        foreach (var file in files)
        {
            await using var stream = file.OpenReadStream();
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct);
            var contentType = ContentType.Parse(
                string.IsNullOrWhiteSpace(file.ContentType) ? "application/octet-stream" : file.ContentType);
            builder.Attachments.Add(file.FileName, ms.ToArray(), contentType);
        }

        var mime = new MimeMessage();
        mime.From.Add(new MailboxAddress(user?.DisplayName ?? box.LocalPart, box.Address));
        foreach (var a in to) mime.To.Add(a);
        foreach (var a in cc) mime.Cc.Add(a);
        mime.Subject = subject;
        mime.Body = builder.ToMessageBody();

        // Threading headers, so replies land in the same conversation in
        // every client that receives them — including ours, later.
        if (Guid.TryParse(form["inReplyToId"], out var replyId))
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
            return Results.UnprocessableEntity(new { error = CleanSmtpError(ex.Message) });
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Send from {From} failed", box.Address);
            return Results.Problem("The mail server could not be reached. Nothing was sent.",
                statusCode: StatusCodes.Status502BadGateway);
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
            return Results.Ok(new { id = (Guid?)null, warning = "Sent, but no Sent folder exists to file a copy in." });
        }

        var raw = mime.ToString();
        var attParts = MailContent.AttachmentParts(mime);
        var message = new Message
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            FolderId = sent.Id,
            MessageIdHeader = mime.MessageId,
            FromAddr = box.Address,
            FromName = user?.DisplayName,
            ToAddrs = to.Select(a => a.Address).ToArray(),
            CcAddrs = cc.Count > 0 ? cc.Select(a => a.Address).ToArray() : null,
            Subject = mime.Subject,
            Snippet = MailContent.Snippet(mime),
            // Same as ingest: give search a body to index. Without this, mail
            // you sent would be findable by subject but not by what you wrote.
            BodyText = mime.TextBody ?? mime.HtmlBody,
            SentAt = DateTimeOffset.UtcNow,
            ReceivedAt = DateTimeOffset.UtcNow,
            SizeBytes = raw.Length,
            IsRead = true,
            HasAttachments = attParts.Count > 0,
            RawBody = raw,
        };
        db.Messages.Add(message);

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
                SizeBytes = files.ElementAtOrDefault(i)?.Length ?? 0,
                PartIndex = i,
                ScanStatus = "clean",
            });
        }

        box.UsedBytes += message.SizeBytes;
        await db.SaveChangesAsync(ct);

        // Offer the recipients to the sender's address book. Off by default —
        // see ContactSettings.AutoSaveSent — and after the commit, because a
        // failure here must not lose a message that has already gone out.
        await autoSave.RecordAsync(db, tenant, box.UserId, [message], "recipient", ct);

        return Results.Ok(new { id = message.Id, folderId = message.FolderId });
    }

    /// <summary>
    /// Parses a "a@x, b@y; c@z" recipient line. Returns null if any address is
    /// malformed (the caller turns that into a 400), an empty list for a blank
    /// line (a valid empty Cc).
    /// </summary>
    private static List<MailboxAddress>? ParseAddressLine(string? line)
    {
        var result = new List<MailboxAddress>();
        if (string.IsNullOrWhiteSpace(line)) return result;
        foreach (var s in line.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!MailboxAddress.TryParse(s, out var parsed)) return null;
            result.Add(parsed);
        }
        return result;
    }

    /// <summary>
    /// SMTP errors arrive as "5.7.1 &lt;addr&gt;: Recipient address rejected: {reason}".
    /// The reason is the part a person can act on; the protocol prefix is noise.
    /// </summary>
    private static string CleanSmtpError(string message)
    {
        var idx = message.LastIndexOf("rejected:", StringComparison.OrdinalIgnoreCase);
        var cleaned = idx >= 0 ? message[(idx + "rejected:".Length)..].Trim() : message.Trim();
        return cleaned.Length > 0 ? cleaned : "The mail server refused the message.";
    }
}
