using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  Personal accounts (/join). Tables: 20260926-a-personal-join.sql.
//  Build plan: personal-plans-build-plan.md §2.1, §2.4, §3.
// ============================================================================

/// <summary>
/// An address nobody may sign up for. Refused with "that address isn't
/// available", never "reserved" (§3.2). Removal is soft — the migration
/// re-seeds the starter list on every deploy and a hard delete would be
/// undone by the next one.
/// </summary>
public class ReservedUsername
{
    [MaxLength(64)] public required string Name { get; set; }
    /// <summary>"exact" or "contains".</summary>
    [MaxLength(16)] public string Match { get; set; } = "exact";
    /// <summary>"system", "product", "lookalike" or "other".</summary>
    [MaxLength(16)] public string Category { get; set; } = "other";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset? RemovedAt { get; set; }
    public Guid? RemovedBy { get; set; }
}

/// <summary>
/// A signup in progress. The phone number is held in plain text only while a
/// code may still need sending: nulled on completion, and the whole row
/// deleted a day after it was abandoned.
/// </summary>
public class PersonalSignup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    [MaxLength(64)] public required string LocalPart { get; set; }
    [MaxLength(200)] public required string DisplayName { get; set; }
    [MaxLength(32)] public string? Phone { get; set; }
    [MaxLength(64)] public required string PhoneHash { get; set; }
    public DateTimeOffset AdultDeclaredAt { get; set; }
    [MaxLength(64)] public string? CodeHash { get; set; }
    public DateTimeOffset? CodeSentAt { get; set; }
    public int CodeAttempts { get; set; }
    public DateTimeOffset? PhoneVerifiedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
    public Guid? CompletedUserId { get; set; }
}

/// <summary>One code sent or refused. A keyed hash of the number, never the number.</summary>
public class PersonalSignupAttempt
{
    public long Id { get; set; }
    [MaxLength(64)] public string? PhoneHash { get; set; }
    [MaxLength(64)] public string? Ip { get; set; }
    [MaxLength(32)] public required string Outcome { get; set; }
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// What is true of a personal account and of no organisation account: the
/// phone fingerprint (one personal account per number), when the person
/// declared they are an adult (never their date of birth), and which terms
/// they accepted.
/// </summary>
public class PersonalAccount
{
    public Guid UserId { get; set; }
    public Guid TenantId { get; set; }
    [MaxLength(64)] public required string PhoneHash { get; set; }
    public DateTimeOffset AdultDeclaredAt { get; set; }
    [MaxLength(32)] public required string TermsVersion { get; set; }
    [MaxLength(32)] public required string PrivacyVersion { get; set; }
    public DateTimeOffset TermsAcceptedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
