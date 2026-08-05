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
    DateTimeOffset CreatedAt, DateTimeOffset? TrialEndsAt);

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
    string[]? Products = null);

public sealed record BulkCreateUserRequest(
    Guid DomainId,
    Guid? DepartmentId,
    IReadOnlyList<BulkUserEntry> Users);

public sealed record BulkUserEntry(string LocalPart, string DisplayName);

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
    bool MfaEnabled, DateTimeOffset? LastLoginAt, DateTimeOffset CreatedAt);

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
