using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

/// <summary>
/// One feature inside a module (core.features, 20260926-plan-features.sql).
/// Changed by a migration, never by an operator. ProductCode null = platform
/// wide (AI spans every module).
/// </summary>
public class Feature
{
    [MaxLength(64)] public required string Code { get; set; }
    [MaxLength(32)] public string? ProductCode { get; set; }
    public required string Name { get; set; }
    public string? Description { get; set; }
    /// <summary>"switch" = included or not; "limit" = a number, none = no limit.</summary>
    public string Kind { get; set; } = "switch";
    public string? Unit { get; set; }
    public int SortOrder { get; set; } = 100;
}

/// <summary>A plan's number for one "limit" feature. No row = no limit.</summary>
public class PlanFeatureLimit
{
    public Guid PlanId { get; set; }
    [MaxLength(64)] public required string FeatureCode { get; set; }
    public long LimitValue { get; set; }
}

/// <summary>
/// A per-organisation exception: grant a feature the plan lacks, revoke one it
/// has (a hold - a revoke beats everything, keeps_everything included), or set
/// a different number. Who and why are required; expiry is read in the query.
/// </summary>
public class FeatureOverride
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    [MaxLength(64)] public required string FeatureCode { get; set; }
    /// <summary>grant | revoke | limit</summary>
    public required string Mode { get; set; }
    public long? LimitValue { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public Guid GrantedBy { get; set; }
    public required string Reason { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? WithdrawnAt { get; set; }
}
