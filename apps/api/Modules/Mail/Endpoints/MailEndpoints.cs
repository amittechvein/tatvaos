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
        g.MapGet("/threads/{threadId:guid}/messages", ThreadAsync);
        g.MapGet("/messages/{id:guid}", GetMessageAsync);
        g.MapPost("/messages/{id:guid}/read", SetReadAsync);
        g.MapPost("/messages/{id:guid}/flag", SetFlagAsync);
        g.MapPost("/messages/{id:guid}/move", MoveAsync);
        g.MapDelete("/messages/{id:guid}", DeleteAsync);
        g.MapGet("/messages/{id:guid}/attachments/{attachmentId:guid}", DownloadAttachmentAsync);
        g.MapPost("/send", SendAsync);
        g.MapGet("/directory", DirectoryAsync);

        g.MapGet("/blocked", ListBlockedAsync);
        g.MapPost("/blocked", BlockSenderAsync);
        g.MapDelete("/blocked/{id:guid}", UnblockSenderAsync);

        g.MapGet("/signature", GetSignatureAsync);
        g.MapPut("/signature", SaveSignatureAsync);

        g.MapGet("/drafts/{id:guid}", GetDraftAsync);
        g.MapPost("/drafts", CreateDraftAsync);
        g.MapPut("/drafts/{id:guid}", UpdateDraftAsync);
        g.MapDelete("/drafts/{id:guid}", DeleteDraftAsync);

        g.MapGet("/filters", ListFiltersAsync);
        g.MapPost("/filters", CreateFilterAsync);
        g.MapPut("/filters/{id:guid}", UpdateFilterAsync);
        g.MapDelete("/filters/{id:guid}", DeleteFilterAsync);
    }

    // ------------------------------------------------------------------
    //  Directory - who you can address inside your own organisation.
    //
    //  Backs the composer's "@" recipient picker. It is a MAILBOX lookup,
    //  not a user lookup: someone with a Core account but no mail product
    //  has no address to offer, and offering their name would produce a
    //  message that bounces.
    //
    //  Tenant scope comes from the global query filters on Mailbox and User,
    //  so this cannot name a person in another organisation. That is the
    //  whole security story for this endpoint, and it is why the query is
    //  written against db.Mailboxes rather than anything IgnoreQueryFilters.
    // ------------------------------------------------------------------
    private static async Task<IResult> DirectoryAsync(
        string? q, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var self = await OwnMailboxAsync(db, tenant, ct);

        // Capped before it reaches the query: this fires on every keystroke,
        // and an unbounded term is a cheap way to make Postgres work hard.
        var term = (q ?? string.Empty).Trim();
        if (term.Length > 100) term = term[..100];

        // % and _ are LIKE wildcards. Someone typing "_" is looking for an
        // underscore in an address, not for "any character".
        var escaped = term
            .Replace("\\", "\\\\")
            .Replace("%", "\\%")
            .Replace("_", "\\_");

        var query =
            from m in db.Mailboxes.AsNoTracking()
            join u in db.Users.AsNoTracking() on m.UserId equals (Guid?)u.Id
            where m.IsActive && m.Type == "user"
            select new { m.Id, m.Address, u.DisplayName };

        // Shared mailboxes and groups are excluded by Type above; you are
        // excluded here, because offering to mail yourself is never the
        // thing being asked for.
        if (self is not null)
            query = query.Where(x => x.Id != self.Id);

        if (escaped.Length > 0)
            query = query.Where(x =>
                EF.Functions.ILike(x.Address, $"%{escaped}%", "\\") ||
                EF.Functions.ILike(x.DisplayName, $"%{escaped}%", "\\"));

        var matches = await query
            .OrderBy(x => x.DisplayName)
            .Take(20)
            .ToListAsync(ct);

        // Prefix matches float to the top, and that ordering is done HERE
        // rather than in SQL. A CASE-expression OrderBy is the kind of thing
        // that translates on one provider and throws at runtime on another,
        // and there is no environment to find that out in before production.
        // Twenty rows in memory costs nothing.
        var people = matches
            .OrderBy(x => x.Address.StartsWith(term, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(x => x.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Take(8)
            .Select(x => new { email = x.Address, name = x.DisplayName })
            .ToList();

        return Results.Ok(new { people });
    }

    // ------------------------------------------------------------------
    //  Blocked senders.
    //
    //  Blocking files future mail into Junk at ingest — it never refuses the
    //  message at SMTP. A rejection would confirm to a spammer that the
    //  address is live, and would make one person's preference a
    //  domain-reputation event. Nothing is lost meanwhile, so unblocking takes
    //  effect on the next message with no gap to reconstruct.
    // ------------------------------------------------------------------
    public sealed record BlockRequest(string Address);

    private static async Task<IResult> ListBlockedAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.Ok(new { blocked = Array.Empty<object>() });

        var blocked = await db.BlockedSenders.AsNoTracking()
            .Where(x => x.MailboxId == box.Id)
            .OrderBy(x => x.Address)
            .Select(x => new { id = x.Id, address = x.Address, createdAt = x.CreatedAt })
            .ToListAsync(ct);

        return Results.Ok(new { blocked });
    }

    private static async Task<IResult> BlockSenderAsync(
        BlockRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.BadRequest(new { error = "You have no mailbox." });

        if (!MailboxAddress.TryParse(req.Address?.Trim() ?? "", out var parsed))
            return Results.BadRequest(new { error = "That is not a valid email address." });

        // Lowercased on write so the ingest worker's check is plain equality.
        var address = parsed.Address.ToLowerInvariant();

        // Blocking yourself would divert your own Sent-to-self mail and reads
        // as a bug rather than a choice.
        if (address == box.Address.ToLowerInvariant())
            return Results.BadRequest(new { error = "You cannot block your own address." });

        var already = await db.BlockedSenders
            .FirstOrDefaultAsync(x => x.MailboxId == box.Id && x.Address == address, ct);
        if (already is not null)
            // Idempotent: blocking twice is the same state, not an error.
            return Results.Ok(new { id = already.Id, address = already.Address });

        var row = new BlockedSender
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            Address = address,
        };
        db.BlockedSenders.Add(row);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { id = row.Id, address = row.Address });
    }

    private static async Task<IResult> UnblockSenderAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var row = await db.BlockedSenders
            .FirstOrDefaultAsync(x => x.Id == id && x.MailboxId == box.Id, ct);
        if (row is null) return Results.NotFound();

        db.BlockedSenders.Remove(row);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { unblocked = true });
    }

    // ------------------------------------------------------------------
    //  Signature — one per mailbox, HTML and plain text together.
    // ------------------------------------------------------------------
    public sealed record SignatureRequest(
        string BodyHtml, string BodyText, bool Enabled, bool IncludeOnReply);

    /// <summary>
    /// A mailbox with no signature row yet is "off, with nothing in it" — not
    /// an error and not a 404. The editor opens empty and the first save
    /// creates the row.
    /// </summary>
    private static object ShapeSignature(Signature? s) => new
    {
        bodyHtml = s?.BodyHtml ?? "",
        bodyText = s?.BodyText ?? "",
        enabled = s?.Enabled ?? false,
        includeOnReply = s?.IncludeOnReply ?? false,
    };

    private static async Task<IResult> GetSignatureAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.Ok(ShapeSignature(null));

        var sig = await db.Signatures.AsNoTracking()
            .FirstOrDefaultAsync(s => s.MailboxId == box.Id, ct);
        return Results.Ok(ShapeSignature(sig));
    }

    private static async Task<IResult> SaveSignatureAsync(
        SignatureRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.BadRequest(new { error = "You have no mailbox." });

        // This is the person's own content going into their own outgoing mail,
        // so it is not attacker-controlled the way a received message is. It is
        // still user input that ends up in an HTML body, and a size cap is the
        // difference between a signature and a payload.
        const int MaxSignatureChars = 20_000;
        var html = req.BodyHtml ?? "";
        var text = req.BodyText ?? "";
        if (html.Length > MaxSignatureChars || text.Length > MaxSignatureChars)
            return Results.BadRequest(new { error = "That signature is too long." });

        var sig = await db.Signatures.FirstOrDefaultAsync(s => s.MailboxId == box.Id, ct);
        if (sig is null)
        {
            sig = new Signature { TenantId = box.TenantId, MailboxId = box.Id };
            db.Signatures.Add(sig);
        }

        sig.BodyHtml = html;
        sig.BodyText = text;
        sig.Enabled = req.Enabled;
        sig.IncludeOnReply = req.IncludeOnReply;
        sig.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.Ok(ShapeSignature(sig));
    }

    // ------------------------------------------------------------------
    //  Drafts.
    //
    //  A draft is a Message in the Drafts folder, not a table of its own. It
    //  already needs every field a message has, it should appear in that folder
    //  and in search like anything else, and a separate table would mean two
    //  shapes for one thing plus a migration on the day a draft becomes a sent
    //  message.
    //
    //  ATTACHMENTS ARE NOT SAVED WITH A DRAFT. Files live in the browser until
    //  send; persisting them needs object storage that does not exist yet. The
    //  client has to say so rather than implying they are safe — someone who
    //  closes the window believing their attachment was kept has lost work.
    // ------------------------------------------------------------------
    public sealed record DraftRequest(
        string? To, string? Cc, string? Bcc, string? Subject,
        string? BodyText, string? BodyHtml);

    private static async Task<(Mailbox? Box, Folder? Drafts)> DraftsFolderAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return (null, null);
        var folder = await db.Folders.FirstOrDefaultAsync(
            f => f.MailboxId == box.Id && f.SpecialUse == "\\Drafts", ct);
        return (box, folder);
    }

    /// <summary>
    /// The stored MIME for a draft. Bcc goes in these headers and stays there:
    /// a draft is never transmitted, so this is the one place a Bcc line can
    /// live without leaking it to anybody.
    /// </summary>
    private static MimeMessage DraftMime(DraftRequest req, Mailbox box, string? displayName)
    {
        var builder = new BodyBuilder();
        if (!string.IsNullOrWhiteSpace(req.BodyHtml)) builder.HtmlBody = req.BodyHtml;
        builder.TextBody = req.BodyText ?? "";

        var mime = new MimeMessage();
        mime.From.Add(new MailboxAddress(displayName ?? box.LocalPart, box.Address));
        foreach (var a in ParseAddressLine(req.To) ?? []) mime.To.Add(a);
        foreach (var a in ParseAddressLine(req.Cc) ?? []) mime.Cc.Add(a);
        foreach (var a in ParseAddressLine(req.Bcc) ?? []) mime.Bcc.Add(a);
        mime.Subject = req.Subject?.Trim() ?? "";
        mime.Body = builder.ToMessageBody();
        return mime;
    }

    private static async Task<IResult> CreateDraftAsync(
        DraftRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (box, drafts) = await DraftsFolderAsync(db, tenant, ct);
        if (box is null) return Results.BadRequest(new { error = "You have no mailbox." });
        if (drafts is null) return Results.BadRequest(new { error = "This mailbox has no Drafts folder." });

        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);

        var mime = DraftMime(req, box, user?.DisplayName);
        var raw = mime.ToString();
        var ccList = (ParseAddressLine(req.Cc) ?? []).Select(a => a.Address).ToArray();

        var message = new Message
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            FolderId = drafts.Id,
            ImapUid = drafts.UidNext,
            FromAddr = box.Address,
            FromName = user?.DisplayName,
            ToAddrs = (ParseAddressLine(req.To) ?? []).Select(a => a.Address).ToArray(),
            CcAddrs = ccList.Length > 0 ? ccList : null,
            Subject = mime.Subject,
            Snippet = MailContent.Snippet(mime),
            BodyText = mime.TextBody ?? mime.HtmlBody,
            ReceivedAt = DateTimeOffset.UtcNow,
            SizeBytes = raw.Length,
            // A draft is something you wrote; it has never been unread.
            IsRead = true,
            RawBody = raw,
        };
        drafts.UidNext++;

        db.Messages.Add(message);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = message.Id });
    }

    private static async Task<IResult> UpdateDraftAsync(
        Guid id, DraftRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (box, drafts) = await DraftsFolderAsync(db, tenant, ct);
        if (box is null || drafts is null) return Results.NotFound();

        // Scoped to the Drafts folder as well as the mailbox: this endpoint
        // must not become a way to rewrite a message already sent or received.
        var message = await db.Messages.FirstOrDefaultAsync(
            m => m.Id == id && m.MailboxId == box.Id && m.FolderId == drafts.Id, ct);
        if (message is null) return Results.NotFound();

        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);

        var mime = DraftMime(req, box, user?.DisplayName);
        var raw = mime.ToString();
        var ccList = (ParseAddressLine(req.Cc) ?? []).Select(a => a.Address).ToArray();

        message.ToAddrs = (ParseAddressLine(req.To) ?? []).Select(a => a.Address).ToArray();
        message.CcAddrs = ccList.Length > 0 ? ccList : null;
        message.Subject = mime.Subject;
        message.Snippet = MailContent.Snippet(mime);
        message.BodyText = mime.TextBody ?? mime.HtmlBody;
        message.SizeBytes = raw.Length;
        message.RawBody = raw;
        message.ReceivedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = message.Id });
    }

    private static async Task<IResult> GetDraftAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (box, drafts) = await DraftsFolderAsync(db, tenant, ct);
        if (box is null || drafts is null) return Results.NotFound();

        var message = await db.Messages.AsNoTracking().FirstOrDefaultAsync(
            m => m.Id == id && m.MailboxId == box.Id && m.FolderId == drafts.Id, ct);
        if (message is null || string.IsNullOrEmpty(message.RawBody)) return Results.NotFound();

        // Re-parsed rather than rebuilt from the columns, because Bcc exists
        // only in the stored MIME.
        var mime = MailContent.Parse(message.RawBody);

        return Results.Ok(new
        {
            id = message.Id,
            to = string.Join(", ", MailContent.Addresses(mime.To)),
            cc = string.Join(", ", MailContent.Addresses(mime.Cc)),
            bcc = string.Join(", ", MailContent.Addresses(mime.Bcc)),
            subject = mime.Subject ?? "",
            bodyText = mime.TextBody ?? "",
            bodyHtml = mime.HtmlBody ?? "",
        });
    }

    private static async Task<IResult> DeleteDraftAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (box, drafts) = await DraftsFolderAsync(db, tenant, ct);
        if (box is null || drafts is null) return Results.NotFound();

        var message = await db.Messages.FirstOrDefaultAsync(
            m => m.Id == id && m.MailboxId == box.Id && m.FolderId == drafts.Id, ct);
        if (message is null) return Results.NotFound();

        // Hard delete rather than a move to Trash. An abandoned draft is not
        // something anyone expects to find later, and Send removes its own.
        db.Messages.Remove(message);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { deleted = true });
    }

    // ------------------------------------------------------------------
    //  Filter rules.
    //
    //  Conditions and actions are validated through MailFilters before they
    //  are written: the jsonb columns cannot validate themselves, and the
    //  ingest worker has to be able to trust what it reads.
    // ------------------------------------------------------------------
    public sealed record FilterRequest(
        string Name,
        bool Enabled,
        bool MatchAll,
        int Position,
        List<MailFilters.Condition> Conditions,
        MailFilters.Actions Actions);

    private static object ShapeFilter(FilterRule r) => new
    {
        id = r.Id,
        name = r.Name,
        enabled = r.Enabled,
        matchAll = r.MatchAll,
        position = r.Position,
        conditions = MailFilters.ParseConditions(r.Conditions),
        actions = MailFilters.ParseActions(r.Actions),
        createdAt = r.CreatedAt,
    };

    private static async Task<IResult> ListFiltersAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.Ok(new { filters = Array.Empty<object>() });

        var rules = await db.FilterRules.AsNoTracking()
            .Where(r => r.MailboxId == box.Id)
            .OrderBy(r => r.Position).ThenBy(r => r.CreatedAt)
            .ToListAsync(ct);

        return Results.Ok(new { filters = rules.Select(ShapeFilter).ToList() });
    }

    /// <summary>
    /// Shared by create and update. A move target must be a folder in the
    /// caller's OWN mailbox — otherwise a rule could file mail into someone
    /// else's folder by id.
    /// </summary>
    private static async Task<string?> ValidateFilterAsync(
        FilterRequest req, Guid mailboxId, AppDbContext db, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return "Give the rule a name so it can be found later.";

        var (_, error) = MailFilters.ValidateConditions(req.Conditions);
        if (error is not null) return error;

        if (req.Actions is null || req.Actions.IsEmpty)
            return "A rule needs at least one action, or it does nothing.";

        if (req.Actions.MoveToFolderId is Guid folderId)
        {
            var exists = await db.Folders
                .AnyAsync(f => f.Id == folderId && f.MailboxId == mailboxId, ct);
            if (!exists) return "That folder does not exist in your mailbox.";
        }

        return null;
    }

    private static async Task<IResult> CreateFilterAsync(
        FilterRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.BadRequest(new { error = "You have no mailbox." });

        var error = await ValidateFilterAsync(req, box.Id, db, ct);
        if (error is not null) return Results.BadRequest(new { error });

        var (conditions, _) = MailFilters.ValidateConditions(req.Conditions);

        var rule = new FilterRule
        {
            TenantId = box.TenantId,
            MailboxId = box.Id,
            Name = req.Name.Trim(),
            Enabled = req.Enabled,
            MatchAll = req.MatchAll,
            Position = req.Position,
            Conditions = MailFilters.Serialise(conditions!),
            Actions = MailFilters.Serialise(req.Actions),
        };

        db.FilterRules.Add(rule);
        await db.SaveChangesAsync(ct);
        return Results.Ok(ShapeFilter(rule));
    }

    private static async Task<IResult> UpdateFilterAsync(
        Guid id, FilterRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var rule = await db.FilterRules
            .FirstOrDefaultAsync(r => r.Id == id && r.MailboxId == box.Id, ct);
        if (rule is null) return Results.NotFound();

        var error = await ValidateFilterAsync(req, box.Id, db, ct);
        if (error is not null) return Results.BadRequest(new { error });

        var (conditions, _) = MailFilters.ValidateConditions(req.Conditions);

        rule.Name = req.Name.Trim();
        rule.Enabled = req.Enabled;
        rule.MatchAll = req.MatchAll;
        rule.Position = req.Position;
        rule.Conditions = MailFilters.Serialise(conditions!);
        rule.Actions = MailFilters.Serialise(req.Actions);

        await db.SaveChangesAsync(ct);
        return Results.Ok(ShapeFilter(rule));
    }

    private static async Task<IResult> DeleteFilterAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        if (box is null) return Results.NotFound();

        var rule = await db.FilterRules
            .FirstOrDefaultAsync(r => r.Id == id && r.MailboxId == box.Id, ct);
        if (rule is null) return Results.NotFound();

        db.FilterRules.Remove(rule);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { deleted = true });
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
    //  Conversation - every message in one thread, oldest first.
    //
    //  Rows carry the SAME shape as a search hit, folder included. A thread
    //  legitimately spans Inbox and Sent, and now that the Sent copy is
    //  threaded on send, the strip has to be able to say which side of the
    //  exchange each message sits on.
    //
    //  Trash is excluded. Somebody who deleted a message expects it gone from
    //  the views they use, and the conversation strip is one of those. It is
    //  still in Trash and still in search: this hides it, it does not lose it.
    // ------------------------------------------------------------------
    private static async Task<IResult> ThreadAsync(
        Guid threadId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var box = await OwnMailboxAsync(db, tenant, ct);
        // A thread id belonging to somebody else is not an error worth
        // reporting; it is a conversation this mailbox does not have.
        if (box is null)
            return Results.Ok(new { total = 0, messages = Array.Empty<object>() });

        var query = db.Messages.AsNoTracking()
            .Where(m => m.MailboxId == box.Id && m.ThreadId == threadId);

        var trash = await db.Folders.AsNoTracking()
            .Where(f => f.MailboxId == box.Id && f.SpecialUse == "\\Trash")
            .Select(f => f.Id)
            .FirstOrDefaultAsync(ct);
        // Guid.Empty means this mailbox has no Trash folder. The comparison is
        // guarded rather than inlined because "folder_id <> NULL" is NULL in
        // SQL, which would silently return an empty conversation every time.
        if (trash != Guid.Empty)
            query = query.Where(m => m.FolderId != trash);

        var total = await query.CountAsync(ct);

        // Capped, and the cap is VISIBLE: total comes back alongside, so a
        // long conversation can say what it is not showing instead of just
        // appearing to end.
        const int MaxInThread = 200;

        var rows = await query
            .OrderBy(m => m.SentAt ?? m.ReceivedAt)
            .Take(MaxInThread)
            .Select(m => new
            {
                m.Id, m.FolderId, m.ThreadId, m.FromName, m.FromAddr, m.ToAddrs,
                m.CcAddrs, m.Subject, m.Snippet, m.SentAt, m.ReceivedAt,
                m.SizeBytes, m.IsRead, m.IsFlagged, m.HasAttachments,
            })
            .ToListAsync(ct);

        // One query for the folder labels, not one per row - same approach as
        // the search endpoint, which this deliberately mirrors.
        var folderIds = rows.Select(r => r.FolderId).Distinct().ToList();
        var folders = await db.Folders.AsNoTracking()
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
                folderName = folders.TryGetValue(m.FolderId, out var f) ? f.name : null,
                folderSlug = folders.TryGetValue(m.FolderId, out var f2) ? f2.slug : null,
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

        // The signature rides along with bootstrap rather than being fetched
        // when a composer opens: a second round trip at that moment shows an
        // empty editor that then rewrites itself under the cursor.
        var sig = await db.Signatures.AsNoTracking()
            .FirstOrDefaultAsync(s => s.MailboxId == box.Id, ct);

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
            signature = ShapeSignature(sig),
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

        // The draft this was composed from has become a sent message. Leaving
        // it in Drafts is how someone sends the same mail twice, having found
        // what looks like an unsent copy of it later.
        if (Guid.TryParse(form["draftId"], out var draftId))
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
