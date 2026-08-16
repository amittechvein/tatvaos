using System.ComponentModel.DataAnnotations;
using NpgsqlTypes;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  SPACE — files and folders
//
//  Mirrors local/postgres/init/25-space-schema.sql. Its own file for the same
//  reason FamilyEntities.cs is: the fourth product should not make the first
//  three harder to read.
//
//  Ownership is Family's model, with Family's hard-won correction applied:
//
//    personal        OwnerUserId set; invisible to colleagues unless shared
//    organisational  OwnerUserId null; visible tenant-wide
//
//  BUT the owner FK is ON DELETE SET NULL, not CASCADE — deleting a user
//  RETAINS their files as owner-less personal rows (invisible until an admin
//  reassigns them) instead of destroying them. Family's cascade destroyed a
//  deleted user's entire address book; Space starts on the fixed footing.
//
//  Class names are prefixed Space* because Mail already owns Folder and
//  System.IO owns File. The tables underneath are plain space.folders /
//  space.files / space.shares.
// ============================================================================

/// <summary>
/// A folder. No path column, deliberately — a stored path is correct exactly
/// until a folder near the root is renamed. Breadcrumbs resolve with a
/// recursive CTE on ParentFolderId (see SpaceEndpoints.ChainAsync).
/// Depth is capped at 32 and cycle-checked on move, in the application.
/// </summary>
public class SpaceFolder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Null = the folder sits in a root (personal or organisational).</summary>
    public Guid? ParentFolderId { get; set; }

    /// <summary>Null once the creator's account is deleted; the folder survives.</summary>
    public Guid? CreatedByUserId { get; set; }

    /// <summary>"personal" or "organisational". Paired with OwnerUserId by a CHECK.</summary>
    [MaxLength(16)] public string OwnershipType { get; set; } = "personal";

    /// <summary>
    /// Set for personal folders — but MAY be null on a personal row: that is
    /// the retained state after the owner's account was deleted.
    /// </summary>
    public Guid? OwnerUserId { get; set; }

    [MaxLength(300)] public required string Name { get; set; }

    /// <summary>
    /// Soft delete — the trash. Null = live; restore = set back to null.
    /// Stamped on THIS row only when a folder is trashed; contents follow
    /// their ancestor. Purged by StorageReconcileWorker after 30 days.
    /// </summary>
    public DateTimeOffset? DeletedAt { get; set; }
    public Guid? DeletedByUserId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A file's METADATA. The bytes live on the blob volume under BlobKey.
/// </summary>
public class SpaceFile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Null = the file sits in a root.</summary>
    public Guid? FolderId { get; set; }

    public Guid? CreatedByUserId { get; set; }

    [MaxLength(16)] public string OwnershipType { get; set; } = "personal";
    public Guid? OwnerUserId { get; set; }

    /// <summary>
    /// Display name ONLY. Never used to locate bytes on disk — that is what
    /// BlobKey is for — and deliberately NOT unique per folder: Drive allows
    /// two "notes.txt" side by side, so Space does too.
    /// </summary>
    [MaxLength(500)] public required string Name { get; set; }

    [MaxLength(255)] public string MimeType { get; set; } = "application/octet-stream";

    /// <summary>
    /// Opaque, server-generated: {tenant_id}/{yyyy}/{mm}/{uuid4}. Never derived
    /// from the uploaded filename (path traversal) and never deterministic
    /// (delete-and-recreate collision). Unique — one blob, one row. On
    /// overwrite a NEW key is written and this pointer moves; the old blob is
    /// never overwritten in place, so history is recoverable when versions
    /// arrive.
    /// </summary>
    [MaxLength(200)] public required string BlobKey { get; set; }

    /// <summary>What actually landed on disk — not what the upload declared.</summary>
    public long SizeBytes { get; set; }

    public DateTimeOffset? DeletedAt { get; set; }
    public Guid? DeletedByUserId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Maintained by a trigger (25-space-schema.sql), never by this code.</summary>
    public NpgsqlTsVector? SearchVector { get; set; }
}

/// <summary>
/// One grant: one object (file XOR folder — CHECKed), one audience (a named
/// user XOR the whole organisation — CHECKed), one level.
///
/// Folder grants reach contents at QUERY time by walking ancestors; rows are
/// never copied down to children, so "why can this person see this?" always
/// has a one-row answer. Unique per (object, audience) — re-sharing updates
/// the level on the existing row rather than stacking rows.
/// </summary>
public class SpaceShare
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public Guid? FileId { get; set; }
    public Guid? FolderId { get; set; }

    /// <summary>Null once the granter's account is deleted; the grant survives.</summary>
    public Guid? SharedByUserId { get; set; }

    /// <summary>Null exactly when OrgWide — the share targets the whole tenant.</summary>
    public Guid? SharedWithUserId { get; set; }
    public bool OrgWide { get; set; }

    /// <summary>view | comment | edit. Effective = highest on the item or any ancestor.</summary>
    [MaxLength(16)] public string Permission { get; set; } = "view";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// The caller's latest touch on a file — ONE row per (user, file), upserted,
/// latest action wins. Powers /recent and Home. Not an audit trail
/// (core.audit_logs is that). Strictly per-user by RLS (29-space-drive.sql).
/// Written only by genuine user paths — download/upload/overwrite — never by
/// the SpaceContentGateway or thumbnails; see RecordActivityAsync.
/// </summary>
public class SpaceFileActivity
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public Guid FileId { get; set; }

    /// <summary>opened | created | modified — the latest wins.</summary>
    [MaxLength(16)] public string Action { get; set; } = "opened";

    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A personal star on one object (file XOR folder, CHECKed). My stars are
/// invisible to colleagues — per-user RLS, not application code. Unique per
/// (user, object): starring twice is an upsert-shaped no-op.
/// </summary>
public class SpaceStar
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public Guid? FileId { get; set; }
    public Guid? FolderId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A public download link — a CAPABILITY, treated like a credential. The
/// token itself is never stored: TokenHash is SHA-256 of it, and the
/// plaintext exists exactly once, in the create response. Expiry is
/// required; revocation is a stamp so the count and audit story survive.
/// PasswordHash is reserved for v2 and unused. See
/// SPACE_API_PUBLIC_LINKS_ADDENDUM.md and 20260816-space-public-links.sql.
/// </summary>
public class SpacePublicLink
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid FileId { get; set; }

    [MaxLength(64)] public required string TokenHash { get; set; }

    public Guid? CreatedByUserId { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
    public int? MaxDownloads { get; set; }
    public int DownloadCount { get; set; }

    /// <summary>Reserved for v2 password protection. Unused.</summary>
    [MaxLength(200)] public string? PasswordHash { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Space's own per-tenant policy — NOT core.tenants, which is the identity
/// table and not a junk drawer for product flags. An absent row means the
/// defaults. allow_public_links=false closes the TAP: existing links 404
/// immediately (the resolve predicate checks it), reversibly.
/// </summary>
public class SpaceTenantSetting
{
    public Guid TenantId { get; set; }
    public bool AllowPublicLinks { get; set; } = true;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
