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

    /// <summary>
    /// "signup" (self-service form) or "onboarded" (created by Techvein).
    /// Recorded because they warrant different trust — an account created after
    /// a conversation is not the same risk as one created by a form at 3am.
    /// </summary>
    [MaxLength(16)] public string Origin { get; set; } = "signup";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SuspendedAt { get; set; }
    public DateTimeOffset? TrialEndsAt { get; set; }

    public List<Domain> Domains { get; set; } = [];
    public List<User> Users { get; set; } = [];
}

/// <summary>
/// A DKIM signing key. One per domain — see 10-dkim.sql for why this is a
/// separate table rather than columns on Domain.
///
/// PrivateKeyPem has no read path anywhere in the API. It is written once and
/// materialised to the signing volume; nothing returns it.
/// </summary>
public class DkimKey
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid DomainId { get; set; }
    [MaxLength(64)] public required string Selector { get; set; }
    public required string PrivateKeyPem { get; set; }
    public required string PublicKeyB64 { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RetiredAt { get; set; }
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

    /// <summary>
    /// How ownership was proven. Recorded because CNAME, HTML-file and
    /// meta-tag verifications lapse when a customer moves their website, and
    /// knowing which was used turns an hour of support into five minutes.
    /// </summary>
    [MaxLength(16)] public string? VerificationMethod { get; set; }

    [MaxLength(64)]  public string? DkimSelector { get; set; }
    [MaxLength(256)] public string? DkimPrivateKeyRef { get; set; }
    [MaxLength(16)]  public string DmarcPolicy { get; set; } = "none";

    // ---- Verification state ---------------------------------------------
    // Five independent timestamps, not one flag. Ownership proven while MX
    // still points elsewhere is a different problem from nothing being
    // configured, and the admin has to be told which they have.
    public DateTimeOffset? SpfVerifiedAt { get; set; }
    public DateTimeOffset? DkimVerifiedAt { get; set; }
    public DateTimeOffset? DmarcVerifiedAt { get; set; }
    public DateTimeOffset? LastCheckedAt { get; set; }
    [MaxLength(500)] public string? LastCheckResult { get; set; }

    /// <summary>
    /// A subdomain of a domain TatvaOS owns, issued at onboarding. Verified by
    /// construction, and not deletable by the customer — it is how they sign
    /// in if their own domain's DNS ever breaks.
    /// </summary>
    public bool IsPlatform { get; set; }

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

    public Guid? DepartmentId { get; set; }
    [MaxLength(32)] public string Role { get; set; } = "employee";
    [MaxLength(32)] public string Status { get; set; } = "pending";

    public DateTimeOffset? LastLoginAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    // ---- Sign-in state ---------------------------------------------------
    /// <summary>Reset to zero on any successful sign-in.</summary>
    public int FailedLoginCount { get; set; }

    /// <summary>
    /// Set after too many failures. A lockout, not a ban — it expires on its
    /// own, because the usual cause is someone mistyping their own password
    /// and an admin ticket for that is a waste of everyone's afternoon.
    /// </summary>
    public DateTimeOffset? LockedUntil { get; set; }

    public DateTimeOffset? PasswordChangedAt { get; set; }

    /// <summary>True while the account still has the password an admin read
    /// off a screen and typed into a chat window.</summary>
    public bool MustChangePassword { get; set; }

    /// <summary>
    /// When the address was proven readable — set by the signup OTP, or later
    /// by a confirmation link for admin-created accounts. Password resets and
    /// invoices go here, so an unconfirmed address is a support case waiting.
    /// </summary>
    public DateTimeOffset? EmailConfirmedAt { get; set; }

    public Department? Department { get; set; }
    public Domain? Domain { get; set; }
}

/// <summary>
/// A revocable session.
///
/// Access tokens are not checked against the database — that is what makes
/// them fast, and what makes them impossible to withdraw early. This is the
/// counterweight: every renewal goes through a row that can be revoked, so
/// suspending a person takes effect within one access-token lifetime rather
/// than whenever their token happens to expire.
///
/// The stored value is a SHA-256 hash, never the token itself.
/// </summary>
public class RefreshToken
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    [MaxLength(64)] public required string TokenHash { get; set; }

    public Guid? ReplacedBy { get; set; }

    /// <summary>
    /// Every token descended from one sign-in shares this. Presenting an
    /// already-revoked token means a replay, so the whole family is killed.
    /// </summary>
    public Guid FamilyId { get; set; }

    public DateTimeOffset IssuedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    [MaxLength(100)] public string? RevokeReason { get; set; }

    [MaxLength(512)] public string? UserAgent { get; set; }
    [MaxLength(64)]  public string? IpAddress { get; set; }
}

