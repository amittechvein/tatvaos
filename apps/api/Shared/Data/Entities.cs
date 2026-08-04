using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  ROUTING entities — no RLS. The mail edge reads these across tenants because
//  an inbound SMTP connection has no tenant context until the recipient is
//  resolved. See local/postgres/init/01-schema.sql for the full reasoning.
// ============================================================================

public class Tenant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [MaxLength(200)] public required string Name { get; set; }
    [MaxLength(32)]  public string Status { get; set; } = "pending";
    [MaxLength(32)]  public string Type { get; set; } = "business";

    public Guid PlanId { get; set; }

    /// <summary>"per_user" or "pooled". Drives every quota decision.</summary>
    [MaxLength(16)] public string StorageModel { get; set; } = "per_user";
    public int? MaxUsers { get; set; }
    public long? PerUserQuotaBytes { get; set; }
    public long? PooledStorageBytes { get; set; }

    [MaxLength(200)] public string? AdminName { get; set; }
    [MaxLength(320)] public string? AdminEmail { get; set; }
    [MaxLength(32)]  public string? Phone { get; set; }
    [MaxLength(100)] public string Country { get; set; } = "India";
    [MaxLength(20)]  public string? Gstin { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SuspendedAt { get; set; }
    public DateTimeOffset? TrialEndsAt { get; set; }

    public List<Domain> Domains { get; set; } = [];
    public List<Mailbox> Mailboxes { get; set; } = [];
}

public class Domain
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    [MaxLength(253)] public required string Fqdn { get; set; }
    [MaxLength(16)]  public string Type { get; set; } = "primary";
    public bool IsActive { get; set; }

    /// <summary>Ownership token. Until this is proven, no mail is accepted.</summary>
    [MaxLength(64)] public string? VerificationToken { get; set; }
    public DateTimeOffset? OwnershipVerifiedAt { get; set; }
    public DateTimeOffset? MxVerifiedAt { get; set; }

    [MaxLength(64)]  public string? DkimSelector { get; set; }
    [MaxLength(256)] public string? DkimPrivateKeyRef { get; set; }
    [MaxLength(16)]  public string DmarcPolicy { get; set; } = "none";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Tenant? Tenant { get; set; }
}

public class UserCategory
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    [MaxLength(100)] public required string Name { get; set; }
    [MaxLength(500)] public string? Description { get; set; }
    public long? DefaultQuotaBytes { get; set; }
    [MaxLength(32)]  public string DefaultRole { get; set; } = "employee";

    /// <summary>
    /// Whether members may send outside the organisation. False for students
    /// is both a school requirement and a genuine abuse control.
    /// </summary>
    public bool CanSendExternal { get; set; } = true;

    public string[] AutoGroups { get; set; } = [];
    [MaxLength(9)] public string Colour { get; set; } = "#3563f0";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class Mailbox
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DomainId { get; set; }
    public Guid? CategoryId { get; set; }

    [MaxLength(320)] public required string Address { get; set; }
    [MaxLength(64)]  public required string LocalPart { get; set; }
    [MaxLength(200)] public string? DisplayName { get; set; }
    [MaxLength(16)]  public string Type { get; set; } = "user";
    [MaxLength(32)]  public string Role { get; set; } = "employee";
    [MaxLength(32)]  public string Status { get; set; } = "pending";

    /// <summary>Argon2id. Never any other scheme in production.</summary>
    [MaxLength(256)] public string? PasswordHash { get; set; }
    [MaxLength(256)] public string? MfaSecretRef { get; set; }

    public long QuotaBytes { get; set; }
    /// <summary>Maintained incrementally. Never SUM() this on read.</summary>
    public long UsedBytes { get; set; }

    public bool IsActive { get; set; } = true;
    public DateTimeOffset? LastLoginAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public Domain? Domain { get; set; }
    public UserCategory? Category { get; set; }
}

public class Alias
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DomainId { get; set; }
    public Guid TargetMailboxId { get; set; }
    [MaxLength(320)] public required string Address { get; set; }
    public bool IsActive { get; set; } = true;
}

// ============================================================================
//  CONTENT entities — RLS enabled AND forced. The mail edge role has no grant
//  on any of these.
// ============================================================================

public class Folder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid MailboxId { get; set; }
    public Guid? ParentId { get; set; }
    [MaxLength(255)] public required string Name { get; set; }
    [MaxLength(32)]  public string? SpecialUse { get; set; }

    /// <summary>IMAP requires these. Retro-fitting them is painful.</summary>
    public long UidValidity { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public long UidNext { get; set; } = 1;
}

public class Message
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid MailboxId { get; set; }
    public Guid FolderId { get; set; }
    public Guid? ThreadId { get; set; }
    public long ImapUid { get; set; }

    [MaxLength(512)] public string? MessageIdHeader { get; set; }
    [MaxLength(320)] public string? FromAddr { get; set; }
    public string[] ToAddrs { get; set; } = [];
    [MaxLength(1000)] public string? Subject { get; set; }

    public DateTimeOffset? SentAt { get; set; }
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
    public long SizeBytes { get; set; }
    public bool IsRead { get; set; }
    public bool IsFlagged { get; set; }
    public float? SpamScore { get; set; }

    /// <summary>Object storage key. Bodies do NOT live in Postgres.</summary>
    [MaxLength(512)] public string? BlobKey { get; set; }
}

public class AuditLog
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid? ActorUserId { get; set; }
    [MaxLength(64)]  public string? ActorIp { get; set; }
    [MaxLength(100)] public required string Action { get; set; }
    [MaxLength(64)]  public string? TargetType { get; set; }
    [MaxLength(128)] public string? TargetId { get; set; }
    public string? BeforeState { get; set; }
    public string? AfterState { get; set; }
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

public class Plan
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [MaxLength(100)] public required string Name { get; set; }
    public int? MaxUsers { get; set; }
    [MaxLength(16)] public string StorageModel { get; set; } = "per_user";
    public long? PerUserQuotaBytes { get; set; }
    public long? PooledStorageBytes { get; set; }
    public int? MaxDomains { get; set; }
    public decimal? PricePerUserMonthly { get; set; }
    public decimal? PriceMonthly { get; set; }
}
