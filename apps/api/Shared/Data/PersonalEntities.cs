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
/// One AI trial per phone fingerprint, ever (build plan D6, §8). Outlives the
/// account: UserId goes null on deletion, the row stays. Part D starts it.
/// </summary>
public class AiTrial
{
    [MaxLength(64)] public required string PhoneHash { get; set; }
    public Guid? UserId { get; set; }
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset EndsAt { get; set; }
    /// <summary>The day-12 reminder went out (§5). Set once.</summary>
    public DateTimeOffset? RemindedAt { get; set; }
    /// <summary>The "your trial has ended" note went out. Set once.</summary>
    public DateTimeOffset? EndedNoticeAt { get; set; }
}

/// <summary>
/// One person turned away because a personal host's meeting was full (build
/// plan §4.5). Read by the host's lobby poll. Table:
/// connect.capacity_refusals (20260926-zzz-personal-limits.sql).
/// </summary>
public class ConnectCapacityRefusal
{
    public long Id { get; set; }
    public Guid MeetingId { get; set; }
    public Guid TenantId { get; set; }
    public int Allowed { get; set; }
    public DateTimeOffset RefusedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A personal account's OWN AI switch (build plan D3). The house has no
/// organisation-level AI; this is the consent. ConfirmedAt is when they
/// confirmed that content goes to a service in the United States — kept when
/// they switch off. Table: 20260926-zzz-personal-limits.sql.
/// </summary>
public class PersonalAiConsent
{
    public Guid UserId { get; set; }
    public bool Enabled { get; set; }
    public DateTimeOffset? ConfirmedAt { get; set; }
    public DateTimeOffset ChangedAt { get; set; } = DateTimeOffset.UtcNow;
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

    // ---- Lifecycle (build plan §8; 20260926-zzzz-personal-lifecycle.sql) ----
    public DateTimeOffset? DeletionRequestedAt { get; set; }
    /// <summary>When the purge runs. Set by self-delete (+7 days), the operator, or the inactive rule.</summary>
    public DateTimeOffset? DeleteAfter { get; set; }
    /// <summary>"self", "operator" or "inactive".</summary>
    [MaxLength(32)] public string? DeletionReason { get; set; }
    public DateTimeOffset? InactiveWarnedAt { get; set; }
    public DateTimeOffset? InactiveFinalWarnedAt { get; set; }
    /// <summary>Suspended for abuse: can sign in and download, cannot send.</summary>
    public DateTimeOffset? SuspendedAt { get; set; }
    public string? SuspendedReason { get; set; }
    public Guid? SuspendedBy { get; set; }
}

/// <summary>An address a deleted personal account used, held so nobody receives the old owner's mail.</summary>
public class AddressHold
{
    [MaxLength(320)] public required string Address { get; set; }
    public DateTimeOffset HeldUntil { get; set; }
    public required string Reason { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A file a purge could not remove; retried. A 'maildir' one keeps its address held.</summary>
public class PurgeLeftover
{
    public long Id { get; set; }
    [MaxLength(16)] public required string Kind { get; set; }
    public required string Ref { get; set; }
    [MaxLength(320)] public string? Address { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
