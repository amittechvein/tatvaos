namespace TatvaOS.Api.Modules.Admin;

/// Request and response shapes. Kept separate from entities so the wire
/// contract can stay stable while the schema evolves.

public sealed record CreateOrganisationRequest(
    string Name,
    string Type,
    string Country,
    string? Phone,
    string? Gstin,
    string AdminName,
    string AdminEmail,
    string PrimaryDomain,
    Guid PlanId,
    string StorageModel,
    int? MaxUsers,
    long? PerUserQuotaBytes,
    long? PooledStorageBytes);

public sealed record OrganisationResponse(
    Guid Id, string Name, string Type, string Status,
    string PrimaryDomain, string StorageModel,
    int? MaxUsers, int UserCount,
    long StorageTotalBytes, long StorageUsedBytes,
    int DomainCount, string? AdminEmail,
    DateTimeOffset CreatedAt, DateTimeOffset? TrialEndsAt,
    // The commercial half. Nullable with defaults because an organisation can
    // exist without a subscription row (early manual creations did).
    Guid? PlanId = null, string? PlanName = null,
    string? SubscriptionStatus = null, int? Seats = null,
    // The owner's name, so the list can say WHO runs each org, not just an
    // email — the thing an operator scans for first.
    string? AdminName = null, string? Phone = null, string? Gstin = null);

/// <summary>Change which package an organisation is on.</summary>
public sealed record ChangePlanRequest(Guid PlanId, int? Seats);

/// <summary>Create or edit a plan in the catalogue.</summary>
public sealed record UpsertPlanRequest(
    string Name,
    int? MaxUsers,
    string StorageModel,          // "per_user" | "pooled"
    long? PerUserQuotaBytes,
    long? PooledStorageBytes,
    int? MaxDomains,
    string[]? IncludedProducts,
    decimal? PricePerUserMonthly,
    decimal? PriceMonthly);

/// <summary>
/// Edit an organisation's identity and owner contact. Every field optional —
/// null leaves it unchanged, so the dialog sends only what the operator
/// touched.
/// </summary>
public sealed record UpdateOrganisationRequest(
    string? Name,
    string? Type,
    string? AdminName,
    string? AdminEmail,
    string? Phone,
    string? Gstin);

/// <param name="Products">
/// Which products to grant. Null falls back to the category's defaults, and
/// then to mail. An empty array is legal and meaningful: a Payroll-only worker
/// who needs a payslip and no email account at all.
/// </param>
public sealed record CreateUserRequest(
    string LocalPart,
    string DisplayName,
    Guid DomainId,
    Guid? DepartmentId,
    long? QuotaBytes,
    string? Password,
    string[]? Products = null,
    // Null falls back to the department's default role, then to employee.
    // org_owner is only grantable by an org_owner — enforced server-side.
    string? Role = null,
    // Decision 0005: with no Password typed, a recovery email is where the
    // invitation goes, and neither means the request is refused. Stored
    // UNVERIFIED until the person follows the link (which proves it).
    string? RecoveryEmail = null,
    string? RecoveryPhone = null);

/// <summary>
/// Editing a person. Every field is optional — null means "leave it alone",
/// so the client sends only what changed and a stale form cannot blank a
/// field it never displayed.
/// </summary>
public sealed record UpdateUserRequest(
    string? DisplayName,
    // Guid.Empty means "remove from their department"; null means unchanged.
    // Two meanings need two values, and null is already taken.
    Guid? DepartmentId,
    string? Role,
    long? QuotaBytes);

/// <summary>
/// A profile photo, as a data URL the browser produces from a cropped image:
/// "data:image/jpeg;base64,...". The API decodes it, checks the type and size,
/// and stores the bytes.
/// </summary>
public sealed record SetAvatarRequest(string DataUrl);

public sealed record BulkCreateUserRequest(
    // The fallback domain, for a file of bare usernames. NULL is normal: a CSV
    // exported from another system carries whole addresses, and each row picks
    // its own domain below. Making the admin ALSO choose one is how a file
    // covering two domains lands entirely on one of them.
    Guid? DomainId,
    // The department for rows that do not name their own. Null = none.
    Guid? DepartmentId,
    IReadOnlyList<BulkUserEntry> Users,
    // Validate and report only: nothing is written, no password is minted, no
    // welcome mail goes out. The UI refuses to create a batch the admin has
    // not seen this report for.
    bool DryRun = false);

// Department by NAME, as the admin's spreadsheet has it ("Class 5A"). Null
// falls back to the request's DepartmentId. An unknown or ambiguous name
// skips the row with a reason — it never silently lands in no department.
public sealed record BulkUserEntry(
    string LocalPart,
    string DisplayName,
    string? Department = null,
    // The part after the @, when the row carried a whole address. Must be a
    // VERIFIED domain of this organisation; anything else skips the row.
    string? Domain = null,
    // Blank means generate one. A supplied password must satisfy the same
    // PasswordPolicy the change-password screen enforces, or the person cannot
    // later set the password they were given.
    string? Password = null,
    // Stored UNVERIFIED. An imported address is the admin's claim, not the
    // person's proof, and a typo that arrives pre-verified is a working
    // account-recovery route into someone else's mailbox.
    string? RecoveryEmail = null,
    string? RecoveryPhone = null,
    // Honoured only when a password was supplied. A password WE generated is a
    // handover credential and is always forced, whatever the column says.
    bool? MustChangePassword = null);

/// <param name="Id">The core.users id — the person, not the mailbox.</param>
/// <param name="MailboxAddress">
/// Null when the person has no mailbox. That is a normal state, not an error.
/// </param>
public sealed record UserResponse(
    Guid Id, string Email, string DisplayName,
    string? MailboxAddress,
    Guid? DepartmentId, string? DepartmentName,
    string Role, string Status,
    string[] Products,
    long QuotaBytes, long UsedBytes,
    bool MfaEnabled, DateTimeOffset? LastLoginAt, DateTimeOffset CreatedAt,
    bool HasVerifiedRecoveryEmail = false,
    // Whether a profile photo exists. The list carries only the flag, never the
    // bytes — the client fetches the image from /org/users/{id}/avatar for the
    // rows that have one.
    bool HasAvatar = false,
    // Null when there is nothing to say: never invited, or already in.
    InvitationInfo? Invitation = null);

/// <summary>
/// What the people list shows about a pending invitation (decision 0005).
/// State is "pending", "expired" or "undelivered"; SentTo is the masked
/// recovery address the link went to.
/// </summary>
public sealed record InvitationInfo(string State, DateTimeOffset? SentAt, string? SentTo);

public sealed record CreateDepartmentRequest(
    string Name, string? Description,
    long? DefaultQuotaBytes, string DefaultRole,
    bool CanSendExternal, string[]? AutoGroups, string? Colour,
    string[]? DefaultProducts = null);

public sealed record DomainVerificationResponse(
    Guid DomainId, string Fqdn, bool OwnershipVerified, bool MxVerified,
    IReadOnlyList<RequiredDnsRecord> Records);

public sealed record RequiredDnsRecord(
    string Type, string Host, string Value, string Purpose, bool Satisfied);

/// <summary>Offboarding a leaver. Null means no forwarding — mail bounces.</summary>
public sealed record OffboardRequest(Guid? ForwardToUserId);