/// <summary>
/// Defaults applied to new users ACROSS products — which products they get,
/// their storage, their role. Creating fifty identical accounts one at a time
/// is what makes an admin abandon a platform.
/// </summary>
public class Department
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    [MaxLength(100)] public required string Name { get; set; }
    [MaxLength(500)] public string? Description { get; set; }

    /// <summary>
    /// The department this sits inside. NULL is top level.
    ///
    /// What Google calls an Organisational Unit — a named group carrying
    /// policy that passes down to everything beneath it.
    /// </summary>
    public Guid? ParentId { get; set; }

    [MaxLength(32)] public string DefaultRole { get; set; } = "employee";

    /// <summary>
    /// NULL means INHERIT — take the parent's value, and its parent's if that
    /// is NULL too, up to the tenant's storage pool.
    ///
    /// That is the point of the tree: set 30 GB on Engineering and every team
    /// under it gets 30 GB; raise it to 50 and they all move with no per-team
    /// edit. Copying the value down would look identical on day one and drift
    /// apart by the end of the quarter.
    /// </summary>
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

/// <summary>
/// An unfinished signup.
///
/// Holds everything until domain verification passes, at which point a tenant,
/// an owner and a domain are created together. Nothing half-made ever exists.
///
/// A draft that never converts is not waste — it is a lead. Somebody typed
/// their organisation's name, their own name and their phone number because
/// they wanted this, then hit a step needing DNS access they may not have.
/// </summary>
public class SignupDraft
{
    public Guid Id { get; set; } = Guid.NewGuid();

    [MaxLength(200)] public required string OrgName { get; set; }
    [MaxLength(32)]  public string OrgType { get; set; } = "business";
    [MaxLength(100)] public string Country { get; set; } = "India";
    [MaxLength(20)]  public string? Gstin { get; set; }

    [MaxLength(200)] public required string AdminName { get; set; }
    [MaxLength(320)] public required string AdminEmail { get; set; }
    [MaxLength(32)]  public string? AdminPhone { get; set; }

    [MaxLength(253)] public string? Fqdn { get; set; }

    [MaxLength(64)] public required string VerificationToken { get; set; }
    [MaxLength(16)] public string? VerificationMethod { get; set; }

    public int Attempts { get; set; }
    public DateTimeOffset? LastAttemptAt { get; set; }
    [MaxLength(500)] public string? LastAttemptError { get; set; }

    // ---- Contact verification -------------------------------------------
    // Codes hashed, never stored plain: the drafts table is readable by the
    // sales queue, and a readable live code is a takeover of that signup.
    [MaxLength(64)] public string? EmailCodeHash { get; set; }
    public DateTimeOffset? EmailCodeSentAt { get; set; }
    public DateTimeOffset? EmailVerifiedAt { get; set; }

    [MaxLength(64)] public string? PhoneCodeHash { get; set; }
    public DateTimeOffset? PhoneCodeSentAt { get; set; }
    public DateTimeOffset? PhoneVerifiedAt { get; set; }

    public int CodeAttempts { get; set; }

    /// <summary>
    /// Where they stopped. Drives "resume where you left off" and the sales
    /// queue — abandoning at contact verification is a lead worth calling;
    /// step 1 is a bounced visitor.
    /// </summary>
    public int ReachedStep { get; set; } = 1;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Kept rather than deleted on success, so the funnel is measurable.</summary>
    public DateTimeOffset? CompletedAt { get; set; }
    public Guid? ConvertedTenantId { get; set; }
}

/// <summary>
/// A platform-wide setting — provider credentials and switches the super admin
/// manages from the console rather than from .env. Secrets are stored but
/// never returned by the API; a GET only says whether one is set.
/// </summary>
public class PlatformSetting
{
    [MaxLength(100)] public required string Key { get; set; }
    public required string Value { get; set; }
    public bool IsSecret { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? UpdatedBy { get; set; }
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
