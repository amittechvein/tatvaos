using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Space.Endpoints;

/// <summary>
/// Public download links. Contract: SPACE_API_PUBLIC_LINKS_ADDENDUM.md
/// (v1.3, approved). Two very different halves live here on purpose, so the
/// dangerous one is reviewable in a single place:
///
/// MANAGEMENT (authenticated, RLS as usual): create / list / revoke, plus
/// the org's Space settings. A token is minted from 128 CSPRNG bits and
/// stored ONLY as a SHA-256 hash — the plaintext exists once, in the create
/// response, and never again anywhere.
///
/// RESOLVE (anonymous — THE ONE ENDPOINT ON THE PLATFORM THE INTERNET CAN
/// REACH): no session, no RLS. Every database access goes through the two
/// SECURITY DEFINER functions from 20260816-space-public-links.sql and
/// nothing else. ONE failure answer — 404, one string — for unknown,
/// expired, revoked, over-limit, trashed, suspended tenant and org-flag-off
/// alike; the flag-off case deliberately does NOT use the management
/// endpoints' "turned off for your organisation" sentence, which on this
/// path would be an oracle. Per-IP rate limited. Every byte response is
/// Content-Disposition: attachment + X-Content-Type-Options: nosniff —
/// this origin holds sessions, and inline rendering of a stranger's HTML
/// would be XSS against every Space user.
/// </summary>
public static partial class SpaceLinkEndpoints
{
    public static void MapSpaceLinkEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/space")
            .RequireAuthorization("User")
            .WithTags("Space");

        g.MapPost("/files/{id:guid}/link", CreateLinkAsync);
        g.MapGet("/files/{id:guid}/links", ListLinksAsync);
        g.MapDelete("/files/{id:guid}/links/{linkId:guid}", RevokeLinkAsync);

        // Org policy — the admin console's toggle reads and writes this.
        var s = app.MapGroup("/api/space/settings")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Space");
        s.MapGet("/", GetSettingsAsync);
        s.MapPut("/", PutSettingsAsync);

