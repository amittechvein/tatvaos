using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The ONE place that answers "is this the personal house?" (build plan
/// §2.1). Everything that behaves differently for personal accounts — the
/// signup here, and later isolation (part C) and limits (part D) — asks this
/// rather than comparing core.tenants.kind inline. Scattered checks are how
/// one surface gets missed, and on the house tenant a missed surface means
/// one stranger seeing another.
/// </summary>
public sealed class PersonalHouse(AppDbContext db)
{
    public const string KindOrganisation = "organisation";
    public const string KindPersonalHouse = "personal_house";

    public sealed record House(Guid TenantId, Guid DomainId, string Domain);

    /// <summary>
    /// The house and the domain its addresses live on, or null when there is
    /// no house, or it has no verified domain. Null means /join is closed —
    /// signing people up to a domain that cannot receive mail would be worse
    /// than not signing them up.
    /// </summary>
    public async Task<House?> GetAsync(CancellationToken ct = default)
    {
        var tenantId = await db.Tenants.AsNoTracking()
            .Where(t => t.Kind == KindPersonalHouse && t.Status == "active")
            .Select(t => (Guid?)t.Id)
            .FirstOrDefaultAsync(ct);
        if (tenantId is null) return null;

        // Cross-tenant on purpose: no tenant is set on an anonymous request.
        // Primary and verified only — an alias or a half-set-up domain is not
        // where new addresses go.
        var domain = await db.Domains.IgnoreQueryFilters().AsNoTracking()
            .Where(d => d.TenantId == tenantId && d.Type == "primary"
                        && d.OwnershipVerifiedAt != null)
            .OrderBy(d => d.CreatedAt)
            .Select(d => new { d.Id, d.Fqdn })
            .FirstOrDefaultAsync(ct);
        return domain is null ? null : new House(tenantId.Value, domain.Id, domain.Fqdn.ToLowerInvariant());
    }

    /// <summary>Is this tenant the personal house?</summary>
    public async Task<bool> IsPersonalHouseAsync(Guid tenantId, CancellationToken ct = default) =>
        tenantId != Guid.Empty &&
        await db.Tenants.AsNoTracking()
            .AnyAsync(t => t.Id == tenantId && t.Kind == KindPersonalHouse, ct);
}
