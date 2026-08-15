using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Space.Endpoints;

/// <summary>
/// The Drive-view surface: Recent/Home, Starred, and the sharing directory.
/// Contract: docs/SPACE_API_DRIVE_ADDENDUM.md (approved v1.2). Schema:
/// 29-space-drive.sql — space.file_activity and space.stars, both strictly
/// per-user (RLS: tenant AND me), which is why the queries here carry no
/// explicit user filter: a query CANNOT see anyone else's rows.
///
/// Also home to the batched decoration (isStarred / ownerDisplayName /
/// parentName) that SpaceEndpoints' listings call — one query per concern
/// per page, never a walk per row, per the standing contract commitment.
/// </summary>
public static class SpaceDriveEndpoints
{
    public static void MapSpaceDriveEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/space")
            .RequireAuthorization("User")
            .WithTags("Space");

        g.MapGet("/recent", RecentAsync);
        g.MapGet("/starred", StarredAsync);
        g.MapGet("/directory", DirectoryAsync);

        g.MapPut("/files/{id:guid}/star", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => StarAsync(id, isFile: true, star: true, db, t, ct));
        g.MapDelete("/files/{id:guid}/star", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => StarAsync(id, isFile: true, star: false, db, t, ct));
        g.MapPut("/folders/{id:guid}/star", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => StarAsync(id, isFile: false, star: true, db, t, ct));
        g.MapDelete("/folders/{id:guid}/star", (Guid id, AppDbContext db, TenantContext t, CancellationToken ct) => StarAsync(id, isFile: false, star: false, db, t, ct));
    }

    private static IResult Error(int status, string message) =>
        Results.Json(new { error = message }, statusCode: status);

    private static int Rank(string p) => p switch
    {
        "owner" => 3, "edit" => 2, "comment" => 1, "view" => 0, _ => -1
    };
    private static string MaxPerm(string a, string b) => Rank(a) >= Rank(b) ? a : b;

    // ==================================================================
    //  Activity — written by SpaceEndpoints' download/upload/overwrite.
    // ==================================================================

    /// <summary>
    /// Upsert the caller's latest touch on a file. GENUINE USER PATHS ONLY:
    /// the SpaceContentGateway (attach-from-Space) and thumbnail generation
    /// must never call this — a Mail composer walking my files would fill
    /// Recent with files I never looked at.
    ///
    /// Failure-isolated by design: not recording recency must never fail the
    /// download/upload that caused it, so every exception is swallowed here
    /// and nowhere else.
    /// </summary>
    internal static async Task RecordActivityAsync(
        AppDbContext db, TenantContext tenant, Guid fileId, string action, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return;
        try
        {
            await db.Database.ExecuteSqlInterpolatedAsync($@"
                INSERT INTO space.file_activity (tenant_id, user_id, file_id, action, occurred_at)
                VALUES ({tenant.TenantId}, {uid}, {fileId}, {action}, now())
                ON CONFLICT (user_id, file_id) DO UPDATE
                    SET action = EXCLUDED.action, occurred_at = now()", ct);
        }
        catch
        {
            // Deliberately silent — see the summary.
        }
    }

    // ==================================================================
    //  GET /api/space/recent — powers Recent AND Home's suggestions
    // ==================================================================

    private static async Task<IResult> RecentAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        int page = 1, int pageSize = 50)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (page < 1) page = 1;
        pageSize = Math.Clamp(pageSize, 1, 200);

        // RLS + the per-user query filter scope activity to MY rows; the join
        // to files drops anything I can no longer see, and live-only drops
        // the trashed — a file leaves Recent the moment it leaves my reach.
        var q = from a in db.SpaceFileActivities
                join f in db.SpaceFiles on a.FileId equals f.Id
                where f.DeletedAt == null
                orderby a.OccurredAt descending
                select new { a.Action, a.OccurredAt, File = f };

        var total = await q.CountAsync(ct);
        var rows = await q.AsNoTracking()
            .Skip((page - 1) * pageSize).Take(pageSize)
            .ToListAsync(ct);

        var ids = rows.Select(r => r.File.Id).ToList();

        // Level approximated LOW from one batched query, same rule as
        // /search: results span folders, so per-row ancestor walks are
        // banned; RLS already guaranteed visibility.
        var shareRows = ids.Count == 0
            ? []
            : await db.SpaceShares.AsNoTracking()
                .Where(s => s.FileId != null && ids.Contains(s.FileId.Value))
                .ToListAsync(ct);
        var sharedSet = shareRows.Select(s => s.FileId!.Value).ToHashSet();
        var myGrants = shareRows
            .Where(s => s.OrgWide || s.SharedWithUserId == uid)
            .ToLookup(s => s.FileId!.Value, s => s.Permission);

        string PermOf(SpaceFile f)
        {
            if (f.OwnerUserId == uid) return "owner";
            var p = f.OwnershipType == "organisational" ? "edit" : "view";
            foreach (var grant in myGrants[f.Id]) p = MaxPerm(p, grant);
            return p;
        }

        var dtos = rows.Select(r => new SpaceEndpoints.SpaceFileDto(
            r.File.Id, r.File.Name, r.File.MimeType, r.File.SizeBytes, r.File.FolderId,
            r.File.OwnershipType, r.File.OwnerUserId, r.File.CreatedByUserId,
            PermOf(r.File), sharedSet.Contains(r.File.Id),
            r.File.DeletedAt, r.File.CreatedAt, r.File.UpdatedAt)
            with
            { Activity = new SpaceEndpoints.ActivityDto(r.Action, r.OccurredAt) }).ToList();

        var deco = await DecorateAsync(db, uid, [], dtos, withParentName: true, ct);

        return Results.Ok(new { files = deco.Files, page, pageSize, total });
    }

    // ==================================================================
    //  GET /api/space/starred
    // ==================================================================

    private static async Task<IResult> StarredAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        // My stars only (RLS); most recently starred first.
        var stars = await db.SpaceStars.AsNoTracking()
            .OrderByDescending(s => s.CreatedAt)
            .ToListAsync(ct);

        var fileIds = stars.Where(s => s.FileId != null).Select(s => s.FileId!.Value).ToList();
        var folderIds = stars.Where(s => s.FolderId != null).Select(s => s.FolderId!.Value).ToList();

        // Live targets only — a starred item in the trash keeps its star but
        // leaves this view until restored, like every listing.
        var files = fileIds.Count == 0 ? [] :
            await db.SpaceFiles.AsNoTracking()
                .Where(f => fileIds.Contains(f.Id) && f.DeletedAt == null)
                .ToListAsync(ct);
        var folders = folderIds.Count == 0 ? [] :
            await db.SpaceFolders.AsNoTracking()
                .Where(f => folderIds.Contains(f.Id) && f.DeletedAt == null)
                .ToListAsync(ct);

        // Preserve star order.
        var fileById = files.ToDictionary(f => f.Id);
        var folderById = folders.ToDictionary(f => f.Id);
        var orderedFiles = fileIds.Where(fileById.ContainsKey).Select(i => fileById[i]).ToList();
        var orderedFolders = folderIds.Where(folderById.ContainsKey).Select(i => folderById[i]).ToList();

        var shareRows = (fileIds.Count == 0 && folderIds.Count == 0)
            ? []
            : await db.SpaceShares.AsNoTracking()
                .Where(s => (s.FileId != null && fileIds.Contains(s.FileId.Value))
                         || (s.FolderId != null && folderIds.Contains(s.FolderId.Value)))
                .ToListAsync(ct);
        var sharedFiles = shareRows.Where(s => s.FileId != null).Select(s => s.FileId!.Value).ToHashSet();
        var sharedFolders = shareRows.Where(s => s.FolderId != null).Select(s => s.FolderId!.Value).ToHashSet();
        var myFileGrants = shareRows.Where(s => s.FileId != null && (s.OrgWide || s.SharedWithUserId == uid))
            .ToLookup(s => s.FileId!.Value, s => s.Permission);
        var myFolderGrants = shareRows.Where(s => s.FolderId != null && (s.OrgWide || s.SharedWithUserId == uid))
            .ToLookup(s => s.FolderId!.Value, s => s.Permission);

        string PermOf(string ownership, Guid? owner, IEnumerable<string> grants)
        {
            if (owner == uid) return "owner";
            var p = ownership == "organisational" ? "edit" : "view";
            foreach (var grant in grants) p = MaxPerm(p, grant);
            return p;
        }

        var folderDtos = orderedFolders.Select(f => new SpaceEndpoints.SpaceFolderDto(
            f.Id, f.Name, f.ParentFolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            PermOf(f.OwnershipType, f.OwnerUserId, myFolderGrants[f.Id]),
            sharedFolders.Contains(f.Id),
            f.DeletedAt, f.CreatedAt, f.UpdatedAt, 0, 0)).ToList();

        var fileDtos = orderedFiles.Select(f => new SpaceEndpoints.SpaceFileDto(
            f.Id, f.Name, f.MimeType, f.SizeBytes, f.FolderId,
            f.OwnershipType, f.OwnerUserId, f.CreatedByUserId,
            PermOf(f.OwnershipType, f.OwnerUserId, myFileGrants[f.Id]),
            sharedFiles.Contains(f.Id),
            f.DeletedAt, f.CreatedAt, f.UpdatedAt)).ToList();

        var deco = await DecorateAsync(db, uid, folderDtos, fileDtos, withParentName: true, ct);
        return Results.Ok(new { folders = deco.Folders, files = deco.Files });
    }

    // ==================================================================
    //  PUT / DELETE .../star — idempotent both ways
    // ==================================================================

    private static async Task<IResult> StarAsync(
        Guid id, bool isFile, bool star, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        // Invisible = 404, as everywhere. Loading through the DbSet keeps
        // RLS as the judge of "visible".
        var visible = isFile
            ? await db.SpaceFiles.AnyAsync(f => f.Id == id, ct)
            : await db.SpaceFolders.AnyAsync(f => f.Id == id, ct);
        if (!visible) return Error(404, isFile ? "No such file." : "No such folder.");

        if (star)
        {
            var exists = await db.SpaceStars.AnyAsync(
                s => isFile ? s.FileId == id : s.FolderId == id, ct);
            if (!exists)
            {
                db.SpaceStars.Add(new SpaceStar
                {
                    TenantId = tenant.TenantId,
                    UserId = uid,
                    FileId = isFile ? id : null,
                    FolderId = isFile ? null : id,
                });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException)
                {
                    // Raced a second tab starring the same item — the star
                    // exists, which is what the caller asked for. Idempotent.
                }
            }
        }
        else
        {
            var row = await db.SpaceStars.FirstOrDefaultAsync(
                s => isFile ? s.FileId == id : s.FolderId == id, ct);
            if (row is not null)
            {
                db.SpaceStars.Remove(row);
                await db.SaveChangesAsync(ct);
            }
        }

        return Results.NoContent();
    }

    // ==================================================================
    //  GET /api/space/directory — people picker for sharing
    // ==================================================================

    private static async Task<IResult> DirectoryAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct, string? q = null)
    {
        if (tenant.UserId is not Guid) return Results.Unauthorized();

        // Own tenant only — the query filter and RLS make anything else
        // impossible. PENDING people are deliberately included: an
        // admin-created person stays pending until first sign-in, and a
        // person with an address can be shared with (the same trap
        // EvaluateAcceptAsync documents). The caller is included too; the
        // UI can grey them out.
        var query = db.Users.AsNoTracking()
            .Where(u => u.Status == "active" || u.Status == "pending");

        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(u =>
                EF.Functions.ILike(u.DisplayName, term) || EF.Functions.ILike(u.Email, term));
        }

        // Cap 20, no paging — this is a picker, not a report.
        var people = await query
            .OrderBy(u => u.DisplayName)
            .Take(20)
            .Select(u => new { id = u.Id, displayName = u.DisplayName, email = u.Email })
            .ToListAsync(ct);

        return Results.Ok(new { people });
    }

    // ==================================================================
    //  Batched decoration — isStarred / ownerDisplayName / parentName
    // ==================================================================
    //
    //  Called by every listing in SpaceEndpoints and by the views above.
    //  One query per concern for the whole page. parentName only where the
    //  caller asked (the cross-folder views) — /list has the breadcrumb.
    //
    //  A containing folder invisible to the caller is simply ABSENT from the
    //  names dictionary — RLS filters it out of the query — so ParentName
    //  stays null rather than leaking a name the caller cannot see.
    // ==================================================================

    internal sealed record Decorated(
        List<SpaceEndpoints.SpaceFolderDto> Folders, List<SpaceEndpoints.SpaceFileDto> Files);

    internal static async Task<Decorated> DecorateAsync(
        AppDbContext db, Guid uid,
        List<SpaceEndpoints.SpaceFolderDto> folders, List<SpaceEndpoints.SpaceFileDto> files,
        bool withParentName, CancellationToken ct)
    {
        var fileIds = files.Select(f => f.Id).ToList();
        var folderIds = folders.Select(f => f.Id).ToList();

        // My stars among the page's ids. No user predicate needed — the
        // per-user RLS and query filter mean these queries CANNOT return
        // anyone else's stars.
        var starredFiles = fileIds.Count == 0
            ? []
            : (await db.SpaceStars
                .Where(s => s.FileId != null && fileIds.Contains(s.FileId.Value))
                .Select(s => s.FileId!.Value)
                .ToListAsync(ct)).ToHashSet();
        var starredFolders = folderIds.Count == 0
            ? []
            : (await db.SpaceStars
                .Where(s => s.FolderId != null && folderIds.Contains(s.FolderId.Value))
                .Select(s => s.FolderId!.Value)
                .ToListAsync(ct)).ToHashSet();

        var ownerIds = folders.Where(f => f.OwnerUserId != null).Select(f => f.OwnerUserId!.Value)
            .Concat(files.Where(f => f.OwnerUserId != null).Select(f => f.OwnerUserId!.Value))
            .Distinct().ToList();
        var ownerNames = ownerIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.Users.AsNoTracking()
                .Where(u => ownerIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var parentNames = new Dictionary<Guid, string>();
        if (withParentName)
        {
            var parentIds = folders.Where(f => f.ParentFolderId != null).Select(f => f.ParentFolderId!.Value)
                .Concat(files.Where(f => f.FolderId != null).Select(f => f.FolderId!.Value))
                .Distinct().ToList();
            if (parentIds.Count > 0)
                parentNames = await db.SpaceFolders.AsNoTracking()
                    .Where(f => parentIds.Contains(f.Id))
                    .ToDictionaryAsync(f => f.Id, f => f.Name, ct);
        }

        string? ParentOf(Guid? parentId, string ownership) =>
            !withParentName ? null
            : parentId is Guid p ? parentNames.GetValueOrDefault(p)
            : ownership == "organisational" ? "Organisation" : "My Space";

        return new Decorated(
            folders.Select(f => f with
            {
                IsStarred = starredFolders.Contains(f.Id),
                OwnerDisplayName = f.OwnerUserId is Guid o ? ownerNames.GetValueOrDefault(o) : null,
                ParentName = ParentOf(f.ParentFolderId, f.OwnershipType),
            }).ToList(),
            files.Select(f => f with
            {
                IsStarred = starredFiles.Contains(f.Id),
                OwnerDisplayName = f.OwnerUserId is Guid o ? ownerNames.GetValueOrDefault(o) : null,
                ParentName = ParentOf(f.FolderId, f.OwnershipType),
            }).ToList());
    }

    internal static async Task<SpaceEndpoints.SpaceFileDto> DecorateFileAsync(
        AppDbContext db, Guid uid, SpaceEndpoints.SpaceFileDto dto, CancellationToken ct)
        => (await DecorateAsync(db, uid, [], [dto], withParentName: false, ct)).Files[0];

    internal static async Task<SpaceEndpoints.SpaceFolderDto> DecorateFolderAsync(
        AppDbContext db, Guid uid, SpaceEndpoints.SpaceFolderDto dto, CancellationToken ct)
        => (await DecorateAsync(db, uid, [dto], [], withParentName: false, ct)).Folders[0];
}
