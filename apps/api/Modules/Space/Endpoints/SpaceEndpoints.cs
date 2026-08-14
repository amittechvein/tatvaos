using Microsoft.EntityFrameworkCore;
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
///  anyone in the tenant on organisational items. Computed BATCHED per page —
///  one chain walk for the folder plus one share query for the page's rows —
///  never a recursive query per row. That is a contract commitment.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SpaceEndpoints
{
    public static void MapSpaceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/space")
            .RequireAuthorization("User")
            .WithTags("Space");

        g.MapGet("/list", ListAsync);
        g.MapPost("/folders", CreateFolderAsync);
    }

    // ------------------------------------------------------------------
    //  DTOs — property names are the contract's JSON fields.
    // ------------------------------------------------------------------

    public sealed record BreadcrumbDto(Guid? Id, string Name);

    public sealed record SpaceFolderDto(
        Guid Id, string Name, Guid? ParentFolderId,
        string OwnershipType, Guid? OwnerUserId, Guid? CreatedByUserId,
        string MyPermission, bool IsShared,
        DateTimeOffset? DeletedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        int ChildFolderCount, int FileCount);

    public sealed record SpaceFileDto(
        Guid Id, string Name, string MimeType, long SizeBytes, Guid? FolderId,
        string OwnershipType, Guid? OwnerUserId, Guid? CreatedByUserId,
        string MyPermission, bool IsShared,
        DateTimeOffset? DeletedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

    public sealed record CreateFolderRequest(string? Name, Guid? ParentFolderId, string? Scope);

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
        public int Depth { get; set; }
    }

    private static Task<List<ChainRow>> ChainAsync(AppDbContext db, Guid folderId, CancellationToken ct)
        => db.Database.SqlQuery<ChainRow>($"""
            WITH RECURSIVE chain AS (
                SELECT f.id, f.parent_folder_id, f.name, f.ownership_type, f.owner_user_id,
                       1 AS depth
                  FROM space.folders f
                 WHERE f.id = {folderId}
                UNION ALL
                SELECT f.id, f.parent_folder_id, f.name, f.ownership_type, f.owner_user_id,
                       c.depth + 1
                  FROM space.folders f
                  JOIN chain c ON f.id = c.parent_folder_id
                 WHERE c.depth < 32
            )
            SELECT id                AS "Id",
                   parent_folder_id  AS "ParentFolderId",
                   name              AS "Name",
                   ownership_type    AS "OwnershipType",
                   owner_user_id     AS "OwnerUserId",
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
    /// The caller's effective level for a folder, from its already-loaded
    /// chain plus the grants found on any node of it. "view" fallback is for
    /// the row RLS admitted through a grant this query context cannot see —
    /// fail LOW, never open.
    /// </summary>
    private static string ChainPermission(List<ChainRow> chain, IReadOnlyCollection<string> chainGrants, Guid uid)
    {
        if (chain.Any(c => c.OwnerUserId == uid)) return "owner";

        var p = chain.Any(c => c.OwnershipType == "organisational") ? "edit" : "";
        foreach (var grant in chainGrants)
            p = p.Length == 0 ? grant : MaxPerm(p, grant);

        return p.Length == 0 ? "view" : p;
    }

    // ==================================================================
    //  GET /api/space/list
    // ==================================================================

    private static async Task<IResult> ListAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        Guid? folderId = null, string? scope = null,
        int page = 1, int pageSize = 200)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        // Exactly one of folderId / scope — a root is not a row.
        var scopeGiven = !string.IsNullOrEmpty(scope);
        if (folderId is null == !scopeGiven)
            return Results.BadRequest(new { error = "Provide either folderId or scope, not both or neither." });
        if (scopeGiven && scope is not ("personal" or "organisational"))
            return Results.BadRequest(new { error = "scope must be personal or organisational." });

        if (page < 1) page = 1;
        pageSize = Math.Clamp(pageSize, 1, 500);

        List<ChainRow> chain = [];
        SpaceFolderDto? current = null;
        string basePerm;
        var breadcrumb = new List<BreadcrumbDto>();

        if (folderId is Guid fid)
        {
            chain = await ChainAsync(db, fid, ct);
            // RLS filtered it out, or it does not exist, or it is trashed —
            // all the same answer, deliberately.
            if (chain.Count == 0)
                return Results.NotFound(new { error = "No such folder." });

            var self = chain[0];
            var live = await db.SpaceFolders.AnyAsync(f => f.Id == fid && f.DeletedAt == null, ct);
            if (!live)
                return Results.NotFound(new { error = "No such folder." });

            // Grants anywhere on the chain, one query.
            var chainIds = chain.Select(c => c.Id).ToList();
            var chainGrants = await db.SpaceShares
                .Where(s => s.FolderId != null && chainIds.Contains(s.FolderId.Value)
                            && (s.OrgWide || s.SharedWithUserId == uid))
                .Select(s => s.Permission)
                .ToListAsync(ct);

            basePerm = ChainPermission(chain, chainGrants, uid);

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

        var subFolderCounts = childIds.Count == 0 ? [] :
            await db.SpaceFolders
                .Where(f => f.ParentFolderId != null && childIds.Contains(f.ParentFolderId.Value)
                            && f.DeletedAt == null)
                .GroupBy(f => f.ParentFolderId!.Value)
                .Select(gr => new { gr.Key, N = gr.Count() })
                .ToListAsync(ct);
        var subFileCounts = childIds.Count == 0 ? [] :
            await db.SpaceFiles
                .Where(f => f.FolderId != null && childIds.Contains(f.FolderId.Value)
                            && f.DeletedAt == null)
                .GroupBy(f => f.FolderId!.Value)
                .Select(gr => new { gr.Key, N = gr.Count() })
                .ToListAsync(ct);
        var folderCountByParent = subFolderCounts.ToDictionary(x => x.Key, x => x.N);
        var fileCountByParent = subFileCounts.ToDictionary(x => x.Key, x => x.N);

        // Share rows for everything on the page, one query. Feeds BOTH
        // IsShared and the caller's per-row grant fold. Rows are already
        // RLS-scoped to what this caller may know about.
        var pageShares = (childIds.Count == 0 && fileIds.Count == 0) ? [] :
            await db.SpaceShares.AsNoTracking()
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
            var p = ownership == "organisational" ? MaxPerm("edit", basePerm == "owner" ? "edit" : basePerm) : basePerm;
            if (p == "owner") p = "edit"; // owning the FOLDER does not make you owner of a colleague's shared item
            foreach (var grant in grants) p = MaxPerm(p, grant);
            return p;
        }
        // Owning the parent chain DOES make your own items yours:
        // owner==uid short-circuits above before basePerm is consulted.

        var folderDtos = childFolders.Select(f => new SpaceFolderDto(
            f.Id, f.Name, f.ParentFolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            PermOf(f.OwnershipType, f.OwnerUserId, folderGrants[f.Id]),
            folderShared.Contains(f.Id),
            f.DeletedAt, f.CreatedAt, f.UpdatedAt,
            folderCountByParent.GetValueOrDefault(f.Id),
            fileCountByParent.GetValueOrDefault(f.Id))).ToList();

        var fileDtos = files.Select(f => new SpaceFileDto(
            f.Id, f.Name, f.MimeType, f.SizeBytes, f.FolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            PermOf(f.OwnershipType, f.OwnerUserId, fileGrants[f.Id]),
            fileShared.Contains(f.Id),
            f.DeletedAt, f.CreatedAt, f.UpdatedAt)).ToList();

        if (folderId is Guid cfid)
        {
            var selfRow = await db.SpaceFolders.AsNoTracking().FirstAsync(f => f.Id == cfid, ct);
            current = new SpaceFolderDto(
                selfRow.Id, selfRow.Name, selfRow.ParentFolderId,
                selfRow.OwnershipType, selfRow.OwnerUserId, selfRow.CreatedByUserId,
                basePerm, folderShared.Contains(selfRow.Id) ||
                          await db.SpaceShares.AnyAsync(s => s.FolderId == cfid, ct),
                selfRow.DeletedAt, selfRow.CreatedAt, selfRow.UpdatedAt,
                folderDtos.Count, totalFiles);
        }

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
    //  POST /api/space/folders
    // ==================================================================

    private static async Task<IResult> CreateFolderAsync(
        CreateFolderRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name))
            return Results.BadRequest(new { error = "Folder name is required." });
        if (name.Length > 300)
            return Results.BadRequest(new { error = "Folder name is limited to 300 characters." });

        string ownershipType;
        Guid? ownerUserId;

        if (req.ParentFolderId is Guid pid)
        {
            var parent = await db.SpaceFolders.AsNoTracking()
                .FirstOrDefaultAsync(f => f.Id == pid && f.DeletedAt == null, ct);
            if (parent is null)
                return Results.NotFound(new { error = "No such folder." });

            var chain = await ChainAsync(db, pid, ct);
            if (chain.Count >= 32)
                return Results.BadRequest(new { error = "Folders cannot be nested more than 32 levels deep." });

            var chainIds = chain.Select(c => c.Id).ToList();
            var chainGrants = await db.SpaceShares
                .Where(s => s.FolderId != null && chainIds.Contains(s.FolderId.Value)
                            && (s.OrgWide || s.SharedWithUserId == uid))
                .Select(s => s.Permission)
                .ToListAsync(ct);

            if (Rank(ChainPermission(chain, chainGrants, uid)) < Rank("edit"))
                return Results.StatusCode(StatusCodes.Status403Forbidden);

            // Contents take the ownership of the folder they are created in —
            // a folder made inside a colleague's shared personal tree belongs
            // to that colleague, exactly as in Drive.
            ownershipType = parent.OwnershipType;
            ownerUserId = parent.OwnerUserId;
        }
        else
        {
            if (req.Scope is not ("personal" or "organisational"))
                return Results.BadRequest(new { error = "scope must be personal or organisational when creating in a root." });
            ownershipType = req.Scope;
            ownerUserId = req.Scope == "personal" ? uid : null;
        }

        var folder = new SpaceFolder
        {
            TenantId = tenant.TenantId,
            ParentFolderId = req.ParentFolderId,
            CreatedByUserId = uid,
            OwnershipType = ownershipType,
            OwnerUserId = ownerUserId,
            Name = name,
        };
        db.SpaceFolders.Add(folder);
        await db.SaveChangesAsync(ct);

        var myPermission = ownerUserId == uid ? "owner" : "edit";
        return Results.Created($"/api/space/folders/{folder.Id}", new SpaceFolderDto(
            folder.Id, folder.Name, folder.ParentFolderId,
            folder.OwnershipType, folder.OwnerUserId, folder.CreatedByUserId,
            myPermission, false,
            folder.DeletedAt, folder.CreatedAt, folder.UpdatedAt,
            0, 0));
    }
}
