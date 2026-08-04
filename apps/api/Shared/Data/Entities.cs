using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  The shape of this file mirrors the database, and the database mirrors the
//  product: Core owns tenants, domains and PEOPLE; each product owns what it
//  grants those people.
//
//    core.users      a person who can sign in
//    mail.mailboxes  a store that receives mail
//
//  These are not the same thing. Conflating them breaks shared mailboxes
//  (support@ has no person), retained mailboxes (the person is gone, the mail
//  is kept for the legal window) and product-only users (a factory worker who
//  needs a payslip and no email at all).
//
//  See docs/architecture/00-product-structure.md.
// ============================================================================

// ============================================================================
//  CORE — ROUTING. No RLS. The mail edge reads these across tenants because an
//  inbound SMTP connection has no tenant context until the recipient resolves.
// ============================================================================

public class Product
{
    [MaxLength(32)]  public required string Code { get; set; }
    [MaxLength(100)] public required string Name { get; set; }
    [MaxLength(500)] public string? Description { get; set; }
    public bool IsAvailable { get; set; }
    public int SortOrder { get; set; } = 100;
}

public class Tenant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [MaxLength(200)] public required string Name { get; set; }
    [MaxLength(32)]  public string Type { get; set; } = "business";
    [MaxLength(32)]  public string Status { get; set; } = "pending";

    [MaxLength(200)] public string? AdminName { get; set; }
    [MaxLength(320)] public string? AdminEmail { get; set; }
    [MaxLength(32)]  public string? Phone { get; set; }
    [MaxLength(100)] public string Country { get; set; } = "India";
    [MaxLength(20)]  public string? Gstin { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SuspendedAt { get; set; }
    public DateTimeOffset? TrialEndsAt { get; set; }

    public List<Domain> Domains { get; set; } = [];
    public List<User> Users { get; set; } = [];
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

/// <summary>
/// Identity. THE table the whole structure exists for.
///
/// A person has one row here regardless of how many products they use.
/// Password, MFA and status live here and nowhere else, so one suspend action
/// removes Mail, Drive and Payroll at once — and there is no sixth place
/// someone forgets to revoke on the day an employee leaves.
/// </summary>
public class User
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid? DomainId { get; set; }

    /// <summary>
    /// Sign-in identity. Usually equals the mailbox address, but not by
    /// necessity — a Payroll-only user needs a login and no mailbox.
    /// </summary>
    [MaxLength(320)] public required string Email { get; set; }
    [MaxLength(200)] public required string DisplayName { get; set; }

    /// <summary>Argon2id. Never any other scheme in production.</summary>
    [MaxLength(256)] public string? PasswordHash { get; set; }
    [MaxLength(256)] public string? MfaSecretRef { get; set; }
    public bool MfaEnabled { get; set; }

    public Guid? CategoryId { get; set; }
    [MaxLength(32)] public string Role { get; set; } = "employee";
    [MaxLength(32)] public string Status { get; set; } = "pending";

    public DateTimeOffset? LastLoginAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public UserCategory? Category { get; set; }
    public Domain? Domain { get; set; }
}

/// <summary>
/// Defaults applied to new users ACROSS products — which products they get,
/// their storage, their role. Creating fifty identical accounts one at a time
/// is what makes an admin abandon a platform.
/// </summary>
public class UserCategory
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    [MaxLength(100)] public required string Name { get; set; }
    [MaxLength(500)] public string? Description { get; set; }

    [MaxLength(32)] public string DefaultRole { get; set; } = "employee";
    public long? DefaultQuotaBytes { get; set; }

    /// <summary>Which products a new user in this category receives.</summary>
    public string[] DefaultProducts { get; set; } = ["mail"];

    /// <summary>
    /// Whether members may send outside the organisation. False for students
    /// is both a school requirement and a genuine abuse control.
    /// </summary>
    public bool CanSendExternal { get; set; } = true;

    public string[] AutoGroups { get; set; } = [];
    [MaxLength(9)] public string Colour { get; set; } = "#3563f0";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Which user may use which product. One row, not a schema change.</summary>
public class ProductAccess
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    [MaxLength(32)] public required string ProductCode { get; set; }
    public DateTimeOffset GrantedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RevokedAt { get; set; }
}

