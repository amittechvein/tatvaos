using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Space;

/// <summary>
/// The surface OTHER PRODUCTS call to read and store Space content. This is
/// the class the whole product thesis hangs on: Mail attaches a document
/// without the browser re-uploading it, Family stores a contact's photo, and
/// no product ever builds its own file store again.
///
/// Contract for callers: docs/SPACE_ATTACH.md. Two rules above all:
///
///  - Everything here runs AS THE SIGNED-IN USER. Scoped service, the
///    caller's AppDbContext, the caller's TenantContext — so RLS and the
///    visibility rules apply to the person behind the request. A file the
///    caller cannot see returns null exactly like one that does not exist.
///    Never wrap this in anything that widens that.
///
///  - No quota system of its own. Saves are gated by StorageAllocator
///    against product 'drive', same numbers as the upload endpoint. If a
///    caller needs something the gate cannot express, the fix belongs in
///    StorageAllocator, not beside it.
/// </summary>
public sealed class SpaceContentGateway(
    AppDbContext db, TenantContext tenant, IBlobStore blobs,
    StorageAllocator allocator, IConfiguration config)
{
    /// <summary>The caller owns the Stream and must dispose it.</summary>
    public sealed record SpaceContent(
        Stream Stream, Guid FileId, string Name, string MimeType, long SizeBytes);

    /// <summary>
    /// Open a live Space file for reading — Mail's attach path. Null when the
    /// file does not exist, is trashed, is invisible to this caller, or its
    /// bytes are missing: all indistinguishable on purpose. STREAM the result
    /// into whatever is being built (a MIME part, a thumbnail pass); never
    /// buffer it whole.
    /// </summary>
    public async Task<SpaceContent?> OpenReadAsync(Guid fileId, CancellationToken ct = default)
    {
        var f = await db.SpaceFiles.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == fileId && x.DeletedAt == null, ct);
        if (f is null) return null;

        var stream = blobs.OpenRead(f.BlobKey);
        return stream is null
            ? null
            : new SpaceContent(stream, f.Id, f.Name, f.MimeType, f.SizeBytes);
    }

    /// <summary>
    /// Metadata only — for validating a batch of ids up front so a send can
    /// name WHICH attachment is missing before any byte moves. Returns only
    /// the ids that resolved; the caller diffs against what it asked for.
    /// </summary>
    public async Task<IReadOnlyList<SpaceContentInfo>> DescribeAsync(
        IReadOnlyCollection<Guid> fileIds, CancellationToken ct = default)
    {
        if (fileIds.Count == 0) return [];
        return await db.SpaceFiles.AsNoTracking()
            .Where(f => fileIds.Contains(f.Id) && f.DeletedAt == null)
            .Select(f => new SpaceContentInfo(f.Id, f.Name, f.MimeType, f.SizeBytes))
            .ToListAsync(ct);
    }

    public sealed record SpaceContentInfo(Guid FileId, string Name, string MimeType, long SizeBytes);

    // =====================================================================
    //  The write direction — "save to Space"
    // =====================================================================

    /// <summary>
    /// Why a reason and not a bool: the reasons are the SAME set the upload
    /// endpoint maps to 413, so a product surfacing this to a person can
    /// reuse the exact UI branching the Space frontend already has.
    /// </summary>
    public sealed record SaveOutcome(SpaceFile? File, string? Error, string? Reason)
    {
        public bool Ok => File is not null;
    }

    /// <summary>
    /// Store a stream as a new Space file — "save attachment to Space",
    /// Family photos. Destination is a folder id, or a root via scope
    /// ('personal' | 'organisational'). Quota is checked against the DECLARED
    /// size before a byte is written; the stored SizeBytes is what actually
    /// landed, and the derived usage figure is trued up after.
    ///
    /// MVP limitation, stated rather than hidden: folder destinations are
    /// accepted when the folder is organisational or owned by the caller.
    /// A folder merely SHARED to the caller with edit is refused for now —
    /// the ancestor-grant walk lives in the endpoints and will move here
    /// when a product actually needs that case.
    /// </summary>
    public async Task<SaveOutcome> SaveAsync(
        Stream source, string fileName, string? mimeType, long declaredBytes,
        Guid? folderId = null, string scope = "personal", CancellationToken ct = default)
    {
        if (tenant.UserId is not Guid uid)
            return new(null, "There is no signed-in person to own the file.", "no_user");

        string ownership;
        Guid? owner;
        if (folderId is Guid fid)
        {
            var parent = await db.SpaceFolders.AsNoTracking()
                .FirstOrDefaultAsync(f => f.Id == fid && f.DeletedAt == null, ct);
            if (parent is null)
                return new(null, "No such folder.", "no_folder");
            if (parent.OwnershipType != "organisational" && parent.OwnerUserId != uid)
                return new(null, "You cannot save into that folder.", "no_access");

            // Contents take the ownership of the folder they land in.
            ownership = parent.OwnershipType;
            owner = parent.OwnerUserId;
        }
        else if (scope is "personal" or "organisational")
        {
            ownership = scope;
            owner = scope == "personal" ? uid : null;
        }
        else
        {
            return new(null, "scope must be personal or organisational.", "bad_scope");
        }

        var maxBytes = config.GetValue<long?>("Space:MaxFileBytes") ?? 2L * 1024 * 1024 * 1024;

        // THE SAME GATE the upload endpoint uses — one-allowance-per-person
        // (docs/STORAGE_MODEL.md): personal content checks the owning person
        // via core.user_storage(), organisational content checks the org
        // pool. One implementation, deliberately: two versions of "is there
        // room" eventually disagree, and the one that refuses is the one the
        // customer notices.
        var verdict = await Endpoints.SpaceEndpoints.EvaluateStorageAsync(
            db, allocator, tenant.TenantId, ownership, owner, uid,
            declaredBytes, declaredBytes, maxBytes, ct);
        if (!verdict.Ok)
            return new(null, verdict.Message, verdict.Reason);

        var name = Path.GetFileName(fileName ?? "").Trim();
        if (string.IsNullOrEmpty(name)) name = "Untitled";
        if (name.Length > 500) name = name[..500];

        var key = blobs.NewKey(tenant.TenantId);
        long written;
        try
        {
            written = await blobs.WriteAsync(key, source, maxBytes, ct);
        }
        catch (BlobTooLargeException)
        {
            return new(null, $"Files are limited to {maxBytes / (1024 * 1024)} MB each.", "file_too_large");
        }

        var file = new SpaceFile
        {
            TenantId = tenant.TenantId,
            FolderId = folderId,
            CreatedByUserId = uid,
            OwnershipType = ownership,
            OwnerUserId = owner,
            Name = name,
            MimeType = string.IsNullOrWhiteSpace(mimeType) ? "application/octet-stream" : mimeType,
            BlobKey = key,
            SizeBytes = written,
        };
        db.SpaceFiles.Add(file);
        await db.SaveChangesAsync(ct);

        await allocator.ReconcileUsageAsync(tenant.TenantId, ct);
        return new(file, null, null);
    }
}
