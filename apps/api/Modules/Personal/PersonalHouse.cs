using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
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
public sealed class PersonalHouse(AppDbContext db, IMemoryCache cache)
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

    /// <summary>
    /// The same answer without the service, for handlers that hold only a
    /// DbContext (Space's helpers). One indexed read; uncached on purpose —
    /// these are write paths, not every request.
    /// </summary>
    public static Task<bool> IsHouseTenantAsync(AppDbContext db, Guid tenantId, CancellationToken ct = default) =>
        db.Tenants.AsNoTracking().AnyAsync(t => t.Id == tenantId && t.Kind == KindPersonalHouse, ct);

    /// <summary>Is this tenant the personal house?</summary>
    public async Task<bool> IsPersonalHouseAsync(Guid tenantId, CancellationToken ct = default) =>
        tenantId != Guid.Empty && await HouseIdAsync(ct) == tenantId;

    /// <summary>
    /// The house's tenant id, or null. Cached for a minute: PersonalGuard asks
    /// on EVERY authenticated request, and the answer changes once in the
    /// platform's life (the house is created at switch-on). A minute is how
    /// long a newly created house could go unguarded — and nobody can be in it
    /// yet, because /join stays closed until an operator opens it afterwards.
    /// </summary>
    public async Task<Guid?> HouseIdAsync(CancellationToken ct = default) =>
        await cache.GetOrCreateAsync("personal-house-id", async e =>
        {
            e.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(1);
            return await db.Tenants.AsNoTracking()
                .Where(t => t.Kind == KindPersonalHouse)
                .Select(t => (Guid?)t.Id)
                .FirstOrDefaultAsync(ct);
        });
}
