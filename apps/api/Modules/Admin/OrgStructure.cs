namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// Where an organisation works — an office, a campus, or "Remote".
///
/// Phase 0 of Hire &amp; People (24 September 2026). A job opening names one;
/// People will read the same rows. Organisation structure, not an HR record,
/// which is why it sits in core beside departments.
/// </summary>
public sealed class OrgLocation
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string Name { get; set; } = "";
    public string? Code { get; set; }
    public string? AddressLine { get; set; }
    public string? City { get; set; }
    public string? State { get; set; }
    public string? PostalCode { get; set; }
    /// <summary>ISO 3166-1 alpha-2, upper case. Defaults to IN.</summary>
    public string Country { get; set; } = "IN";
    /// <summary>A location that is not a place — Remote, Work from home.</summary>
    public bool IsRemote { get; set; }
    /// <summary>False hides it from new choices; everything naming it keeps it.</summary>
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// A job title — "Senior Software Engineer", "PGT Physics".
///
/// NOT A ROLE. <c>core.users.role</c> decides what a person may do in
/// TatvaOS; a designation is what they are called at work. Nothing may ever
/// grant a permission from a designation — that is how a Principal becomes an
/// org_admin by accident.
/// </summary>
public sealed class OrgDesignation
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string Title { get; set; } = "";
    /// <summary>Free-text grade or band, "L3", "E2".</summary>
    public string? Grade { get; set; }
    /// <summary>Seniority for ordering only; higher is more senior.</summary>
    public int? Level { get; set; }
    public string? Description { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