// ============================================================================
//  CORE — COMMERCIAL. RLS enabled and forced; the mail edge has no grant.
// ============================================================================

public class Plan
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [MaxLength(100)] public required string Name { get; set; }
    public int? MaxUsers { get; set; }
    [MaxLength(16)] public string StorageModel { get; set; } = "per_user";
    public long? PerUserQuotaBytes { get; set; }
    public long? PooledStorageBytes { get; set; }
    public int? MaxDomains { get; set; }
    public string[] IncludedProducts { get; set; } = ["mail"];
    public decimal? PricePerUserMonthly { get; set; }
    public decimal? PriceMonthly { get; set; }
}

public class Subscription
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid PlanId { get; set; }
    [MaxLength(16)] public string Status { get; set; } = "trial";
    public int Seats { get; set; }
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RenewsAt { get; set; }
    public DateTimeOffset? CancelledAt { get; set; }

    public Plan? Plan { get; set; }
}

/// <summary>
/// The customer buys one number. Their admin decides how it is divided across
/// products, and can rebalance whenever they like.
/// </summary>
public class StoragePool
{
    public Guid TenantId { get; set; }
    [MaxLength(16)] public string StorageModel { get; set; } = "per_user";
    public long TotalBytes { get; set; }
    public long? PerUserQuotaBytes { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class StorageAllocation
{
    public Guid TenantId { get; set; }
    [MaxLength(32)] public required string ProductCode { get; set; }

    /// <summary>NULL means "draw from whatever is left in the pool".</summary>
    public long? AllocatedBytes { get; set; }

    /// <summary>Maintained incrementally. Never SUM() this on read.</summary>
    public long UsedBytes { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class AuditLog
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    [MaxLength(32)]  public string? ProductCode { get; set; }
    public Guid? ActorUserId { get; set; }
    [MaxLength(64)]  public string? ActorIp { get; set; }
    [MaxLength(100)] public required string Action { get; set; }
    [MaxLength(64)]  public string? TargetType { get; set; }
    [MaxLength(128)] public string? TargetId { get; set; }
    public string? BeforeState { get; set; }
    public string? AfterState { get; set; }
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

// ============================================================================
//  MAIL — the first product on Core.
// ============================================================================

public class Mailbox
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DomainId { get; set; }

    /// <summary>
    /// NULL for shared mailboxes and groups — they have no person behind them.
    /// Also NULL once a user is deleted but their mail is retained.
    /// </summary>
    public Guid? UserId { get; set; }

    [MaxLength(320)] public required string Address { get; set; }
    [MaxLength(64)]  public required string LocalPart { get; set; }
    [MaxLength(16)]  public string Type { get; set; } = "user";

    /// <summary>
    /// For IMAP and SMTP clients that cannot do OAuth. Deliberately separate
    /// from the Core password: an app password is scoped and revocable on its
    /// own, so revoking Thunderbird does not lock the person out of Payroll.
    /// </summary>
    [MaxLength(256)] public string? ImapPasswordHash { get; set; }

    public long QuotaBytes { get; set; }
    /// <summary>Maintained incrementally. Never SUM() this on read.</summary>
    public long UsedBytes { get; set; }

    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public Domain? Domain { get; set; }
    public User? User { get; set; }
}

public class Alias
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DomainId { get; set; }
    public Guid TargetMailboxId { get; set; }
    [MaxLength(320)] public required string Address { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Delegated access to a shared mailbox. Attribution stays with the human.</summary>
public class MailboxPermission
{
    public Guid MailboxId { get; set; }
    public Guid UserId { get; set; }
    [MaxLength(32)] public required string Permission { get; set; }
    public DateTimeOffset GrantedAt { get; set; } = DateTimeOffset.UtcNow;
}

// ============================================================================
//  MAIL — CONTENT. RLS enabled AND forced. The mail edge has no grant here.
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
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
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

public class Attachment
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid MessageId { get; set; }
    [MaxLength(512)] public required string Filename { get; set; }
    [MaxLength(200)] public string? ContentType { get; set; }
    public long SizeBytes { get; set; }
    [MaxLength(64)]  public string? Sha256 { get; set; }
    [MaxLength(512)] public string? BlobKey { get; set; }
    [MaxLength(16)]  public string ScanStatus { get; set; } = "pending";
}
