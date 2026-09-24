using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Modules.Space.Endpoints;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// TatvaOS Docs over HTTP. The live channel is DocsLiveHub; this is
/// everything else an editor needs.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT IS DELIBERATELY NOT HERE
///
///  Sharing, trash, restore, stars and moving between folders. A document is
///  a Space file, and the web client calls Space's own endpoints for those
///  (/api/space/files/{id}/shares, DELETE /api/space/files/{id}, …). A second
///  sharing implementation here would be the second copy of a permission
///  rule, and the copy is always the one that drifts (house rule 10).
///
///  Permission is Space's too: SpaceEndpoints.FilePermAsync, the one ladder
///  view &lt; comment &lt; edit &lt; owner. Same visibility rule as Space: a
///  document the caller cannot see is a 404, never a 403.
///
///  Levels:   view     open, read, see comments, versions, summarise
///            comment  + comment, reply, resolve
///            edit     + change the text, checkpoint, name/restore versions,
///                       pictures, rename, AI that writes into the document
///            owner    everything edit can, plus what Space lets owners do
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class DocsEndpoints
{
    /// <summary>Pictures larger than this are refused. They live in Postgres (see the schema header).</summary>
    private const long MaxImageBytes = 5L * 1024 * 1024;

    /// <summary>A checkpoint's HTML and state. Generous: a hundred-page document with tables is ~2 MB of HTML.</summary>
    private const int MaxHtmlChars = 10 * 1024 * 1024;
    private const int MaxStateBytes = 32 * 1024 * 1024;

    /// <summary>A checkpoint takes an automatic version when the newest one is older than this.</summary>
    private static readonly TimeSpan AutoVersionEvery = TimeSpan.FromMinutes(30);

    /// <summary>Folded updates are kept this long after a checkpoint — the undo for a bad one.</summary>
    private static readonly TimeSpan KeepFoldedUpdates = TimeSpan.FromDays(1);

    public static void MapDocsEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/docs")
            .RequireAuthorization("User")
            .WithTags("Docs");

        g.MapGet("/status", async (AppDbContext db, CancellationToken ct) =>
            Results.Ok(new { enabled = await DocsSwitch.EnabledAsync(db, ct) }));
        g.MapGet("", ListAsync);
        g.MapPost("", CreateAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapPatch("/{id:guid}", RenameAsync);

        g.MapPost("/{id:guid}/live-ticket", TicketAsync);
        g.MapPost("/{id:guid}/checkpoint", CheckpointAsync);

        g.MapGet("/{id:guid}/versions", ListVersionsAsync);
        g.MapPost("/{id:guid}/versions", CreateVersionAsync);
        g.MapGet("/{id:guid}/versions/{vid:guid}", GetVersionAsync);
        g.MapPatch("/{id:guid}/versions/{vid:guid}", NameVersionAsync);

        g.MapGet("/{id:guid}/comments", ListCommentsAsync);
        g.MapPost("/{id:guid}/comments", CreateCommentAsync);
        g.MapPost("/{id:guid}/comments/{cid:guid}/replies", ReplyAsync);
        g.MapPatch("/{id:guid}/comments/{cid:guid}", PatchCommentAsync);
        g.MapDelete("/{id:guid}/comments/{cid:guid}", DeleteCommentAsync);

        g.MapPost("/{id:guid}/images", UploadImageAsync);
        g.MapGet("/{id:guid}/images/{imageId:guid}", GetImageAsync);

        g.MapPost("/{id:guid}/ai", AiAsync);

        // ─── WHY AllowAnonymous HERE IS SAFE — read before copying or "fixing" ───
        // A browser cannot put the access token on a WebSocket upgrade, so the
        // credential is the single-use ticket from /live-ticket (an
        // authenticated route), and:
        //   1. the ticket is REDEEMED BEFORE the upgrade is accepted — a bad,
        //      expired, reused or other-document ticket gets 401 and no socket;
        //   2. the ticket only says WHO asked. What they get is decided again
        //      by the database: the file and the level are re-read through
        //      RLS and SpaceEndpoints.FilePermAsync after redemption;
        //   3. the level is enforced on every update frame, re-read every 45 s,
        //      and the connection dies at 30 minutes.
        // Copying AllowAnonymous onto a route WITHOUT step 1 is an open door.
        //
        // The ticket travels in the query string. No Caddy door that serves
        // /api writes an access log today (only the retired platform host
        // does); if one ever does, redact `ticket` for this path.
        app.MapGet("/api/docs/{id:guid}/live", LiveAsync)
            .AllowAnonymous()
            .WithTags("Docs");
    }

    // ------------------------------------------------------------------
    //  Shapes
    // ------------------------------------------------------------------

    /// <summary>Kind: "document" (default) or "spreadsheet".</summary>
    public sealed record CreateRequest(string? Title, Guid? FolderId, string? Scope, string? Kind = null);
    public sealed record RenameRequest(string? Title);
    /// <summary>Xlsx: a spreadsheet's Space copy, base64. Required for spreadsheets, refused for documents.</summary>
    public sealed record CheckpointRequest(string? State, long UpToSeq, string? Html, string? Text, string? Xlsx = null);
    public sealed record VersionRequest(string? Kind, string? Name, string? State, string? Html);
    public sealed record NameVersionRequest(string? Name);
    public sealed record CommentRequest(string? Body, string? Anchor, string? Quote);
    public sealed record PatchCommentRequest(string? Body, bool? Resolved);
    public sealed record AiRequest(string? Action, string? Text, string? Prompt, string? Style, string? Language);

    public sealed record DocumentDto(
        Guid Id, string Title, string MyPermission, Guid? OwnerUserId, string? OwnerDisplayName,
        string OwnershipType, Guid? FolderId, bool IsStarred, bool IsShared,
        DateTimeOffset? DeletedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        MeDto Me, AiDto Ai,
        // "document" or "spreadsheet": each editor refuses the other's files.
        string Kind = "document");
    public sealed record MeDto(Guid Id, string DisplayName);
    public sealed record AiDto(bool Available, string? Reason);

    public sealed record VersionDto(
        Guid Id, string Kind, string? Name, Guid? CreatedByUserId, string? CreatedByName, DateTimeOffset CreatedAt);

    public sealed record CommentDto(
        Guid Id, Guid? ParentId, Guid? AuthorUserId, string? AuthorName, string Body,
        string? Anchor, string? Quote, DateTimeOffset? ResolvedAt, string? ResolvedByName,
        DateTimeOffset CreatedAt, DateTimeOffset? EditedAt, List<CommentDto> Replies);

    private static IResult Error(int status, string message) =>
        Results.Json(new { error = message }, statusCode: status);

    private static bool AtLeast(string perm, string level) =>
        SpaceEndpoints.Rank(perm) >= SpaceEndpoints.Rank(level);

    /// <summary>
    /// Load the document's Space file and the caller's level. Not a
    /// document, or not visible: 404. Trashed: 409 unless the caller only
    /// wants to look (Space lets a trashed file be opened; Docs lets it be
    /// read, not changed).
    /// </summary>
    internal static async Task<(IResult? Error, SpaceFile File, string Perm, Guid Uid)> LoadAsync(
        AppDbContext db, TenantContext tenant, Guid id, bool tracked, bool forChange, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return (Results.Unauthorized(), null!, "", default);

        // Documents and spreadsheets alike: everything below — live channel,
        // versions, comments — is the same for both (DocsFormat.IsLive).
        var q = db.SpaceFiles.Where(f => f.Id == id
            && (f.MimeType == DocsFormat.MimeType || f.MimeType == DocsFormat.SpreadsheetMimeType));
        var file = await (tracked ? q : q.AsNoTracking()).FirstOrDefaultAsync(ct);
        if (file is null) return (Error(404, "No such document."), null!, "", uid);
        // Each kind answers to its own switch (LiveSwitch): Docs off leaves
        // spreadsheets open, Sheets off leaves documents open. Checked after
        // the lookup because only the file says which switch applies; the
        // lookup runs under the caller's RLS, so it reveals nothing they
        // could not already see in Space.
        if (!await LiveSwitch.EnabledAsync(db, file.MimeType, ct))
            return (LiveSwitch.Off(file.MimeType), null!, "", uid);
        if (forChange && file.DeletedAt is not null)
            return (Error(409, "This document is in the trash. Restore it first."), null!, "", uid);

        return (null, file, await SpaceEndpoints.FilePermAsync(db, file, uid, ct), uid);
    }

    // ==================================================================
    //  GET /api/docs — the home page's lists
    // ==================================================================
    //
    //  view = recent | owned | shared | starred | trash. Returned as Space's
    //  own file shape, decorated by Space's own batch decorator, so the web
    //  client renders it with the types it already has. Level is the same
    //  LOW approximation Space's cross-folder views make (owner / org-edit /
    //  direct grants, no ancestor walk per row); opening the document
    //  computes the exact level.

    private static async Task<IResult> ListAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        string? view = "recent", string? q = null, int page = 1, int pageSize = 50, string? kind = null)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        // Docs' home lists documents, Sheets' lists spreadsheets; absent kind
        // is "document" so the Docs client is unchanged. Each behind its own switch.
        var mime = kind == "spreadsheet" ? DocsFormat.SpreadsheetMimeType : DocsFormat.MimeType;
        if (!await LiveSwitch.EnabledAsync(db, mime, ct)) return LiveSwitch.Off(mime);
        if (page < 1) page = 1;
        pageSize = Math.Clamp(pageSize, 1, 200);

        var files = db.SpaceFiles.AsNoTracking().Where(f => f.MimeType == mime);
        files = view switch
        {
            "trash" => files.Where(f => f.DeletedAt != null
                                        && (f.OwnerUserId == uid || f.DeletedByUserId == uid)),
            "owned" => files.Where(f => f.DeletedAt == null && f.OwnerUserId == uid),
            "shared" => files.Where(f => f.DeletedAt == null && f.OwnerUserId != uid),
            "starred" => files.Where(f => f.DeletedAt == null
                                          && db.SpaceStars.Any(s => s.FileId == f.Id)),
            _ => files.Where(f => f.DeletedAt == null),
        };
        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = q.Trim();
            files = files.Where(f => EF.Functions.ILike(f.Name, "%" + term.Replace("%", "\\%").Replace("_", "\\_") + "%"));
        }

        var total = await files.CountAsync(ct);
        var rows = await files
            .OrderByDescending(f => view == "trash" ? f.DeletedAt : f.UpdatedAt)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .ToListAsync(ct);

        var ids = rows.Select(r => r.Id).ToList();
        var shareRows = ids.Count == 0
            ? []
            : await db.SpaceShares.AsNoTracking()
                .Where(s => s.FileId != null && ids.Contains(s.FileId.Value))
                .ToListAsync(ct);
        var sharedSet = shareRows.Select(s => s.FileId!.Value).ToHashSet();
        var grants = shareRows.Where(s => s.OrgWide || s.SharedWithUserId == uid)
            .ToLookup(s => s.FileId!.Value, s => s.Permission);

        string PermOf(SpaceFile f)
        {
            if (f.OwnerUserId == uid) return "owner";
            var p = f.OwnershipType == "organisational" ? "edit" : "view";
            foreach (var gr in grants[f.Id])
                if (SpaceEndpoints.Rank(gr) > SpaceEndpoints.Rank(p)) p = gr;
            return p;
        }

        var dtos = rows.Select(f => new SpaceEndpoints.SpaceFileDto(
            f.Id, f.Name, f.MimeType, f.SizeBytes, f.FolderId, f.OwnershipType, f.OwnerUserId,
            f.CreatedByUserId, PermOf(f), sharedSet.Contains(f.Id), f.DeletedAt, f.CreatedAt, f.UpdatedAt)).ToList();
        var deco = await SpaceDriveEndpoints.DecorateAsync(db, uid, [], dtos, withParentName: true, ct);

        return Results.Ok(new { documents = deco.Files, page, pageSize, total });
    }

    // ==================================================================
    //  POST /api/docs — a new, blank document
    // ==================================================================

    private static async Task<IResult> CreateAsync(
        CreateRequest req, AppDbContext db, TenantContext tenant, StorageAllocator allocator,
        IBlobStore blobs, IConfiguration config, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        if (req.Kind is not (null or "document" or "spreadsheet"))
            return Error(400, "kind must be document or spreadsheet.");
        var sheet = req.Kind == "spreadsheet";
        var kindMime = sheet ? DocsFormat.SpreadsheetMimeType : DocsFormat.MimeType;
        if (!await LiveSwitch.EnabledAsync(db, kindMime, ct)) return LiveSwitch.Off(kindMime);
        var title = CleanTitle(req.Title) ?? (sheet ? DocsFormat.DefaultSpreadsheetTitle : DocsFormat.DefaultTitle);

        // Where it lands and who owns it: Space's rule, not a copy of it.
        var (err, folderId, ownership, owner) =
            await SpaceEndpoints.ResolveDestinationAsync(db, uid, req.FolderId, req.Scope ?? "personal", ct);
        if (err is not null) return err;

        // A new spreadsheet's Space copy is empty until its first checkpoint
        // writes the .xlsx; zero bytes is honest ("nothing yet") where a
        // made-up placeholder file would not be.
        var html = sheet ? Array.Empty<byte>() : DocsFormat.RenderHtml(title, "");
        var verdict = await SpaceEndpoints.EvaluateStorageAsync(db, allocator, tenant.TenantId,
            ownership, owner, uid, html.Length, html.Length, SpaceEndpoints.MaxFileBytes(config), ct);
        if (!verdict.Ok)
            return Results.Json(new { error = verdict.Message, reason = verdict.Reason }, statusCode: 413);

        var key = blobs.NewKey(tenant.TenantId);
        await using (var ms = new MemoryStream(html))
            await blobs.WriteAsync(key, ms, html.Length, ct);

        var file = new SpaceFile
        {
            TenantId = tenant.TenantId,
            FolderId = folderId,
            CreatedByUserId = uid,
            OwnershipType = ownership,
            OwnerUserId = owner,
            Name = title,
            MimeType = sheet ? DocsFormat.SpreadsheetMimeType : DocsFormat.MimeType,
            BlobKey = key,
            SizeBytes = html.Length,
        };
        db.SpaceFiles.Add(file);
        db.DocsDocuments.Add(new DocsDocument { FileId = file.Id, TenantId = tenant.TenantId });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            try { await blobs.DeleteAsync(key); } catch { /* orphan costs bytes only */ }
            throw;
        }

        await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, file.Id, "created", ct);
        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);

        return Results.Created($"/api/docs/{file.Id}", new { id = file.Id, title = file.Name });
    }

    private static string? CleanTitle(string? t)
    {
        if (string.IsNullOrWhiteSpace(t)) return null;
        t = t.Trim().Replace('\n', ' ').Replace('\r', ' ');
        // Space's own limit on a name; a slash would read as a path in a download.
        t = t.Replace('/', '-').Replace('\\', '-');
        return t.Length > 300 ? t[..300] : t;
    }

    // ==================================================================
    //  GET /api/docs/{id} — what the editor needs before it connects
    // ==================================================================

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, TenantContext tenant, IAiGateway ai, CancellationToken ct)
    {
        var (err, file, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var names = await db.Users.AsNoTracking()
            .Where(u => u.Id == uid || u.Id == file.OwnerUserId)
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var starred = await db.SpaceStars.AnyAsync(s => s.FileId == id, ct);
        var shared = await db.SpaceShares.AnyAsync(s => s.FileId == id, ct);

        await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, id, "opened", ct);

        AiDto aiState = !ai.IsConfigured
            ? new(false, "AI is not set up on this TatvaOS installation.")
            : !await ai.EnabledForTenantAsync(ct)
                ? new(false, "AI is switched off for your organisation. An administrator can turn it on.")
                : new(true, null);

        return Results.Ok(new DocumentDto(
            file.Id, file.Name, perm, file.OwnerUserId,
            file.OwnerUserId is Guid o ? names.GetValueOrDefault(o) : null,
            file.OwnershipType, file.FolderId, starred, shared,
            file.DeletedAt, file.CreatedAt, file.UpdatedAt,
            new MeDto(uid, names.GetValueOrDefault(uid) ?? ""),
            aiState));
    }

    // ==================================================================
    //  PATCH /api/docs/{id} — rename
    // ==================================================================

    private static async Task<IResult> RenameAsync(
        Guid id, RenameRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub, CancellationToken ct)
    {
        var (err, file, perm, _) = await LoadAsync(db, tenant, id, tracked: true, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "edit")) return Error(403, "You need edit access to rename this document.");

        var title = CleanTitle(req.Title);
        if (title is null) return Error(400, "A document needs a name.");

        file.Name = title;
        file.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "meta", title });
        return Results.Ok(new { id, title });
    }

    // ==================================================================
    //  Live channel
    // ==================================================================

    private static async Task<IResult> TicketAsync(
        Guid id, AppDbContext db, TenantContext tenant, DocsLiveHub hub, CancellationToken ct)
    {
        var (err, file, _, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;
        if (file.DeletedAt is not null)
            return Error(409, "This document is in the trash. Restore it to edit it.");

        return Results.Ok(new { ticket = hub.IssueTicket(tenant.TenantId, uid, tenant.Role ?? "employee", id) });
    }

    private static async Task LiveAsync(
        Guid id, HttpContext http, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        DocsInstanceGuard guard, CancellationToken ct)
    {
        if (!http.WebSockets.IsWebSocketRequest)
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        // Not the single live-editing instance: refuse before anything else,
        // so no browser ever joins a room another process may also hold. The
        // browser retries with backoff and finds the instance that does.
        if (!guard.IsSoleInstance)
        {
            http.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        var ticket = hub.Redeem(http.Request.Query["ticket"], id);
        if (ticket is null)
        {
            // Before the upgrade, so the browser sees a failed handshake and
            // asks for a new ticket rather than holding a dead socket.
            http.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await hub.RunAsync(http, id, ticket, db, tenant, ct);
    }

    // ==================================================================
    //  POST /api/docs/{id}/checkpoint
    // ==================================================================
    //
    //  A browser with edit access says: here is the whole document, it
    //  contains every update up to UpToSeq, here is its HTML and text. We:
    //
    //    1. replace the compacted state (if this is newer than what we have)
    //    2. rewrite the Space blob with the HTML — new key, repoint, delete old
    //    3. take an automatic version if the last one is old enough
    //    4. drop updates folded into the state more than a day ago
    //
    //  Under the room lock, so a browser joining at this moment reads either
    //  the old state with its updates or the new one with its remainder —
    //  never a mixture.

    private static async Task<IResult> CheckpointAsync(
        Guid id, CheckpointRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        IBlobStore blobs, StorageAllocator allocator, ILoggerFactory loggers, CancellationToken ct)
    {
        var (err, file, perm, uid) = await LoadAsync(db, tenant, id, tracked: true, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "edit")) return Error(403, "You need edit access to save this document.");

        if (!TryDecode(req.State, MaxStateBytes, out var state))
            return Error(400, "state must be base64, and within the size limit.");
        if ((req.Html ?? "").Length > MaxHtmlChars) return Error(413, "This document is too large to save.");
        var html = CleanHtml(req.Html, id, uid, "checkpoint", loggers);
        var text = req.Text ?? "";
        if (text.Length > 2_000_000) text = text[..2_000_000];

        // A spreadsheet's Space copy is the .xlsx its editor wrote; a
        // document's is the HTML page. Each refuses the other's, so a
        // hand-made request cannot give a spreadsheet an HTML blob that Space
        // would then hand out named ".xlsx".
        var isSheet = file.MimeType == DocsFormat.SpreadsheetMimeType;
        byte[]? xlsx = null;
        if (isSheet)
        {
            if (!TryDecode(req.Xlsx, MaxStateBytes, out var x) || x.Length == 0)
                return Error(400, "A spreadsheet checkpoint needs its .xlsx copy (base64, within the size limit).");
            // PK\x03\x04: the start of every zip file, which is what an .xlsx is.
            if (x.Length < 4 || x[0] != 0x50 || x[1] != 0x4B || x[2] != 0x03 || x[3] != 0x04)
                return Error(400, "The .xlsx copy is not a zip file.");
            xlsx = x;
        }
        else if (req.Xlsx is not null)
        {
            return Error(400, "Only a spreadsheet has an .xlsx copy.");
        }

        string? oldKey = null;
        using (await hub.LockAsync(id, ct))
        {
            var doc = await db.DocsDocuments.FirstOrDefaultAsync(d => d.FileId == id, ct);
            if (doc is null) return Error(404, "No such document.");

            // A claim about the future is refused: a browser cannot have seen
            // an update the server has not yet numbered.
            var maxSeq = await db.DocsUpdates.Where(u => u.FileId == id)
                .MaxAsync(u => (long?)u.Seq, ct) ?? doc.StateSeq;
            if (req.UpToSeq > maxSeq)
                return Error(409, "That checkpoint names updates this document does not have.");

            // A browser BEHIND the last checkpoint changes nothing: its state,
            // HTML and text all predate what is already stored, and taking
            // its HTML would roll Space's copy backwards until someone else
            // saved. Not an error — it simply has nothing newer to offer.
            if (req.UpToSeq < doc.StateSeq)
                return Results.Ok(new { saved = false, stale = true });

            var now = DateTimeOffset.UtcNow;
            doc.State = state;
            doc.StateSeq = req.UpToSeq;
            doc.TextContent = text;
            doc.CheckpointAt = now;
            doc.CheckpointByUserId = uid;
            doc.UpdatedAt = now;

            var blobBytes = xlsx ?? DocsFormat.RenderHtml(file.Name, html);
            var key = blobs.NewKey(tenant.TenantId);
            await using (var ms = new MemoryStream(blobBytes))
                await blobs.WriteAsync(key, ms, blobBytes.Length, ct);
            oldKey = file.BlobKey;
            file.BlobKey = key;
            var imageBytes = await db.DocsImages.Where(i => i.FileId == id).SumAsync(i => (long?)i.SizeBytes, ct) ?? 0;
            file.SizeBytes = blobBytes.Length + imageBytes;
            file.UpdatedAt = now;

            var latest = await db.DocsVersions.AsNoTracking()
                .Where(v => v.FileId == id)
                .OrderByDescending(v => v.CreatedAt)
                .Select(v => new { v.CreatedAt, v.Html })
                .FirstOrDefaultAsync(ct);
            if ((latest is null || now - latest.CreatedAt >= AutoVersionEvery) && latest?.Html != html)
            {
                db.DocsVersions.Add(new DocsVersion
                {
                    FileId = id, TenantId = tenant.TenantId, Kind = "auto",
                    State = doc.State, Html = html, CreatedByUserId = uid, CreatedAt = now,
                });
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch
            {
                try { await blobs.DeleteAsync(key); } catch { /* orphan costs bytes only */ }
                throw;
            }

            var cutoff = now - KeepFoldedUpdates;
            var folded = doc.StateSeq;
            await db.DocsUpdates
                .Where(u => u.FileId == id && u.Seq <= folded && u.CreatedAt < cutoff)
                .ExecuteDeleteAsync(ct);
        }

        if (oldKey is not null)
        {
            try { await blobs.DeleteAsync(oldKey); }
            catch { /* an orphaned blob costs bytes, not correctness */ }
        }
        await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, id, "modified", ct);
        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);

        hub.Broadcast(id, new { type = "saved", at = DateTimeOffset.UtcNow });
        return Results.Ok(new { saved = true });
    }

    /// <summary>
    /// The browser's HTML, made safe to store (see <see cref="DocsHtml"/>).
    /// When anything had to be removed it is logged as a WARNING: an honest
    /// editor sends nothing this removes, so the line means either a
    /// hand-built request or an editor whose schema has outgrown the list.
    /// Names only — never the document's content.
    /// </summary>
    private static string CleanHtml(string? html, Guid fileId, Guid userId, string from, ILoggerFactory loggers)
    {
        var cleaned = DocsHtml.Clean(html);
        if (cleaned.Dropped.Count > 0)
        {
            loggers.CreateLogger("TatvaOS.Docs.Html").LogWarning(
                "Docs {From} for file {FileId} by user {UserId}: removed from the HTML before storing: {Dropped}",
                from, fileId, userId, string.Join(", ", cleaned.Dropped.Take(40)));
        }
        return cleaned.Html;
    }

    private static bool TryDecode(string? b64, int max, out byte[] bytes)
    {
        bytes = [];
        if (b64 is null) return false;
        if (b64.Length > max / 3 * 4 + 4) return false;
        try { bytes = Convert.FromBase64String(b64); return true; }
        catch (FormatException) { return false; }
    }

    // ==================================================================
    //  Versions
    // ==================================================================

    private static async Task<IResult> ListVersionsAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (err, _, _, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var rows = await db.DocsVersions.AsNoTracking()
            .Where(v => v.FileId == id)
            .OrderByDescending(v => v.CreatedAt)
            .Select(v => new { v.Id, v.Kind, v.Name, v.CreatedByUserId, v.CreatedAt })
            .Take(500)
            .ToListAsync(ct);
        var names = await NamesAsync(db, rows.Select(r => r.CreatedByUserId), ct);

        return Results.Ok(new
        {
            versions = rows.Select(r => new VersionDto(r.Id, r.Kind, r.Name, r.CreatedByUserId,
                r.CreatedByUserId is Guid u ? names.GetValueOrDefault(u) : null, r.CreatedAt)),
        });
    }

    private static async Task<IResult> GetVersionAsync(
        Guid id, Guid vid, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (err, _, _, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var v = await db.DocsVersions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == vid && x.FileId == id, ct);
        if (v is null) return Error(404, "No such version.");

        return Results.Ok(new
        {
            id = v.Id, kind = v.Kind, name = v.Name, createdAt = v.CreatedAt,
            // Cleaned again on the way out: a row written before the
            // sanitiser existed, or by anything that ever bypasses it, still
            // leaves as allowlisted markup. Cleaning clean HTML changes nothing.
            html = DocsHtml.Clean(v.Html).Html, state = Convert.ToBase64String(v.State),
        });
    }

    /// <summary>
    /// A version the browser took: 'named' (File &gt; Name current version) or
    /// 'restore' (the state just before a restore, so the restore can itself
    /// be undone). Automatic versions come only from checkpoints.
    /// </summary>
    private static async Task<IResult> CreateVersionAsync(
        Guid id, VersionRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        ILoggerFactory loggers, CancellationToken ct)
    {
        var (err, _, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "edit")) return Error(403, "You need edit access to save a version.");

        if (req.Kind is not ("named" or "restore")) return Error(400, "kind must be named or restore.");
        if (!TryDecode(req.State, MaxStateBytes, out var state) || state.Length == 0)
            return Error(400, "state must be base64, and within the size limit.");
        var name = string.IsNullOrWhiteSpace(req.Name) ? null : req.Name.Trim();
        if (name is { Length: > 200 }) name = name[..200];
        if (req.Kind == "named" && name is null) return Error(400, "A named version needs a name.");
        if ((req.Html ?? "").Length > MaxHtmlChars) return Error(413, "This document is too large to save.");

        var v = new DocsVersion
        {
            FileId = id, TenantId = tenant.TenantId, Kind = req.Kind, Name = name,
            State = state, Html = CleanHtml(req.Html, id, uid, "version", loggers), CreatedByUserId = uid,
        };
        db.DocsVersions.Add(v);
        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "versions" });
        return Results.Created($"/api/docs/{id}/versions/{v.Id}", new { id = v.Id });
    }

    private static async Task<IResult> NameVersionAsync(
        Guid id, Guid vid, NameVersionRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        CancellationToken ct)
    {
        var (err, _, perm, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "edit")) return Error(403, "You need edit access to name a version.");

        var v = await db.DocsVersions.FirstOrDefaultAsync(x => x.Id == vid && x.FileId == id, ct);
        if (v is null) return Error(404, "No such version.");

        var name = string.IsNullOrWhiteSpace(req.Name) ? null : req.Name.Trim();
        if (name is { Length: > 200 }) name = name[..200];
        v.Name = name;
        // Naming an automatic version keeps it: 'named' is what the list
        // filter "named versions only" selects on.
        if (name is not null && v.Kind == "auto") v.Kind = "named";
        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "versions" });
        return Results.Ok(new { id = v.Id, name = v.Name, kind = v.Kind });
    }

    // ==================================================================
    //  Comments
    // ==================================================================

    private static async Task<Dictionary<Guid, string>> NamesAsync(
        AppDbContext db, IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var list = ids.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        return list.Count == 0
            ? []
            : await db.Users.AsNoTracking().Where(u => list.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    private static async Task<IResult> ListCommentsAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (err, _, _, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var rows = await db.DocsComments.AsNoTracking()
            .Where(c => c.FileId == id)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync(ct);
        var names = await NamesAsync(db,
            rows.Select(r => r.AuthorUserId).Concat(rows.Select(r => r.ResolvedByUserId)), ct);

        CommentDto Dto(DocsComment c, List<CommentDto> replies) => new(
            c.Id, c.ParentId, c.AuthorUserId,
            c.AuthorUserId is Guid a ? names.GetValueOrDefault(a) : null,
            c.Body, c.Anchor, c.Quote, c.ResolvedAt,
            c.ResolvedByUserId is Guid r ? names.GetValueOrDefault(r) : null,
            c.CreatedAt, c.EditedAt, replies);

        var replies = rows.Where(r => r.ParentId != null).ToLookup(r => r.ParentId!.Value);
        var threads = rows.Where(r => r.ParentId == null)
            .Select(root => Dto(root, replies[root.Id].Select(x => Dto(x, [])).ToList()))
            .ToList();
        return Results.Ok(new { threads });
    }

    private static async Task<IResult> CreateCommentAsync(
        Guid id, CommentRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub, CancellationToken ct)
    {
        var (err, _, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "comment")) return Error(403, "You need comment access to comment here.");

        var body = req.Body?.Trim();
        if (string.IsNullOrEmpty(body)) return Error(400, "A comment cannot be empty.");
        if (body.Length > 10_000) return Error(400, "Comments are limited to 10,000 characters.");
        if (req.Anchor is { Length: > 4000 }) return Error(400, "anchor is too large.");
        if (req.Anchor is not null && !IsJson(req.Anchor)) return Error(400, "anchor must be JSON.");
        var quote = req.Quote is { Length: > 2000 } ? req.Quote[..2000] : req.Quote;

        var c = new DocsComment
        {
            FileId = id, TenantId = tenant.TenantId, AuthorUserId = uid,
            Body = body, Anchor = req.Anchor, Quote = quote,
        };
        db.DocsComments.Add(c);
        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "comments" });
        return Results.Created($"/api/docs/{id}/comments/{c.Id}", new { id = c.Id });
    }

    private static bool IsJson(string s)
    {
        try { using var _ = System.Text.Json.JsonDocument.Parse(s); return true; }
        catch (System.Text.Json.JsonException) { return false; }
    }

    private static async Task<IResult> ReplyAsync(
        Guid id, Guid cid, CommentRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        CancellationToken ct)
    {
        var (err, _, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "comment")) return Error(403, "You need comment access to reply here.");

        var root = await db.DocsComments.FirstOrDefaultAsync(c => c.Id == cid && c.FileId == id, ct);
        if (root is null) return Error(404, "No such comment.");
        // Replies hang off the root, never off a reply: one level, as in Docs.
        var rootId = root.ParentId ?? root.Id;

        var body = req.Body?.Trim();
        if (string.IsNullOrEmpty(body)) return Error(400, "A reply cannot be empty.");
        if (body.Length > 10_000) return Error(400, "Replies are limited to 10,000 characters.");

        var c = new DocsComment
        {
            FileId = id, TenantId = tenant.TenantId, ParentId = rootId, AuthorUserId = uid, Body = body,
        };
        db.DocsComments.Add(c);

        // Replying to a resolved thread reopens it — the reply is a question
        // nobody would otherwise see.
        var thread = root.ParentId is null ? root : await db.DocsComments.FirstAsync(x => x.Id == rootId, ct);
        thread.ResolvedAt = null;
        thread.ResolvedByUserId = null;

        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "comments" });
        return Results.Created($"/api/docs/{id}/comments/{c.Id}", new { id = c.Id });
    }

    private static async Task<IResult> PatchCommentAsync(
        Guid id, Guid cid, PatchCommentRequest req, AppDbContext db, TenantContext tenant, DocsLiveHub hub,
        CancellationToken ct)
    {
        var (err, _, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "comment")) return Error(403, "You need comment access here.");

        var c = await db.DocsComments.FirstOrDefaultAsync(x => x.Id == cid && x.FileId == id, ct);
        if (c is null) return Error(404, "No such comment.");

        if (req.Body is not null)
        {
            // Words are the author's alone. Anyone who can comment may
            // resolve, but nobody puts words in someone else's mouth.
            if (c.AuthorUserId != uid) return Error(403, "Only the author can edit a comment.");
            var body = req.Body.Trim();
            if (body.Length is 0 or > 10_000) return Error(400, "A comment must be 1 to 10,000 characters.");
            c.Body = body;
            c.EditedAt = DateTimeOffset.UtcNow;
        }

        if (req.Resolved is bool resolved)
        {
            if (c.ParentId is not null) return Error(400, "Resolve the thread, not a reply.");
            c.ResolvedAt = resolved ? DateTimeOffset.UtcNow : null;
            c.ResolvedByUserId = resolved ? uid : null;
        }

        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "comments" });
        return Results.Ok(new { id = c.Id });
    }

    private static async Task<IResult> DeleteCommentAsync(
        Guid id, Guid cid, AppDbContext db, TenantContext tenant, DocsLiveHub hub, CancellationToken ct)
    {
        var (err, _, perm, uid) = await LoadAsync(db, tenant, id, tracked: false, forChange: true, ct);
        if (err is not null) return err;

        var c = await db.DocsComments.FirstOrDefaultAsync(x => x.Id == cid && x.FileId == id, ct);
        if (c is null) return Error(404, "No such comment.");

        // The author, or anyone who can edit the document (as in Docs: an
        // editor can clear a thread off their own document).
        if (c.AuthorUserId != uid && !AtLeast(perm, "edit"))
            return Error(403, "Only the author or an editor can delete a comment.");

        db.DocsComments.Remove(c); // replies cascade in the database
        await db.SaveChangesAsync(ct);
        hub.Broadcast(id, new { type = "comments" });
        return Results.NoContent();
    }

    // ==================================================================
    //  Pictures
    // ==================================================================

    private static readonly Dictionary<string, byte[][]> Signatures = new()
    {
        ["image/png"] = [[0x89, 0x50, 0x4E, 0x47]],
        ["image/jpeg"] = [[0xFF, 0xD8, 0xFF]],
        ["image/gif"] = [[0x47, 0x49, 0x46, 0x38]],
        ["image/webp"] = [[0x52, 0x49, 0x46, 0x46]],
    };

    private static async Task<IResult> UploadImageAsync(
        Guid id, HttpRequest request, AppDbContext db, TenantContext tenant, StorageAllocator allocator,
        IConfiguration config, CancellationToken ct)
    {
        var (err, file, perm, uid) = await LoadAsync(db, tenant, id, tracked: true, forChange: true, ct);
        if (err is not null) return err;
        if (!AtLeast(perm, "edit")) return Error(403, "You need edit access to add a picture.");

        if (!request.HasFormContentType) return Error(400, "Send the picture as multipart/form-data.");
        var form = await request.ReadFormAsync(ct);
        var part = form.Files.GetFile("file");
        if (part is null) return Error(400, "The request contained no picture.");
        if (part.Length > MaxImageBytes)
            return Error(413, $"Pictures are limited to {MaxImageBytes / (1024 * 1024)} MB each.");

        await using var ms = new MemoryStream();
        await part.CopyToAsync(ms, ct);
        var data = ms.ToArray();

        // Decide the type from the bytes, not the browser's claim — the claim
        // is what an attacker controls, and SVG must never get through.
        var mime = Signatures.FirstOrDefault(kv => kv.Value.Any(sig => data.AsSpan().StartsWith(sig))).Key;
        if (mime is null) return Error(415, "Pictures must be PNG, JPEG, GIF or WebP.");

        var verdict = await SpaceEndpoints.EvaluateStorageAsync(db, allocator, tenant.TenantId,
            file.OwnershipType, file.OwnerUserId, uid, data.Length, data.Length,
            SpaceEndpoints.MaxFileBytes(config), ct);
        if (!verdict.Ok)
            return Results.Json(new { error = verdict.Message, reason = verdict.Reason }, statusCode: 413);

        var img = new DocsImage
        {
            FileId = id, TenantId = tenant.TenantId, MimeType = mime,
            Data = data, SizeBytes = data.Length, CreatedByUserId = uid,
        };
        db.DocsImages.Add(img);
        file.SizeBytes += data.Length;
        await db.SaveChangesAsync(ct);
        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);

        return Results.Created($"/api/docs/{id}/images/{img.Id}",
            new { id = img.Id, src = $"/api/docs/{id}/images/{img.Id}" });
    }

    private static async Task<IResult> GetImageAsync(
        Guid id, Guid imageId, HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var (err, _, _, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var img = await db.DocsImages.AsNoTracking()
            .Where(i => i.Id == imageId && i.FileId == id)
            .Select(i => new { i.MimeType, i.Data })
            .FirstOrDefaultAsync(ct);
        if (img is null) return Error(404, "No such picture.");

        http.Response.Headers.XContentTypeOptions = "nosniff";
        // Private: the bytes are behind a person's access, so no shared cache
        // may keep them. Immutable: an id never changes content.
        http.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
        return Results.File(img.Data, img.MimeType);
    }

    // ==================================================================
    //  POST /api/docs/{id}/ai
    // ==================================================================
    //
    //  The text comes from the browser — the selection, or the document for
    //  a summary — because the browser holds the live document and the
    //  server's copy is only as fresh as the last checkpoint. It is passed as
    //  the gateway's INPUT (data), never folded into the instruction: a
    //  document that says "ignore the above" is a person's words, not orders.
    //  The one exception is the person's own request in "generate", which IS
    //  an instruction, from the person entitled to give it.

    private static async Task<IResult> AiAsync(
        Guid id, AiRequest req, AppDbContext db, TenantContext tenant, IAiGateway ai, CancellationToken ct)
    {
        var (err, _, perm, _) = await LoadAsync(db, tenant, id, tracked: false, forChange: false, ct);
        if (err is not null) return err;

        var action = req.Action ?? "";
        // Summarising only reads. Everything else produces text meant to go
        // INTO the document, which needs edit access to put there.
        if (action != "summarize" && !AtLeast(perm, "edit"))
            return Error(403, "You need edit access to change this document.");

        if (!ai.IsConfigured) return Error(503, "AI is not set up on this TatvaOS installation.");
        if (!await ai.EnabledForTenantAsync(ct))
            return Error(403, "AI is switched off for your organisation. An administrator can turn it on.");

        const string Plain =
            " Reply with the text only — no preamble, no closing remarks, no quotation marks around it." +
            " Use plain text: blank lines between paragraphs, '- ' for bullet points, '1. ' for numbered" +
            " points and '# ' or '## ' for headings. Do not use any other formatting.";

        var text = req.Text ?? "";
        string instruction;
        switch (action)
        {
            case "summarize":
                if (string.IsNullOrWhiteSpace(text)) return Error(400, "There is nothing to summarise yet.");
                instruction = "Summarise the document you are given in a short paragraph followed by its key" +
                              " points as a bulleted list. Write in the document's own language." + Plain;
                break;
            case "rewrite":
                if (string.IsNullOrWhiteSpace(text)) return Error(400, "Select some text to rewrite.");
                instruction = (req.Style switch
                {
                    "shorten" => "Make the text you are given shorter while keeping its meaning.",
                    "expand" => "Expand the text you are given with more detail, keeping its meaning and tone.",
                    "formal" => "Rewrite the text you are given in a formal, professional tone.",
                    "simple" => "Rewrite the text you are given in simple, clear language a school student could follow.",
                    _ => "Improve the writing of the text you are given: clearer, correct grammar and spelling, same meaning.",
                }) + " Keep it in the same language." + Plain;
                break;
            case "translate":
                if (string.IsNullOrWhiteSpace(text)) return Error(400, "Select some text to translate.");
                var lang = (req.Language ?? "").Trim();
                if (lang.Length is 0 or > 40 || !lang.All(ch => char.IsLetter(ch) || ch is ' ' or '-' or '('  or ')'))
                    return Error(400, "Choose a language to translate into.");
                instruction = $"Translate the text you are given into {lang}. Keep its structure." + Plain;
                break;
            case "generate":
                var prompt = (req.Prompt ?? "").Trim();
                if (prompt.Length == 0) return Error(400, "Say what you would like written.");
                if (prompt.Length > 2000) prompt = prompt[..2000];
                instruction = "You write content for a document in TatvaOS Docs, used by schools and" +
                              " organisations in India. Write what the person asks for below. The input you" +
                              " are given, if any, is the surrounding document for context only." +
                              "\n\nThe person asks: " + prompt + "\n\n" + Plain;
                break;
            default:
                return Error(400, "action must be summarize, rewrite, translate or generate.");
        }

        // Named, so the metering (PR 280) counts it under "Docs" — the gateway
        // refuses a request with no feature. It costs the default, 1 credit:
        // AiCredits has no line for "docs", and what it should cost is a
        // pricing decision (Amit's), not one to make in a merge.
        var result = await ai.CompleteAsync(instruction, text, ct, feature: "docs");
        if (result.Error is not null) return Error(502, result.Error);
        return Results.Ok(new { text = result.Text.Trim(), truncated = result.Truncated });
    }
}