        // The anonymous pair. Rate limited per IP; policy in Program.cs.
        var l = app.MapGroup("/api/space/l")
            .WithTags("Space")
            .RequireRateLimiting("space-public-links");
        l.MapGet("/{token}", DownloadAsync).AllowAnonymous();
        l.MapGet("/{token}/meta", MetaAsync).AllowAnonymous();
    }

    private const int DefaultExpiryDays = 30;
    private const int MaxExpiryDays = 365;

    // The one and only failure string on the anonymous path. Everything —
    // including the org kill-switch — answers with exactly this.
    private static IResult LinkNotFound() =>
        Results.Json(new { error = "This link does not exist or has expired." }, statusCode: 404);

    private static IResult Error(int status, string message) =>
        Results.Json(new { error = message }, statusCode: status);

    private static bool TryCaller(TenantContext tenant, out Guid userId)
    {
        if (tenant.UserId is Guid uid) { userId = uid; return true; }
        userId = default;
        return false;
    }

    // ------------------------------------------------------------------
    //  Token plumbing. 16 CSPRNG bytes → 22-char base64url. Stored and
    //  looked up ONLY as SHA-256 hex; the shape check below lets obviously
    //  malformed input fail before it costs a hash or a query.
    // ------------------------------------------------------------------

    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    private static partial Regex TokenShape();

    private static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string HashToken(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static async Task<bool> PublicLinksAllowedAsync(AppDbContext db, CancellationToken ct)
    {
        // Absent row = defaults = allowed.
        var s = await db.SpaceTenantSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        return s?.AllowPublicLinks ?? true;
    }

    // ==================================================================
    //  POST /api/space/files/{id}/link
    // ==================================================================

    public sealed record CreateLinkRequest(int? ExpiresInDays, int? MaxDownloads);

    private static async Task<IResult> CreateLinkAsync(
        Guid id, CreateLinkRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, IConfiguration config, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var days = req.ExpiresInDays ?? DefaultExpiryDays;
        if (days < 1 || days > MaxExpiryDays)
            return Error(400, $"expiresInDays must be between 1 and {MaxExpiryDays}.");
        if (req.MaxDownloads is < 1)
            return Error(400, "maxDownloads must be at least 1.");

        if (!await PublicLinksAllowedAsync(db, ct))
            return Error(403, "Public links are turned off for your organisation.");

        // Same level rule as shares: owner on personal, edit on organisational.
        var (gateError, _, _) = await SpaceEndpoints.ShareGateAsync(id, isFile: true, db, uid, ct);
        if (gateError is not null) return gateError;

        var file = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is not null)
            return Error(409, "This file is in the trash. Restore it first.");

        var token = NewToken();
        var link = new SpacePublicLink
        {
            TenantId = tenant.TenantId,
            FileId = id,
            TokenHash = HashToken(token),
            CreatedByUserId = uid,
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(days),
            MaxDownloads = req.MaxDownloads,
        };
        db.SpacePublicLinks.Add(link);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("space.link.created",
            targetType: "space_file", targetId: id.ToString(),
            after: new { linkId = link.Id, link.ExpiresAt, link.MaxDownloads },
            ct: ct, productCode: "drive");

        var baseUrl = (config["Space:PublicBaseUrl"] ?? "https://space.tatvaos.com").TrimEnd('/');

        // The ONLY response that ever contains the token. The url is the
        // landing page (Core's doorstep), not the raw API route.
        // Same shape the list route returns, PLUS token and url — the client
        // types the create response as a full link, and a freshly created one
        // goes straight into the list the share dialog is showing. Omitting
        // these made downloadCount and friends undefined on that first render.
        return Results.Created($"/api/space/files/{id}/links/{link.Id}", new
        {
            id = link.Id,
            token,
            url = $"{baseUrl}/l/{token}",
            createdByUserId = link.CreatedByUserId,
            expiresAt = link.ExpiresAt,
            maxDownloads = link.MaxDownloads,
            downloadCount = link.DownloadCount,
            revokedAt = link.RevokedAt,
            createdAt = link.CreatedAt,
        });
    }

    // ==================================================================
    //  GET /api/space/files/{id}/links — no tokens, ever
    // ==================================================================

    private static async Task<IResult> ListLinksAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var (gateError, _, _) = await SpaceEndpoints.ShareGateAsync(id, isFile: true, db, uid, ct);
        if (gateError is not null) return gateError;

        var links = await db.SpacePublicLinks.AsNoTracking()
            .Where(l => l.FileId == id)
            .OrderByDescending(l => l.CreatedAt)
            .ToListAsync(ct);

        var creatorIds = links.Where(l => l.CreatedByUserId != null)
            .Select(l => l.CreatedByUserId!.Value).Distinct().ToList();
        var names = creatorIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.Users.AsNoTracking()
                .Where(u => creatorIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return Results.Ok(new
        {
            links = links.Select(l => new
            {
                id = l.Id,
                createdByUserId = l.CreatedByUserId,
                createdByDisplayName = l.CreatedByUserId is Guid c ? names.GetValueOrDefault(c) : null,
                expiresAt = l.ExpiresAt,
                maxDownloads = l.MaxDownloads,
                downloadCount = l.DownloadCount,
                revokedAt = l.RevokedAt,
                createdAt = l.CreatedAt,
            }).ToList()
        });
    }

    // ==================================================================
    //  DELETE /api/space/files/{id}/links/{linkId} — revoke (a stamp)
    // ==================================================================

    private static async Task<IResult> RevokeLinkAsync(
        Guid id, Guid linkId, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var (gateError, _, _) = await SpaceEndpoints.ShareGateAsync(id, isFile: true, db, uid, ct);
        if (gateError is not null) return gateError;

        var link = await db.SpacePublicLinks
            .FirstOrDefaultAsync(l => l.Id == linkId && l.FileId == id, ct);
        if (link is null) return Error(404, "No such link.");

        if (link.RevokedAt is null)
        {
            link.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            await audit.WriteAsync("space.link.revoked",
                targetType: "space_file", targetId: id.ToString(),
                before: new { linkId = link.Id, link.DownloadCount },
                ct: ct, productCode: "drive");
        }

        return Results.NoContent();
    }

    // ==================================================================
    //  Org settings — the admin toggle's backend
    // ==================================================================

    public sealed record SettingsRequest(bool AllowPublicLinks);

    private static async Task<IResult> GetSettingsAsync(AppDbContext db, CancellationToken ct)
    {
        var s = await db.SpaceTenantSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        return Results.Ok(new { allowPublicLinks = s?.AllowPublicLinks ?? true });
    }

    private static async Task<IResult> PutSettingsAsync(
        SettingsRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var s = await db.SpaceTenantSettings.FirstOrDefaultAsync(ct);
        var before = s?.AllowPublicLinks ?? true;

        if (s is null)
        {
            s = new SpaceTenantSetting { TenantId = tenant.TenantId };
            db.SpaceTenantSettings.Add(s);
        }
        s.AllowPublicLinks = req.AllowPublicLinks;
        s.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Off closes the TAP: every existing link 404s immediately (the
        // resolve predicate checks this flag), reversibly. Audited — this
        // is org policy changing hands.
        await audit.WriteAsync("space.settings.public_links",
            targetType: "space_settings", targetId: tenant.TenantId.ToString(),
            before: new { allowPublicLinks = before },
            after: new { allowPublicLinks = s.AllowPublicLinks },
            ct: ct, productCode: "drive");

        return Results.Ok(new { allowPublicLinks = s.AllowPublicLinks });
    }

    // ==================================================================
    //  THE ANONYMOUS PAIR — read with suspicion; that is its natural state
    // ==================================================================

    private sealed class PeekRow
    {
        public Guid FileId { get; set; }
        public string Name { get; set; } = "";
        public string MimeType { get; set; } = "";
        public long SizeBytes { get; set; }
        public string? SharedBy { get; set; }
        public DateTimeOffset ExpiresAt { get; set; }
    }

    private sealed class ConsumeRow
    {
        public string BlobKey { get; set; } = "";
        public string Name { get; set; } = "";
        public string MimeType { get; set; } = "";
        public long SizeBytes { get; set; }
        // Returned so a missing blob can be logged as the storage loss it is
        // — see 20260819-space-link-loss-logging.sql.
        public Guid LinkId { get; set; }
        public Guid FileId { get; set; }
    }

    /// <summary>GET /api/space/l/{token} — the bytes.</summary>
    private static async Task<IResult> DownloadAsync(
        string token, HttpContext http, AppDbContext db, IBlobStore blobs,
        ILoggerFactory loggerFactory, CancellationToken ct)
    {
        // Shape check first: garbage fails before it costs a hash or a query.
        if (!TokenShape().IsMatch(token)) return LinkNotFound();

        // The atomic consume: the UPDATE inside is the entire check, so the
        // count cannot be raced past max_downloads. No row = 404, one string.
        var row = await db.Database.SqlQuery<ConsumeRow>($"""
            SELECT blob_key   AS "BlobKey",
                   name       AS "Name",
                   mime_type  AS "MimeType",
                   size_bytes AS "SizeBytes",
                   link_id    AS "LinkId",
                   file_id    AS "FileId"
              FROM space.consume_public_link({HashToken(token)})
            """).FirstOrDefaultAsync(ct);
        if (row is null) return LinkNotFound();

        var stream = blobs.OpenRead(row.BlobKey);
        if (stream is null)
        {
            // Blob missing after a successful consume — our fault, so the
            // recipient does not pay for it: refund the count (review
            // finding F1; floored at zero inside the function). Same one
            // 404 answer as everything else on this path.
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                SELECT space.refund_public_link({HashToken(token)})
                """, ct);

            // WARNING, never information: a missing blob is never normal.
            // Either the volume lost data or something deleted the bytes and
            // left the row — both are incidents, and info level would bury
            // them under the ordinary. The blob key is the field that earns
            // its place: it tells whoever reads this whether one file went
            // or a whole prefix did, which is the difference between a bug
            // and a storage failure. And the line says REFUNDED, not
            // refused, because the person reading it in six months is
            // deciding whether a customer lost data — "link not found"
            // would not answer that question.
            loggerFactory
                .CreateLogger("TatvaOS.Space.PublicLinks")
                .LogWarning(
                    "Public link consumed and REFUNDED because the file's bytes are "
                    + "missing from storage — the file is gone, not the link. "
                    + "fileId={FileId} linkId={LinkId} blobKey={BlobKey}",
                    row.FileId, row.LinkId, row.BlobKey);

            return LinkNotFound();
        }

        // Always a download, never a rendered page — this origin holds
        // sessions, and inline HTML from a stranger is XSS against them all.
        http.Response.Headers.XContentTypeOptions = "nosniff";

        // No range processing, deliberately: one GET = one download = one
        // count. fileDownloadName forces Content-Disposition: attachment.
        return Results.File(stream, row.MimeType, row.Name);
    }

    /// <summary>
    /// GET /api/space/l/{token}/meta — the landing page's data. Counts
    /// NOTHING; peek_public_link has no side effects.
    /// </summary>
    private static async Task<IResult> MetaAsync(
        string token, AppDbContext db, CancellationToken ct)
    {
        if (!TokenShape().IsMatch(token)) return LinkNotFound();

        var row = await db.Database.SqlQuery<PeekRow>($"""
            SELECT file_id    AS "FileId",
                   name       AS "Name",
                   mime_type  AS "MimeType",
                   size_bytes AS "SizeBytes",
                   shared_by  AS "SharedBy",
                   expires_at AS "ExpiresAt"
              FROM space.peek_public_link({HashToken(token)})
            """).FirstOrDefaultAsync(ct);
        if (row is null) return LinkNotFound();

        // sharedByDisplayName to the anonymous internet is a CONSCIOUS
        // decision (v1.3 review): the landing page's job is to look
        // legitimate, and the recipient already knows the sender.
        return Results.Ok(new
        {
            name = row.Name,
            sizeBytes = row.SizeBytes,
            mimeType = row.MimeType,
            sharedByDisplayName = row.SharedBy,
            expiresAt = row.ExpiresAt,
        });
    }
}
