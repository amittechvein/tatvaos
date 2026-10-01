namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  DOCS — collaborative documents
//
//  Mirrors local/postgres/init/20260924-docs-schema.sql; read its header
//  first. The short version: a document IS a Space file (SpaceFile, mime
//  type DocsFormat.MimeType). These classes hold only what Space cannot —
//  the Yjs content, its history, comments and pictures — and every one of
//  them is keyed by the Space file's id.
//
//  The server never parses Yjs. State and update payloads are opaque bytes.
// ============================================================================

/// <summary>The live content of one document.</summary>
public class DocsDocument
{
    public Guid FileId { get; set; }
    public Guid TenantId { get; set; }

    /// <summary>A Yjs update encoding the whole document as of StateSeq. Empty = blank.</summary>
    public byte[] State { get; set; } = [];
    public long StateSeq { get; set; }

    public string TextContent { get; set; } = "";

    public DateTimeOffset? CheckpointAt { get; set; }
    public Guid? CheckpointByUserId { get; set; }

    /// <summary>
    /// The update seq the render service last built the file from. NULL with
    /// CheckpointAt set = a browser wrote the file (before 0011 condition 1).
    /// See 20260930-b-docs-rendered-by-server.sql.
    /// </summary>
    public long? RenderedSeq { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>One Yjs update, as a browser sent it. Seq is assigned by the database.</summary>
public class DocsUpdate
{
    public long Seq { get; set; }
    public Guid FileId { get; set; }
    public Guid TenantId { get; set; }
    public Guid? UserId { get; set; }
    public byte[] Data { get; set; } = [];
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A snapshot. Kind: auto | named | restore.</summary>
public class DocsVersion
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileId { get; set; }
    public Guid TenantId { get; set; }
    public string Kind { get; set; } = "auto";
    public string? Name { get; set; }
    public byte[] State { get; set; } = [];
    public string Html { get; set; } = "";
    public Guid? CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A comment. Root when ParentId is null; the root carries the anchor and the resolution.</summary>
public class DocsComment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileId { get; set; }
    public Guid TenantId { get; set; }
    public Guid? ParentId { get; set; }
    public Guid? AuthorUserId { get; set; }
    public string Body { get; set; } = "";

    /// <summary>Opaque JSON from the browser: two Yjs relative positions.</summary>
    public string? Anchor { get; set; }
    public string? Quote { get; set; }

    public DateTimeOffset? ResolvedAt { get; set; }
    public Guid? ResolvedByUserId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EditedAt { get; set; }
}

/// <summary>A picture inside a document. Raster only — see the schema on SVG.</summary>
public class DocsImage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid FileId { get; set; }
    public Guid TenantId { get; set; }
    public string MimeType { get; set; } = "image/png";
    public byte[] Data { get; set; } = [];
    public long SizeBytes { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// The per-organisation switch. No row = Docs is off. Written only by the
/// platform operator (DocsAdminEndpoints); readable by the organisation.
/// </summary>
public class DocsTenantSetting
{
    public Guid TenantId { get; set; }
    public bool Enabled { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Sheets' own per-organisation switch (20260925-sheets-switch.sql). Same
/// rules as DocsTenantSetting: no row = off, written only by the operator.
/// </summary>
public class SheetsTenantSetting
{
    public Guid TenantId { get; set; }
    public bool Enabled { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
