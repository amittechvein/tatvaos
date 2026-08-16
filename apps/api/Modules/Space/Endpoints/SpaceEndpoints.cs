using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Space.Endpoints;

/// <summary>
/// The Space client's API — what space.tatvaos.com talks to.
/// Contract: docs/SPACE_API.md (v1.1). Read it before changing shapes here;
/// the frontend is built against it, not against this file.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Visibility vs permission, restated from the contract:
///
///  An id in a URL proves nothing. Every handler loads through the DbSet
///  (tenant filter) and RLS repeats the test underneath — including the
///  share/ancestor walk via space.can_access_folder. An item the caller
///  cannot SEE is a 404, never a 403: confirming a row exists is itself a
///  disclosure. An item they can see but lack the LEVEL for is a 403.
///
///  Levels: view &lt; comment &lt; edit &lt; owner. Effective = the highest grant on
///  the item or any ancestor folder; owner for the owner; edit baseline for
///  anyone in the tenant on organisational items. In listings this is
///  computed BATCHED — one chain walk for the folder plus one share query
///  for the page — never a recursive query per row. Contract commitment.
///
///  Storage refusals are 413 + reason (full | suspended | no_allocation |
///  file_too_large), NEVER a 5xx: clients and proxies auto-retry 5xx, and
///  re-streaming a 2 GB upload on a quota refusal is the worst retry there
///  is. Quota numbers come from StorageAllocator and the core tables ONLY —
///  Space owns no quota system.
///
///  Audit: intended to go to core.audit_logs with product_code 'drive' via
///  AuditWriter — wiring lands once AuditWriter takes a productCode.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SpaceEndpoints
{
    public static void MapSpaceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/space")
            .RequireAuthorization("User")
            .WithTags("Space");

        // Browsing
        g.MapGet("/list", ListAsync);
        g.MapGet("/shared", SharedAsync);
        g.MapGet("/trash", TrashAsync);
        g.MapGet("/search", SearchAsync);

        // Files
        g.MapPost("/files", UploadAsync);
        g.MapPut("/files/{id:guid}/content", OverwriteAsync);
        g.MapGet("/files/{id:guid}/content", DownloadAsync);
        g.MapPatch("/files/{id:guid}", PatchFileAsync);
        g.MapPut("/files/{id:guid}/ownership", FileOwnershipAsync);
        g.MapDelete("/files/{id:guid}", TrashFileAsync);
        g.MapPost("/files/{id:guid}/restore", RestoreFileAsync);
        g.MapDelete("/files/{id:guid}/permanent", PurgeFileAsync);

        // Folders
        g.MapPost("/folders", CreateFolderAsync);
        g.MapPatch("/folders/{id:guid}", PatchFolderAsync);
        g.MapDelete("/folders/{id:guid}", TrashFolderAsync);
        g.MapPost("/folders/{id:guid}/restore", RestoreFolderAsync);
        g.MapDelete("/folders/{id:guid}/permanent", PurgeFolderAsync);

        // Shares
        g.MapGet("/files/{id:guid}/shares", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => ListSharesAsync(id, isFile: true, db, t, ct));
        g.MapPut("/files/{id:guid}/shares", (Guid id, ShareRequest r, AppDbContext db, TenantContext t, CancellationToken ct) => PutShareAsync(id, isFile: true, r, db, t, ct));
        g.MapDelete("/files/{id:guid}/shares/{shareId:guid}", (Guid id, Guid shareId, AppDbContext db, TenantContext t, CancellationToken ct) => DeleteShareAsync(id, shareId, isFile: true, db, t, ct));
        g.MapGet("/folders/{id:guid}/shares", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => ListSharesAsync(id, isFile: false, db, t, ct));
        g.MapPut("/folders/{id:guid}/shares", (Guid id, ShareRequest r, AppDbContext db, TenantContext t, CancellationToken ct) => PutShareAsync(id, isFile: false, r, db, t, ct));
        g.MapDelete("/folders/{id:guid}/shares/{shareId:guid}", (Guid id, Guid shareId, AppDbContext db, TenantContext t, CancellationToken ct) => DeleteShareAsync(id, shareId, isFile: false, db, t, ct));
    }

    private const int RetentionDays = 30;

    // ------------------------------------------------------------------
    //  DTOs — property names are the contract's JSON fields.
    // ------------------------------------------------------------------

    public sealed record BreadcrumbDto(Guid? Id, string Name);

    public sealed record SpaceFolderDto(
        Guid Id, string Name, Guid? ParentFolderId,
        string OwnershipType, Guid? OwnerUserId, Guid? CreatedByUserId,
        string MyPermission, bool IsShared,
        DateTimeOffset? DeletedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        int ChildFolderCount, int FileCount,
        bool IsStarred = false, string? OwnerDisplayName = null, string? ParentName = null);

    public sealed record SpaceFileDto(
        Guid Id, string Name, string MimeType, long SizeBytes, Guid? FolderId,
        string OwnershipType, Guid? OwnerUserId, Guid? CreatedByUserId,
        string MyPermission, bool IsShared,
        DateTimeOffset? DeletedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        bool IsStarred = false, string? OwnerDisplayName = null, string? ParentName = null,
        ActivityDto? Activity = null);

    public sealed record ShareDto(
        Guid Id, Guid? UserId, string? UserDisplayName, bool OrgWide,
        string Permission, Guid? SharedByUserId, DateTimeOffset CreatedAt);

    public sealed record CreateFolderRequest(string? Name, Guid? ParentFolderId, string? Scope);
    public sealed record PatchRequest(string? Name, Guid? FolderId, Guid? ParentFolderId, string? Scope);
    public sealed record OwnershipRequest(string? OwnershipType);
    public sealed record ShareRequest(Guid? UserId, bool OrgWide, string? Permission);
    public sealed record ActivityDto(string Action, DateTimeOffset OccurredAt);

    private static IResult Error(int status, string message, string? reason = null) =>
        reason is null
            ? Results.Json(new { error = message }, statusCode: status)
            : Results.Json(new { error = message, reason }, statusCode: status);

    // ------------------------------------------------------------------
    //  The caller. Same shape as Family's TryCaller: the claim is optional
    //  in the type system even though the group requires auth, and
    //  defaulting to Guid.Empty would MATCH rows rather than none.
    // ------------------------------------------------------------------
    private static bool TryCaller(TenantContext tenant, out Guid userId)
    {
        if (tenant.UserId is Guid uid) { userId = uid; return true; }
        userId = default;
        return false;
    }

    // ------------------------------------------------------------------
    //  The ancestor chain, current folder first (Depth 1), walking up.
    //
    //  Raw SQL because LINQ cannot express a recursive CTE. RLS still
    //  applies to every row it touches — the connection carries
    //  app.tenant_id / app.user_id — which produces a deliberate feature:
    //  for an item reachable only through a shared folder, ancestors ABOVE
    //  the share root are invisible and simply drop out, so the breadcrumb
    //  truncates at the share root exactly the way Drive's does.
    //
    //  The depth guard mirrors the 32-level cap; even a cycle that slipped
    //  past the move check terminates here instead of hanging.
    // ------------------------------------------------------------------

    private sealed class ChainRow
    {
        public Guid Id { get; set; }
        public Guid? ParentFolderId { get; set; }
        public string Name { get; set; } = "";
        public string OwnershipType { get; set; } = "";
        public Guid? OwnerUserId { get; set; }
        public DateTimeOffset? DeletedAt { get; set; }
        public int Depth { get; set; }
    }

    private static Task<List<ChainRow>> ChainAsync(AppDbContext db, Guid folderId, CancellationToken ct)
        => db.Database.SqlQuery<ChainRow>($"""
            WITH RECURSIVE chain AS (
                SELECT f.id, f.parent_folder_id, f.name, f.ownership_type, f.owner_user_id,
                       f.deleted_at, 1 AS depth
                  FROM space.folders f
                 WHERE f.id = {folderId}
                UNION ALL
                SELECT f.id, f.parent_folder_id, f.name, f.ownership_type, f.owner_user_id,
                       f.deleted_at, c.depth + 1
                  FROM space.folders f
                  JOIN chain c ON f.id = c.parent_folder_id
                 WHERE c.depth < 32
            )
            SELECT id                AS "Id",
                   parent_folder_id  AS "ParentFolderId",
                   name              AS "Name",
                   ownership_type    AS "OwnershipType",
                   owner_user_id     AS "OwnerUserId",
                   deleted_at        AS "DeletedAt",
                   depth             AS "Depth"
              FROM chain
             ORDER BY depth
            """).ToListAsync(ct);

    // ------------------------------------------------------------------
    //  The permission ladder.
    // ------------------------------------------------------------------

    private static int Rank(string p) => p switch
    {
        "owner" => 3, "edit" => 2, "comment" => 1, "view" => 0, _ => -1
    };

    private static string MaxPerm(string a, string b) => Rank(a) >= Rank(b) ? a : b;

    /// <summary>
    /// The caller's level for a folder, from its loaded chain plus the grants
    /// found on any node of it. "view" fallback is for a row RLS admitted
    /// through a grant this query context cannot see — fail LOW, never open.
    /// </summary>
    private static string ChainPermission(List<ChainRow> chain, IReadOnlyCollection<string> chainGrants, Guid uid)
    {
        if (chain.Any(c => c.OwnerUserId == uid)) return "owner";

        var p = chain.Any(c => c.OwnershipType == "organisational") ? "edit" : "";
        foreach (var grant in chainGrants)
            p = p.Length == 0 ? grant : MaxPerm(p, grant);

        return p.Length == 0 ? "view" : p;
    }

    private static async Task<List<string>> ChainGrantsAsync(
        AppDbContext db, List<ChainRow> chain, Guid uid, CancellationToken ct)
    {
        var ids = chain.Select(c => c.Id).ToList();
        return await db.SpaceShares
            .Where(s => s.FolderId != null && ids.Contains(s.FolderId.Value)
                        && (s.OrgWide || s.SharedWithUserId == uid))
            .Select(s => s.Permission)
            .ToListAsync(ct);
    }

    private static async Task<string> FolderPermAsync(AppDbContext db, Guid folderId, Guid uid, CancellationToken ct)
    {
        var chain = await ChainAsync(db, folderId, ct);
        return ChainPermission(chain, await ChainGrantsAsync(db, chain, uid, ct), uid);
    }

    /// <summary>
    /// The caller's level for one FILE: owner short-circuits; otherwise
    /// max(org baseline, ancestor-derived — capped at edit, because owning
    /// the folder does not make you owner of a colleague's item — and the
    /// file's own grants).
    /// </summary>
    private static async Task<string> FilePermAsync(AppDbContext db, SpaceFile f, Guid uid, CancellationToken ct)
    {
        if (f.OwnerUserId == uid) return "owner";

        var p = f.OwnershipType == "organisational" ? "edit" : "";

        if (f.FolderId is Guid fid)
        {
            var viaChain = await FolderPermAsync(db, fid, uid, ct);
            if (viaChain == "owner") viaChain = "edit";
            p = p.Length == 0 ? viaChain : MaxPerm(p, viaChain);
        }

        var own = await db.SpaceShares
            .Where(s => s.FileId == f.Id && (s.OrgWide || s.SharedWithUserId == uid))
            .Select(s => s.Permission)
            .ToListAsync(ct);
        foreach (var grant in own)
            p = p.Length == 0 ? grant : MaxPerm(p, grant);

        return p.Length == 0 ? "view" : p;
    }

    private static SpaceFileDto FileDto(SpaceFile f, string perm, bool shared) => new(
        f.Id, f.Name, f.MimeType, f.SizeBytes, f.FolderId,
        f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
        perm, shared, f.DeletedAt, f.CreatedAt, f.UpdatedAt);

    // ==================================================================
    //  GET /api/space/list
    // ==================================================================

    private static async Task<IResult> ListAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        Guid? folderId = null, string? scope = null,
        int page = 1, int pageSize = 200)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var scopeGiven = !string.IsNullOrEmpty(scope);
        if (folderId is null == !scopeGiven)
            return Error(400, "Provide either folderId or scope, not both or neither.");
        if (scopeGiven && scope is not ("personal" or "organisational"))
            return Error(400, "scope must be personal or organisational.");

        if (page < 1) page = 1;
        pageSize = Math.Clamp(pageSize, 1, 500);

        string basePerm;
        var breadcrumb = new List<BreadcrumbDto>();
        SpaceFolder? self = null;

        if (folderId is Guid fid)
        {
            self = await db.SpaceFolders.AsNoTracking()
                .FirstOrDefaultAsync(f => f.Id == fid && f.DeletedAt == null, ct);
            if (self is null) return Error(404, "No such folder.");

            var chain = await ChainAsync(db, fid, ct);
            basePerm = ChainPermission(chain, await ChainGrantsAsync(db, chain, uid, ct), uid);

            // Root-first breadcrumb. If the chain topped out below an actual
            // root (a share reached us mid-tree), start at the truncation
            // point — the caller has no business seeing what sits above it.
            var top = chain[^1];
            if (top.ParentFolderId is null)
                breadcrumb.Add(new BreadcrumbDto(null,
                    top.OwnershipType == "organisational" ? "Organisation" : "My Space"));
            for (var i = chain.Count - 1; i >= 0; i--)
                breadcrumb.Add(new BreadcrumbDto(chain[i].Id, chain[i].Name));
        }
        else
        {
            basePerm = scope == "personal" ? "owner" : "edit";
            breadcrumb.Add(new BreadcrumbDto(null, scope == "personal" ? "My Space" : "Organisation"));
        }

        // ---- Children: folders (never paged), files (paged) --------------

        var folderQuery = folderId is Guid pfid
            ? db.SpaceFolders.Where(f => f.ParentFolderId == pfid && f.DeletedAt == null)
            : scope == "personal"
                ? db.SpaceFolders.Where(f => f.ParentFolderId == null && f.DeletedAt == null
                                             && f.OwnershipType == "personal" && f.OwnerUserId == uid)
                : db.SpaceFolders.Where(f => f.ParentFolderId == null && f.DeletedAt == null
                                             && f.OwnershipType == "organisational");

        var childFolders = await folderQuery.AsNoTracking().OrderBy(f => f.Name).ToListAsync(ct);

        var fileQuery = folderId is Guid ffid
            ? db.SpaceFiles.Where(f => f.FolderId == ffid && f.DeletedAt == null)
            : scope == "personal"
                ? db.SpaceFiles.Where(f => f.FolderId == null && f.DeletedAt == null
                                           && f.OwnershipType == "personal" && f.OwnerUserId == uid)
                : db.SpaceFiles.Where(f => f.FolderId == null && f.DeletedAt == null
                                           && f.OwnershipType == "organisational");

        var totalFiles = await fileQuery.CountAsync(ct);
        var files = await fileQuery.AsNoTracking()
            .OrderBy(f => f.Name).ThenBy(f => f.Id)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .ToListAsync(ct);

        // ---- Batched decoration: counts, shares, per-row permission ------
        // The contract commits to this being O(queries), not O(rows).

        var childIds = childFolders.Select(f => f.Id).ToList();
        var fileIds = files.Select(f => f.Id).ToList();

        var folderCountByParent = childIds.Count == 0
            ? new Dictionary<Guid, int>()
            : await db.SpaceFolders
                .Where(f => f.ParentFolderId != null && childIds.Contains(f.ParentFolderId.Value)
                            && f.DeletedAt == null)
                .GroupBy(f => f.ParentFolderId!.Value)
                .Select(gr => new { gr.Key, N = gr.Count() })
                .ToDictionaryAsync(x => x.Key, x => x.N, ct);
        var fileCountByParent = childIds.Count == 0
            ? new Dictionary<Guid, int>()
            : await db.SpaceFiles
                .Where(f => f.FolderId != null && childIds.Contains(f.FolderId.Value)
                            && f.DeletedAt == null)
                .GroupBy(f => f.FolderId!.Value)
                .Select(gr => new { gr.Key, N = gr.Count() })
                .ToDictionaryAsync(x => x.Key, x => x.N, ct);

        // Share rows for everything on the page, one query. Feeds BOTH
        // IsShared and the caller's per-row grant fold.
        var pageShares = (childIds.Count == 0 && fileIds.Count == 0)
            ? []
            : await db.SpaceShares.AsNoTracking()
                .Where(s => (s.FolderId != null && childIds.Contains(s.FolderId.Value))
                         || (s.FileId != null && fileIds.Contains(s.FileId.Value)))
                .ToListAsync(ct);

        var folderShared = pageShares.Where(s => s.FolderId != null)
            .Select(s => s.FolderId!.Value).ToHashSet();
        var fileShared = pageShares.Where(s => s.FileId != null)
            .Select(s => s.FileId!.Value).ToHashSet();

        var folderGrants = pageShares
            .Where(s => s.FolderId != null && (s.OrgWide || s.SharedWithUserId == uid))
            .ToLookup(s => s.FolderId!.Value, s => s.Permission);
        var fileGrants = pageShares
            .Where(s => s.FileId != null && (s.OrgWide || s.SharedWithUserId == uid))
            .ToLookup(s => s.FileId!.Value, s => s.Permission);

        string PermOf(string ownership, Guid? owner, IEnumerable<string> grants)
        {
            if (owner == uid) return "owner";
            // Owning the PARENT does not make you owner of a colleague's item.
            var inherited = basePerm == "owner" ? "edit" : basePerm;
            var p = ownership == "organisational" ? MaxPerm("edit", inherited) : inherited;
            foreach (var grant in grants) p = MaxPerm(p, grant);
            return p;
        }

        var folderDtos = childFolders.Select(f => new SpaceFolderDto(
            f.Id, f.Name, f.ParentFolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            PermOf(f.OwnershipType, f.OwnerUserId, folderGrants[f.Id]),
            folderShared.Contains(f.Id),
            f.DeletedAt, f.CreatedAt, f.UpdatedAt,
            folderCountByParent.GetValueOrDefault(f.Id),
            fileCountByParent.GetValueOrDefault(f.Id))).ToList();

        var fileDtos = files.Select(f => FileDto(
            f, PermOf(f.OwnershipType, f.OwnerUserId, fileGrants[f.Id]),
            fileShared.Contains(f.Id))).ToList();

        SpaceFolderDto? current = null;
        if (self is not null)
        {
            current = new SpaceFolderDto(
                self.Id, self.Name, self.ParentFolderId,
                self.OwnershipType, self.OwnerUserId, self.CreatedByUserId,
                basePerm,
                await db.SpaceShares.AnyAsync(s => s.FolderId == self.Id, ct),
                self.DeletedAt, self.CreatedAt, self.UpdatedAt,
                folderDtos.Count, totalFiles);
        }

        // Batched isStarred / ownerDisplayName for the whole page (contract
        // v1.2). No parentName here — the breadcrumb answers location.
        var decoAll = await SpaceDriveEndpoints.DecorateAsync(db, uid,
            current is null ? folderDtos : [current, .. folderDtos],
            fileDtos, withParentName: false, ct);
        fileDtos = decoAll.Files;
        if (current is null) folderDtos = decoAll.Folders;
        else { current = decoAll.Folders[0]; folderDtos = decoAll.Folders.Skip(1).ToList(); }

        return Results.Ok(new
        {
            breadcrumb,
            folder = current,
            folders = folderDtos,
            files = fileDtos,
            page,
            pageSize,
            totalFiles
        });
    }

    // ==================================================================
    //  GET /api/space/shared — items shared TO me, top level only
    // ==================================================================

    private static async Task<IResult> SharedAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var mine = await db.SpaceShares.AsNoTracking()
            .Where(s => s.OrgWide || s.SharedWithUserId == uid)
            .ToListAsync(ct);

        var folderIds = mine.Where(s => s.FolderId != null).Select(s => s.FolderId!.Value).Distinct().ToList();
        var fileIds = mine.Where(s => s.FileId != null).Select(s => s.FileId!.Value).Distinct().ToList();

        // Live targets only, and never my own items — my things live in my
        // tree, not in "shared with me".
        var folders = await db.SpaceFolders.AsNoTracking()
            .Where(f => folderIds.Contains(f.Id) && f.DeletedAt == null && f.OwnerUserId != uid)
            .OrderBy(f => f.Name).ToListAsync(ct);
        var files = await db.SpaceFiles.AsNoTracking()
            .Where(f => fileIds.Contains(f.Id) && f.DeletedAt == null && f.OwnerUserId != uid)
            .OrderBy(f => f.Name).ToListAsync(ct);

        var folderGrants = mine.Where(s => s.FolderId != null)
            .ToLookup(s => s.FolderId!.Value, s => s.Permission);
        var fileGrants = mine.Where(s => s.FileId != null)
            .ToLookup(s => s.FileId!.Value, s => s.Permission);

        string GrantMax(IEnumerable<string> grants)
        {
            var p = "view";
            foreach (var grant in grants) p = MaxPerm(p, grant);
            return p;
        }

        var folderDtos = folders.Select(f => new SpaceFolderDto(
            f.Id, f.Name, f.ParentFolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            GrantMax(folderGrants[f.Id]), true,
            f.DeletedAt, f.CreatedAt, f.UpdatedAt, 0, 0)).ToList();
        var fileDtos = files.Select(f => FileDto(f, GrantMax(fileGrants[f.Id]), true)).ToList();
        var deco = await SpaceDriveEndpoints.DecorateAsync(db, uid, folderDtos, fileDtos, withParentName: true, ct);
        return Results.Ok(new { folders = deco.Folders, files = deco.Files });
    }

    // ==================================================================
    //  GET /api/space/trash — my trash, top items only
    // ==================================================================

    private static async Task<IResult> TrashAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        // Items whose OWN stamp is set. Contents of a trashed folder carry no
        // stamp and are not listed — restore is one un-stamp. Scoped to items
        // the caller can act on: their own, or organisational.
        var folders = await db.SpaceFolders.AsNoTracking()
            .Where(f => f.DeletedAt != null
                        && (f.OwnerUserId == uid || f.OwnershipType == "organisational"))
            .OrderByDescending(f => f.DeletedAt).ToListAsync(ct);
        var files = await db.SpaceFiles.AsNoTracking()
            .Where(f => f.DeletedAt != null
                        && (f.OwnerUserId == uid || f.OwnershipType == "organisational"))
            .OrderByDescending(f => f.DeletedAt).ToListAsync(ct);

        // Reclaimable bytes: directly-trashed files plus everything inside
        // trashed folders. RLS scopes the walk to what this caller may see.
        var trashBytes = await db.Database.SqlQuery<long>($"""
            WITH RECURSIVE sub AS (
                SELECT id FROM space.folders WHERE deleted_at IS NOT NULL
                UNION
                SELECT f.id FROM space.folders f JOIN sub s ON f.parent_folder_id = s.id
            )
            SELECT COALESCE(SUM(f.size_bytes), 0)::bigint AS "Value"
              FROM space.files f
             WHERE f.deleted_at IS NOT NULL
                OR f.folder_id IN (SELECT id FROM sub)
            """).FirstOrDefaultAsync(ct);

        var folderDtos = folders.Select(f => new SpaceFolderDto(
            f.Id, f.Name, f.ParentFolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            f.OwnerUserId == uid ? "owner" : "edit", false,
            f.DeletedAt, f.CreatedAt, f.UpdatedAt, 0, 0)).ToList();
        var fileDtos = files.Select(f => FileDto(f, f.OwnerUserId == uid ? "owner" : "edit", false)).ToList();
        var deco = await SpaceDriveEndpoints.DecorateAsync(db, uid, folderDtos, fileDtos, withParentName: false, ct);
        return Results.Ok(new
        {
            folders = deco.Folders,
            files = deco.Files,
            retentionDays = RetentionDays,
            trashBytes
        });
    }

    // ==================================================================
    //  GET /api/space/search — file names, live items only
    // ==================================================================

    private static async Task<IResult> SearchAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        string? q = null, int page = 1, int pageSize = 50)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(q)) return Error(400, "A search term is required.");

        if (page < 1) page = 1;
        pageSize = Math.Clamp(pageSize, 1, 200);
        var offset = (page - 1) * pageSize;

        var total = await db.Database.SqlQuery<int>($"""
            SELECT count(*)::int AS "Value" FROM space.files
             WHERE deleted_at IS NULL
               AND search_vector @@ plainto_tsquery('simple', {q})
            """).FirstOrDefaultAsync(ct);

        var ids = await db.Database.SqlQuery<Guid>($"""
            SELECT id AS "Value" FROM space.files
             WHERE deleted_at IS NULL
               AND search_vector @@ plainto_tsquery('simple', {q})
             ORDER BY ts_rank(search_vector, plainto_tsquery('simple', {q})) DESC, name
             OFFSET {offset} LIMIT {pageSize}
            """).ToListAsync(ct);

        var rows = await db.SpaceFiles.AsNoTracking()
            .Where(f => ids.Contains(f.Id)).ToListAsync(ct);
        var byId = rows.ToDictionary(f => f.Id);
        var ordered = ids.Where(byId.ContainsKey).Select(i => byId[i]).ToList();

        // Results span many folders, so per-row ancestor walks are off the
        // table by contract. Level is approximated LOW from what one batched
        // query can see: owner / org baseline / the file's own grants. RLS
        // already guaranteed visibility; a level shown as view when an
        // ancestor grant says edit costs a click, not a leak.
        var grants = ids.Count == 0
            ? []
            : await db.SpaceShares.AsNoTracking()
                .Where(s => s.FileId != null && ids.Contains(s.FileId.Value))
                .ToListAsync(ct);
        var shared = grants.Where(s => s.FileId != null).Select(s => s.FileId!.Value).ToHashSet();
        var mine = grants.Where(s => s.FileId != null && (s.OrgWide || s.SharedWithUserId == uid))
            .ToLookup(s => s.FileId!.Value, s => s.Permission);

        string PermOf(SpaceFile f)
        {
            if (f.OwnerUserId == uid) return "owner";
            var p = f.OwnershipType == "organisational" ? "edit" : "view";
            foreach (var grant in mine[f.Id]) p = MaxPerm(p, grant);
            return p;
        }

        var fileDtos = ordered.Select(f => FileDto(f, PermOf(f), shared.Contains(f.Id))).ToList();
        var deco = await SpaceDriveEndpoints.DecorateAsync(db, uid, [], fileDtos, withParentName: true, ct);
        return Results.Ok(new { files = deco.Files, page, pageSize, total });
    }

    // ==================================================================
    //  Upload machinery
    // ==================================================================

    /// <summary>
    /// Destination check shared by upload and folder creation: the target
    /// folder (or root scope), the ownership new content inherits, and the
    /// caller's level there.
    /// </summary>
    private static async Task<(IResult? Error, Guid? FolderId, string OwnershipType, Guid? OwnerUserId)>
        ResolveDestinationAsync(AppDbContext db, Guid uid, Guid? folderId, string? scope, CancellationToken ct)
    {
        if (folderId is Guid fid)
        {
            var parent = await db.SpaceFolders.AsNoTracking()
                .FirstOrDefaultAsync(f => f.Id == fid && f.DeletedAt == null, ct);
            if (parent is null)
                return (Error(404, "No such folder."), null, "", null);

            if (Rank(await FolderPermAsync(db, fid, uid, ct)) < Rank("edit"))
                return (Error(403, "You need edit access here."), null, "", null);

            // Contents take the ownership of the folder they land in — a file
            // uploaded into a colleague's shared personal tree belongs to that
            // colleague, exactly as in Drive.
            return (null, fid, parent.OwnershipType, parent.OwnerUserId);
        }

        if (scope is not ("personal" or "organisational"))
            return (Error(400, "scope must be personal or organisational when targeting a root."), null, "", null);

        return (null, null, scope, scope == "personal" ? uid : null);
    }

    /// <summary>
    /// The storage gate, before any byte is read — the ONE-ALLOWANCE-PER-
    /// PERSON model (docs/STORAGE_MODEL.md, migration 31).
    ///
    /// PERSONAL content is charged to the person who will OWN the file — the
    /// caller, except inside a colleague's shared personal tree, where the
    /// bytes land on the folder owner's meter. The gate checks whoever the
    /// meter will charge, or enforcement and metering disagree. The figure
    /// comes from core.user_storage(), the single definition of "how full is
    /// this person" — NEVER a SUM in application code, which would be the
    /// second implementation and therefore the bug.
    ///
    /// ORGANISATIONAL content stays on the org pool: data with no owner is
    /// never charged to a human.
    ///
    /// Shared with SpaceContentGateway so the API and the cross-product save
    /// path cannot drift apart. One status (413) for every refusal; the
    /// caller branches on reason, and "full" now names WHOSE storage is full
    /// because the fix is different in each case.
    /// </summary>
    internal sealed record QuotaVerdict(string? Message, string? Reason)
    {
        public bool Ok => Message is null;
    }

    private sealed class UserStorageRow
    {
        public long? QuotaBytes { get; set; }
        public long UsedBytes { get; set; }
    }

    internal static async Task<QuotaVerdict> EvaluateStorageAsync(
        AppDbContext db, StorageAllocator allocator, Guid tenantId,
        string ownershipType, Guid? ownerUserId, Guid callerId,
        long deltaBytes, long declaredBytes, long maxFileBytes, CancellationToken ct)
    {
        if (declaredBytes > maxFileBytes)
            return new($"Files are limited to {maxFileBytes / (1024 * 1024)} MB each.", "file_too_large");

        var status = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenantId).Select(t => t.Status).FirstOrDefaultAsync(ct);
        if (status == "suspended")
            return new("This organisation is suspended, so new files cannot be added.", "suspended");

        if (ownershipType == "personal")
        {
            if (ownerUserId is not Guid owner)
                // Retained, owner-less destination: nobody's meter can take
                // the charge. An admin reassigns it or hands it to the org.
                return new("This folder's owner has been removed, so nothing can be added here until an administrator reassigns it.", "no_allocation");

            var row = await db.Database.SqlQuery<UserStorageRow>($"""
                SELECT quota_bytes AS "QuotaBytes", used_bytes AS "UsedBytes"
                  FROM core.user_storage({owner})
                """).FirstOrDefaultAsync(ct);
            if (row is null)
                return new("This account's storage could not be determined.", "no_allocation");

            // NULL allowance = inherit — department default, then the
            // organisation's, through the same resolver mailbox quotas have
            // always used. An explicit personal figure wins outright.
            long quota;
            if (row.QuotaBytes is long explicitQuota)
            {
                quota = explicitQuota;
            }
            else
            {
                var deptId = await db.Users.AsNoTracking()
                    .Where(u => u.Id == owner).Select(u => u.DepartmentId).FirstOrDefaultAsync(ct);
                quota = await allocator.ResolveQuotaAsync(tenantId, deptId, null, "drive", ct);
            }
            if (quota <= 0)
                return new("No storage allowance is set for this account. An administrator can set one.", "no_allocation");

            if (row.UsedBytes + Math.Max(0, deltaBytes) > quota)
                return owner == callerId
                    ? new($"You have used all {HumanBytes(quota)} of your storage. Empty your trash or ask an administrator for more.", "full")
                    : new("The owner of this folder has no storage left for new files.", "full");

            return new(null, null);
        }

        // Organisational content draws on the org pool, exactly as before.
        var cap = await allocator.GetCapacityAsync(tenantId, "drive", ct);
        if (cap.TotalBytes <= 0)
            return new("No storage is allocated to Space. An administrator can allocate some on the storage page.", "no_allocation");
        if (cap.UsedBytes + Math.Max(0, deltaBytes) > cap.TotalBytes)
            return new("Your organisation's Space storage is full. An administrator can free space or raise the allocation.", "full");

        return new(null, null);
    }

    private static string HumanBytes(long b)
    {
        const long GB = 1024L * 1024 * 1024;
        return b >= GB ? $"{b / (double)GB:0.#} GB" : $"{b / (1024.0 * 1024):0} MB";
    }

    private static async Task<IResult?> CheckQuotaAsync(
        AppDbContext db, StorageAllocator allocator, Guid tenantId,
        string ownershipType, Guid? ownerUserId, Guid callerId,
        long deltaBytes, long declaredBytes, long maxFileBytes, CancellationToken ct)
    {
        var v = await EvaluateStorageAsync(db, allocator, tenantId,
            ownershipType, ownerUserId, callerId, deltaBytes, declaredBytes, maxFileBytes, ct);
        return v.Ok ? null : Error(413, v.Message!, v.Reason);
    }

    private static long MaxFileBytes(IConfiguration config)
        => config.GetValue<long?>("Space:MaxFileBytes") ?? 2L * 1024 * 1024 * 1024;

    private sealed record UploadedPart(string FileName, string ContentType, string BlobKey, long Written);

    /// <summary>
    /// Walks the multipart body IN ORDER: fields first, then the file. The
    /// gate runs the moment the file part appears — before a single content
    /// byte is read — which is the whole reason the contract fixes the field
    /// order and rejects a file part that arrives before sizeBytes.
    /// </summary>
    private static async Task<IResult> ReadUploadAsync(
        HttpRequest request, AppDbContext db, TenantContext tenant, StorageAllocator allocator,
        IBlobStore blobs, IConfiguration config, Guid uid,
        Func<Guid?, string?, long, CancellationToken, Task<(IResult? Error, long DeltaBytes)>> gate,
        Func<UploadedPart, Guid?, string?, CancellationToken, Task<IResult>> complete,
        CancellationToken ct)
    {
        if (string.IsNullOrEmpty(request.ContentType)
            || !request.ContentType.Contains("multipart/form-data", StringComparison.OrdinalIgnoreCase))
            return Error(400, "Uploads must be multipart/form-data.");

        var boundary = HeaderUtilities.RemoveQuotes(
            MediaTypeHeaderValue.Parse(request.ContentType).Boundary).Value;
        if (string.IsNullOrEmpty(boundary))
            return Error(400, "The multipart boundary is missing.");

        // Large files are the point; the default body cap is not.
        var sizeFeature = request.HttpContext.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false }) sizeFeature.MaxRequestBodySize = null;

        var reader = new MultipartReader(boundary, request.Body);
        Guid? folderId = null;
        string? scope = null;
        long? declared = null;

        while (await reader.ReadNextSectionAsync(ct) is { } section)
        {
            if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var cd))
                continue;
            var name = cd.Name.Value?.Trim('"');

            if (!cd.IsFileDisposition())
            {
                using var sr = new StreamReader(section.Body);
                var value = (await sr.ReadToEndAsync(ct)).Trim();
                switch (name)
                {
                    case "folderId":
                        if (!Guid.TryParse(value, out var g)) return Error(400, "folderId is not a valid id.");
                        folderId = g;
                        break;
                    case "scope":
                        scope = value;
                        break;
                    case "sizeBytes":
                        if (!long.TryParse(value, out var s) || s < 0) return Error(400, "sizeBytes must be a non-negative number.");
                        declared = s;
                        break;
                }
                continue;
            }

            // The file part. Everything it needs must already have arrived.
            if (declared is not long declaredBytes)
                return Error(400, "Send sizeBytes before the file part, so the quota check can run before the bytes.");

            var (gateError, _) = await gate(folderId, scope, declaredBytes, ct);
            if (gateError is not null) return gateError;

            var maxBytes = MaxFileBytes(config);
            var fileName = Path.GetFileName(
                HeaderUtilities.RemoveQuotes(cd.FileName).Value ?? "");
            if (string.IsNullOrWhiteSpace(fileName)) fileName = "Untitled";
            if (fileName.Length > 500) fileName = fileName[..500];

            var blobKey = blobs.NewKey(tenant.TenantId);
            long written;
            try
            {
                written = await blobs.WriteAsync(blobKey, section.Body, maxBytes, ct);
            }
            catch (BlobTooLargeException)
            {
                return Error(413, $"Files are limited to {maxBytes / (1024 * 1024)} MB each.", "file_too_large");
            }

            var contentType = string.IsNullOrWhiteSpace(section.ContentType)
                ? "application/octet-stream" : section.ContentType;

            return await complete(new UploadedPart(fileName, contentType, blobKey, written), folderId, scope, ct);
        }

        return Error(400, "The request contained no file part.");
    }

    // ==================================================================
    //  POST /api/space/files — upload
    // ==================================================================

    private static async Task<IResult> UploadAsync(
        HttpRequest request, AppDbContext db, TenantContext tenant,
        StorageAllocator allocator, IBlobStore blobs, IConfiguration config,
        CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        // Always overwritten by the gate before complete runs; initialised
        // non-null so the null-state analysis can see that too.
        (string OwnershipType, Guid? OwnerUserId, Guid? FolderId) dest = ("personal", null, null);

        return await ReadUploadAsync(request, db, tenant, allocator, blobs, config, uid,
            gate: async (folderId, scope, declared, token) =>
            {
                var (err, fid, ownership, owner) = await ResolveDestinationAsync(db, uid, folderId, scope, token);
                if (err is not null) return (err, 0);
                dest = (ownership, owner, fid);

                var quotaErr = await CheckQuotaAsync(db, allocator, tenant.TenantId,
                    dest.OwnershipType, dest.OwnerUserId, uid,
                    declared, declared, MaxFileBytes(config), token);
                return (quotaErr, declared);
            },
            complete: async (part, _, _, token) =>
            {
                var file = new SpaceFile
                {
                    TenantId = tenant.TenantId,
                    FolderId = dest.FolderId,
                    CreatedByUserId = uid,
                    OwnershipType = dest.OwnershipType,
                    OwnerUserId = dest.OwnerUserId,
                    Name = part.FileName,
                    MimeType = part.ContentType,
                    BlobKey = part.BlobKey,
                    SizeBytes = part.Written,
                };
                db.SpaceFiles.Add(file);
                await db.SaveChangesAsync(token);
                await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, file.Id, "created", token);

                // True up the derived figure with what ACTUALLY landed — the
                // declared size was a claim. Cheap: one GROUP BY, one tenant.
                await allocator.ReconcileUsageAsync(tenant.TenantId, token);

                var perm = file.OwnerUserId == uid ? "owner" : "edit";
                return Results.Created($"/api/space/files/{file.Id}",
                    await SpaceDriveEndpoints.DecorateFileAsync(db, uid, FileDto(file, perm, false), token));
            },
            ct);
    }

    // ==================================================================
    //  PUT /api/space/files/{id}/content — overwrite
    // ==================================================================

    private static async Task<IResult> OverwriteAsync(
        Guid id, HttpRequest request, AppDbContext db, TenantContext tenant,
        StorageAllocator allocator, IBlobStore blobs, IConfiguration config,
        CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is not null) return Error(409, "This file is in the trash. Restore it first.");
        if (Rank(await FilePermAsync(db, file, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to replace this file's content.");

        var oldKey = file.BlobKey;
        var oldSize = file.SizeBytes;

        return await ReadUploadAsync(request, db, tenant, allocator, blobs, config, uid,
            gate: async (_, _, declared, token) =>
            {
                // Quota on the DELTA — replacing 1 GB with 1 GB costs nothing.
                var quotaErr = await CheckQuotaAsync(db, allocator, tenant.TenantId,
                    file.OwnershipType, file.OwnerUserId, uid,
                    declared - oldSize, declared, MaxFileBytes(config), token);
                return (quotaErr, declared - oldSize);
            },
            complete: async (part, _, _, token) =>
            {
                // New blob, repoint, THEN drop the old bytes — never overwrite
                // in place. Same cost while there is one version; it means
                // history is recoverable when the versions table arrives.
                file.BlobKey = part.BlobKey;
                file.SizeBytes = part.Written;
                file.MimeType = part.ContentType;
                file.UpdatedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(token);
                await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, file.Id, "modified", token);

                try { await blobs.DeleteAsync(oldKey); }
                catch { /* an orphaned blob costs bytes, not correctness */ }

                await allocator.ReconcileUsageAsync(tenant.TenantId, token);
                return Results.Ok(await SpaceDriveEndpoints.DecorateFileAsync(db, uid,
                    FileDto(file, await FilePermAsync(db, file, uid, token),
                        await db.SpaceShares.AnyAsync(s => s.FileId == file.Id, token)), token));
            },
            ct);
    }

    // ==================================================================
    //  GET /api/space/files/{id}/content — download
    // ==================================================================

    private static async Task<IResult> DownloadAsync(
        Guid id, AppDbContext db, TenantContext tenant, IBlobStore blobs, CancellationToken ct)
    {
        if (!TryCaller(tenant, out _)) return Results.Unauthorized();

        // Trashed files download too — restore-by-download-first is a real
        // workflow, and view level is all a download needs.
        var file = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");

        var stream = blobs.OpenRead(file.BlobKey);
        if (stream is null) return Error(404, "This file's content is missing from storage.");

        // Genuine user download -> Recent. Machine reads (the gateway,
        // thumbnails) do not come through this handler, by design.
        await SpaceDriveEndpoints.RecordActivityAsync(db, tenant, file.Id, "opened", ct);

        return Results.File(stream, file.MimeType, file.Name, enableRangeProcessing: true);
    }

    // ==================================================================
    //  PATCH /api/space/files/{id} — rename / move
    // ==================================================================

    private static async Task<IResult> PatchFileAsync(
        Guid id, PatchRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is not null) return Error(409, "This file is in the trash. Restore it first.");
        if (Rank(await FilePermAsync(db, file, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to change this file.");

        if (req.Name is not null)
        {
            var name = req.Name.Trim();
            if (name.Length == 0) return Error(400, "The name cannot be empty.");
            if (name.Length > 500) return Error(400, "The name is limited to 500 characters.");
            file.Name = name;
        }

        var moveToFolder = req.FolderId is not null;
        var moveToRoot = req.FolderId is null && req.Scope is not null;
        if (moveToFolder || moveToRoot)
        {
            var (err, fid, _, _) = await ResolveDestinationAsync(db, uid, req.FolderId, req.Scope, ct);
            if (err is not null) return err;
            // Moving does NOT change ownership — that is PUT /ownership, an
            // explicit act, never a side effect of dragging.
            file.FolderId = fid;
        }

        file.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok(await SpaceDriveEndpoints.DecorateFileAsync(db, uid,
            FileDto(file, await FilePermAsync(db, file, uid, ct),
                await db.SpaceShares.AnyAsync(s => s.FileId == file.Id, ct)), ct));
    }

    // ==================================================================
    //  PUT /api/space/files/{id}/ownership — personal ↔ organisational
    // ==================================================================

    private static async Task<IResult> FileOwnershipAsync(
        Guid id, OwnershipRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();
        if (req.OwnershipType is not ("personal" or "organisational"))
            return Error(400, "ownershipType must be personal or organisational.");

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is not null) return Error(409, "This file is in the trash. Restore it first.");

        var isOrgAdmin = await db.Users.AsNoTracking()
            .Where(u => u.Id == uid)
            .Select(u => u.Role == "org_owner" || u.Role == "org_admin" || u.Role == "super_admin")
            .FirstOrDefaultAsync(ct);

        if (file.OwnershipType == "personal")
        {
            // Handing to the org: the owner's call — or an org admin's, for
            // RECLAIMING a retained owner-less file after its owner left.
            var allowed = file.OwnerUserId == uid || (file.OwnerUserId is null && isOrgAdmin);
            if (!allowed) return Error(403, "Only the owner can change who this file belongs to.");
        }
        else
        {
            // Taking an org file personal: edit level required, and the
            // caller becomes the owner.
            if (Rank(await FilePermAsync(db, file, uid, ct)) < Rank("edit"))
                return Error(403, "You need edit access to take ownership of this file.");
        }

        if (req.OwnershipType == "organisational")
        {
            file.OwnershipType = "organisational";
            file.OwnerUserId = null;
        }
        else
        {
            file.OwnershipType = "personal";
            file.OwnerUserId = uid;
        }
        file.UpdatedAt = DateTimeOffset.UtcNow;

        // Existing share rows SURVIVE, in both directions — deleting them
        // silently is how access disappears on the flip back and nobody can
        // say why. Removing one is an explicit DELETE by a human.
        await db.SaveChangesAsync(ct);
        return Results.Ok(await SpaceDriveEndpoints.DecorateFileAsync(db, uid,
            FileDto(file, await FilePermAsync(db, file, uid, ct),
                await db.SpaceShares.AnyAsync(s => s.FileId == file.Id, ct)), ct));
    }

    // ==================================================================
    //  File trash lifecycle
    // ==================================================================

    private static async Task<IResult> TrashFileAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is not null) return Error(409, "This file is already in the trash.");
        if (Rank(await FilePermAsync(db, file, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to delete this file.");

        file.DeletedAt = DateTimeOffset.UtcNow;
        file.DeletedByUserId = uid;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RestoreFileAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is null) return Error(409, "This file is not in the trash.");

        // If the folder it lived in is itself trashed or gone, land at the
        // nearest live ancestor — or the root, rather than restoring a file
        // into a place nobody can open.
        if (file.FolderId is Guid fid)
        {
            var chain = await ChainAsync(db, fid, ct);
            var live = chain.FirstOrDefault(c => c.DeletedAt is null);
            file.FolderId = live?.Id;
        }

        file.DeletedAt = null;
        file.DeletedByUserId = null;
        file.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok(await SpaceDriveEndpoints.DecorateFileAsync(db, uid,
            FileDto(file, await FilePermAsync(db, file, uid, ct),
                await db.SpaceShares.AnyAsync(s => s.FileId == file.Id, ct)), ct));
    }

    private static async Task<IResult> PurgeFileAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        IBlobStore blobs, StorageAllocator allocator, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var file = await db.SpaceFiles.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (file is null) return Error(404, "No such file.");
        if (file.DeletedAt is null) return Error(409, "Only files already in the trash can be permanently deleted.");
        if (Rank(await FilePermAsync(db, file, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to permanently delete this file.");

        // Blob FIRST, row second. The other order leaks bytes forever: a row
        // that is gone can never tell anyone its blob still exists.
        await blobs.DeleteAsync(file.BlobKey);
        db.SpaceFiles.Remove(file);
        await db.SaveChangesAsync(ct);

        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);
        return Results.NoContent();
    }

    // ==================================================================
    //  POST /api/space/folders
    // ==================================================================

    private static async Task<IResult> CreateFolderAsync(
        CreateFolderRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return Error(400, "Folder name is required.");
        if (name.Length > 300) return Error(400, "Folder name is limited to 300 characters.");

        if (req.ParentFolderId is Guid pid)
        {
            var chain = await ChainAsync(db, pid, ct);
            if (chain.Count >= 32)
                return Error(400, "Folders cannot be nested more than 32 levels deep.");
        }

        var (err, fid, ownershipType, ownerUserId) =
            await ResolveDestinationAsync(db, uid, req.ParentFolderId, req.Scope, ct);
        if (err is not null) return err;

        var folder = new SpaceFolder
        {
            TenantId = tenant.TenantId,
            ParentFolderId = fid,
            CreatedByUserId = uid,
            OwnershipType = ownershipType,
            OwnerUserId = ownerUserId,
            Name = name,
        };
        db.SpaceFolders.Add(folder);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/space/folders/{folder.Id}",
            await SpaceDriveEndpoints.DecorateFolderAsync(db, uid, new SpaceFolderDto(
                folder.Id, folder.Name, folder.ParentFolderId,
                folder.OwnershipType, folder.OwnerUserId, folder.CreatedByUserId,
                folder.OwnerUserId == uid ? "owner" : "edit", false,
                folder.DeletedAt, folder.CreatedAt, folder.UpdatedAt, 0, 0), ct));
    }

    // ==================================================================
    //  PATCH /api/space/folders/{id} — rename / move
    // ==================================================================

    private static async Task<IResult> PatchFolderAsync(
        Guid id, PatchRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var folder = await db.SpaceFolders.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (folder is null) return Error(404, "No such folder.");
        if (folder.DeletedAt is not null) return Error(409, "This folder is in the trash. Restore it first.");
        if (Rank(await FolderPermAsync(db, id, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to change this folder.");

        if (req.Name is not null)
        {
            var name = req.Name.Trim();
            if (name.Length == 0) return Error(400, "The name cannot be empty.");
            if (name.Length > 300) return Error(400, "The name is limited to 300 characters.");
            folder.Name = name;
        }

        var destFolderId = req.ParentFolderId ?? req.FolderId; // accept either key
        var moveToFolder = destFolderId is not null;
        var moveToRoot = destFolderId is null && req.Scope is not null;

        if (moveToFolder || moveToRoot)
        {
            var (err, destId, _, _) = await ResolveDestinationAsync(db, uid, destFolderId, req.Scope, ct);
            if (err is not null) return err;

            if (destId is Guid target)
            {
                if (target == id)
                    return Error(409, "A folder cannot be moved inside itself.");

                // THE cycle guard. A move that makes a folder its own
                // ancestor hangs every recursive query afterwards — checked
                // on every move, no exceptions.
                var destChain = await ChainAsync(db, target, ct);
                if (destChain.Any(c => c.Id == id))
                    return Error(409, "A folder cannot be moved into one of its own subfolders.");

                // Depth: the destination's depth plus this subtree's height
                // must stay inside 32.
                var height = await db.Database.SqlQuery<int>($"""
                    WITH RECURSIVE sub AS (
                        SELECT id, 1 AS d FROM space.folders WHERE id = {id}
                        UNION ALL
                        SELECT f.id, s.d + 1 FROM space.folders f
                          JOIN sub s ON f.parent_folder_id = s.id
                         WHERE s.d < 33
                    )
                    SELECT COALESCE(MAX(d), 1)::int AS "Value" FROM sub
                    """).FirstOrDefaultAsync(ct);
                if (destChain.Count + height > 32)
                    return Error(409, "That move would nest folders more than 32 levels deep.");
            }

            folder.ParentFolderId = destId;
        }

        folder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(await SpaceDriveEndpoints.DecorateFolderAsync(db, uid, new SpaceFolderDto(
            folder.Id, folder.Name, folder.ParentFolderId,
            folder.OwnershipType, folder.OwnerUserId, folder.CreatedByUserId,
            await FolderPermAsync(db, id, uid, ct),
            await db.SpaceShares.AnyAsync(s => s.FolderId == id, ct),
            folder.DeletedAt, folder.CreatedAt, folder.UpdatedAt, 0, 0), ct));
    }

    // ==================================================================
    //  Folder trash lifecycle
    // ==================================================================

    private static async Task<IResult> TrashFolderAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var folder = await db.SpaceFolders.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (folder is null) return Error(404, "No such folder.");
        if (folder.DeletedAt is not null) return Error(409, "This folder is already in the trash.");
        if (Rank(await FolderPermAsync(db, id, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to delete this folder.");

        // Stamp THIS row only. Contents carry no stamp and follow their
        // ancestor; restore is one un-stamp.
        folder.DeletedAt = DateTimeOffset.UtcNow;
        folder.DeletedByUserId = uid;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RestoreFolderAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var folder = await db.SpaceFolders.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (folder is null) return Error(404, "No such folder.");
        if (folder.DeletedAt is null) return Error(409, "This folder is not in the trash.");

        // Same nearest-live-ancestor rule as files.
        if (folder.ParentFolderId is Guid pid)
        {
            var chain = await ChainAsync(db, pid, ct);
            var live = chain.FirstOrDefault(c => c.DeletedAt is null);
            folder.ParentFolderId = live?.Id;
        }

        folder.DeletedAt = null;
        folder.DeletedByUserId = null;
        folder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(await SpaceDriveEndpoints.DecorateFolderAsync(db, uid, new SpaceFolderDto(
            folder.Id, folder.Name, folder.ParentFolderId,
            folder.OwnershipType, folder.OwnerUserId, folder.CreatedByUserId,
            await FolderPermAsync(db, id, uid, ct),
            await db.SpaceShares.AnyAsync(s => s.FolderId == id, ct),
            folder.DeletedAt, folder.CreatedAt, folder.UpdatedAt, 0, 0), ct));
    }

    private static async Task<IResult> PurgeFolderAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        IBlobStore blobs, StorageAllocator allocator, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var folder = await db.SpaceFolders.FirstOrDefaultAsync(f => f.Id == id, ct);
        if (folder is null) return Error(404, "No such folder.");
        if (folder.DeletedAt is null) return Error(409, "Only folders already in the trash can be permanently deleted.");
        if (Rank(await FolderPermAsync(db, id, uid, ct)) < Rank("edit"))
            return Error(403, "You need edit access to permanently delete this folder.");

        // The whole subtree goes. Blobs FIRST, then the one row — the
        // database cascades the rest. The other order leaks every byte.
        var subIds = await db.Database.SqlQuery<Guid>($"""
            WITH RECURSIVE sub AS (
                SELECT id FROM space.folders WHERE id = {id}
                UNION ALL
                SELECT f.id FROM space.folders f JOIN sub s ON f.parent_folder_id = s.id
            )
            SELECT id AS "Value" FROM sub
            """).ToListAsync(ct);

        var blobKeys = await db.SpaceFiles
            .Where(f => f.FolderId != null && subIds.Contains(f.FolderId.Value))
            .Select(f => f.BlobKey)
            .ToListAsync(ct);
        foreach (var key in blobKeys)
            await blobs.DeleteAsync(key);

        db.SpaceFolders.Remove(folder);
        await db.SaveChangesAsync(ct);

        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);
        return Results.NoContent();
    }

    // ==================================================================
    //  Shares — one implementation, two routes (file / folder)
    // ==================================================================

    /// <summary>
    /// The level needed to READ or CHANGE an item's share list: owner on
    /// personal items, edit on organisational. view/comment callers get a
    /// 403 — who else can see a thing is not theirs to know.
    /// </summary>
    internal static async Task<(IResult? Error, string Ownership, Guid? Owner)>
        ShareGateAsync(Guid id, bool isFile, AppDbContext db, Guid uid, CancellationToken ct)
    {
        string ownership;
        Guid? owner;
        string perm;

        if (isFile)
        {
            var f = await db.SpaceFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
            if (f is null) return (Error(404, "No such file."), "", null);
            ownership = f.OwnershipType; owner = f.OwnerUserId;
            perm = await FilePermAsync(db, f, uid, ct);
        }
        else
        {
            var f = await db.SpaceFolders.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
            if (f is null) return (Error(404, "No such folder."), "", null);
            ownership = f.OwnershipType; owner = f.OwnerUserId;
            perm = await FolderPermAsync(db, id, uid, ct);
        }

        var required = ownership == "personal" ? "owner" : "edit";
        if (Rank(perm) < Rank(required))
            return (Error(403, "You do not have access to manage sharing for this item."), "", null);

        return (null, ownership, owner);
    }

    private static async Task<IResult> ListSharesAsync(
        Guid id, bool isFile, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var (err, _, _) = await ShareGateAsync(id, isFile, db, uid, ct);
        if (err is not null) return err;

        var shares = await db.SpaceShares.AsNoTracking()
            .Where(s => isFile ? s.FileId == id : s.FolderId == id)
            .OrderBy(s => s.CreatedAt)
            .ToListAsync(ct);

        var userIds = shares.Where(s => s.SharedWithUserId != null)
            .Select(s => s.SharedWithUserId!.Value).Distinct().ToList();
        var names = userIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return Results.Ok(new
        {
            shares = shares.Select(s => new ShareDto(
                s.Id, s.SharedWithUserId,
                s.SharedWithUserId is Guid g ? names.GetValueOrDefault(g) : null,
                s.OrgWide, s.Permission, s.SharedByUserId, s.CreatedAt)).ToList()
        });
    }

    private static async Task<IResult> PutShareAsync(
        Guid id, bool isFile, ShareRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var named = req.UserId is not null;
        if (named == req.OrgWide)
            return Error(400, "Share with either a person or the whole organisation, not both or neither.");
        if (req.Permission is not ("view" or "comment" or "edit"))
            return Error(400, "permission must be view, comment or edit.");

        var (err, _, owner) = await ShareGateAsync(id, isFile, db, uid, ct);
        if (err is not null) return err;

        if (req.UserId is Guid target)
        {
            // The tenant filter makes a cross-tenant user indistinguishable
            // from a nonexistent one, which is exactly right.
            var exists = await db.Users.AsNoTracking().AnyAsync(u => u.Id == target, ct);
            if (!exists) return Error(404, "No such user.");
            if (target == owner) return Error(400, "That person already owns this item.");
        }

        var share = await db.SpaceShares.FirstOrDefaultAsync(s =>
            (isFile ? s.FileId == id : s.FolderId == id)
            && (req.OrgWide ? s.OrgWide : s.SharedWithUserId == req.UserId), ct);

        if (share is null)
        {
            share = new SpaceShare
            {
                TenantId = tenant.TenantId,
                FileId = isFile ? id : null,
                FolderId = isFile ? null : id,
                SharedByUserId = uid,
                SharedWithUserId = req.UserId,
                OrgWide = req.OrgWide,
                Permission = req.Permission,
            };
            db.SpaceShares.Add(share);
        }
        else
        {
            // Upsert: one grant per (object, audience) — matches the unique
            // indexes, and re-sharing updates the level instead of stacking.
            share.Permission = req.Permission;
            share.SharedByUserId = uid;
        }
        await db.SaveChangesAsync(ct);

        string? displayName = null;
        if (share.SharedWithUserId is Guid g2)
            displayName = await db.Users.AsNoTracking()
                .Where(u => u.Id == g2).Select(u => u.DisplayName).FirstOrDefaultAsync(ct);

        return Results.Ok(new ShareDto(
            share.Id, share.SharedWithUserId, displayName,
            share.OrgWide, share.Permission, share.SharedByUserId, share.CreatedAt));
    }

    private static async Task<IResult> DeleteShareAsync(
        Guid id, Guid shareId, bool isFile, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var (err, _, _) = await ShareGateAsync(id, isFile, db, uid, ct);
        if (err is not null) return err;

        var share = await db.SpaceShares.FirstOrDefaultAsync(s =>
            s.Id == shareId && (isFile ? s.FileId == id : s.FolderId == id), ct);
        if (share is null) return Error(404, "No such share.");

        db.SpaceShares.Remove(share);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
