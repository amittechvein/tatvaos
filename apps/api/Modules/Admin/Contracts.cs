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

public sealed record CreateUserRequest(
    string LocalPart,
    string DisplayName,
    Guid DomainId,
    Guid? CategoryId,
    long? QuotaBytes,
    string? Password);

public sealed record BulkCreateUserRequest(
    Guid DomainId,
    Guid? CategoryId,
    IReadOnlyList<BulkUserEntry> Users);

public sealed record BulkUserEntry(string LocalPart, string DisplayName);

public sealed record UserResponse(
    Guid Id, string Address, string? DisplayName,
    Guid? CategoryId, string? CategoryName,
    string Role, string Status,
    long QuotaBytes, long UsedBytes,
    bool MfaEnabled, DateTimeOffset? LastLoginAt, DateTimeOffset CreatedAt);

public sealed record CreateCategoryRequest(
    string Name, string? Description,
    long? DefaultQuotaBytes, string DefaultRole,
    bool CanSendExternal, string[]? AutoGroups, string? Colour);

public sealed record DomainVerificationResponse(
    Guid DomainId, string Fqdn, bool OwnershipVerified, bool MxVerified,
    IReadOnlyList<RequiredDnsRecord> Records);

public sealed record RequiredDnsRecord(
    string Type, string Host, string Value, string Purpose, bool Satisfied);
