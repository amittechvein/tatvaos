using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// Answers the storage and seat questions for an organisation.
///
/// Two allocation models exist because they suit different customers and price
/// differently:
///
///   per_user  Each mailbox has its own fixed quota. Predictable, bills
///             cleanly per seat, easy to explain to a customer. Commits far
///             more storage than is used when consumption is uneven.
///
///   pooled    One allocation shared by every mailbox. A school with 200
///             students at 2 GB and 40 staff at 15 GB needs about 1 TB; the
///             same school on a flat 20 GB per-user quota commits 4.8 TB.
///             Cheaper, but when the pool fills, EVERY mailbox stops
///             receiving at once — which is why the warning thresholds below
///             matter more under this model than under the other.
///
/// All of this lives here rather than in an endpoint so that the web app, the
/// admin console, the delivery path and the billing job all reach the same
/// answer. Quota logic scattered across call sites is how a mailbox ends up
/// accepting mail it has no room for.
/// </summary>
public sealed class StorageAllocator(AppDbContext db)
{
    public const long DefaultPerUserQuota = 15L * 1024 * 1024 * 1024;

    /// <summary>Warn the admin here. Well below the point of failure.</summary>
    public const double WarnThreshold = 0.80;
    /// <summary>Block new mailboxes here, while existing mail still flows.</summary>
    public const double CriticalThreshold = 0.95;

    public sealed record Capacity(
        long TotalBytes,
        long UsedBytes,
        long AvailableBytes,
        double UsedFraction,
        bool IsWarning,
        bool IsCritical,
        int UserCount,
        int? MaxUsers,
        bool CanAddUser,
        string? Reason);

    public async Task<Capacity> GetCapacityAsync(Guid tenantId, CancellationToken ct = default)
    {
        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == tenantId, ct)
            ?? throw new InvalidOperationException($"Tenant {tenantId} not found");

        var userCount = await db.Mailboxes.CountAsync(m => m.Type == "user", ct);
        var usedBytes = await db.Mailboxes.SumAsync(m => m.UsedBytes, ct);

        long totalBytes = org.StorageModel == "pooled"
            ? org.PooledStorageBytes ?? 0
            // Per-user commits quota × seats. Using MaxUsers rather than the
            // current count means the figure reflects what was SOLD, which is
            // what the customer is paying for.
            : (org.PerUserQuotaBytes ?? DefaultPerUserQuota) * (org.MaxUsers ?? userCount);

        var fraction = totalBytes > 0 ? (double)usedBytes / totalBytes : 0;
        var available = Math.Max(0, totalBytes - usedBytes);

        var (canAdd, reason) = EvaluateCanAddUser(org, userCount, fraction, available);

        return new Capacity(
            TotalBytes: totalBytes,
            UsedBytes: usedBytes,
            AvailableBytes: available,
            UsedFraction: fraction,
            IsWarning: fraction >= WarnThreshold,
            IsCritical: fraction >= CriticalThreshold,
            UserCount: userCount,
            MaxUsers: org.MaxUsers,
            CanAddUser: canAdd,
            Reason: reason);
    }

    private static (bool, string?) EvaluateCanAddUser(
        Tenant org, int userCount, double fraction, long available)
    {
        if (org.Status == "suspended")
            return (false, "Organisation is suspended.");

        if (org.MaxUsers is int max && userCount >= max)
            return (false, $"User limit reached ({max}). Upgrade the plan to add more.");

        if (org.StorageModel == "pooled")
        {
            if (fraction >= CriticalThreshold)
                return (false, "Storage pool is above 95%. Existing mail still flows, but new mailboxes are blocked until space is freed or the allocation is raised.");

            // A new mailbox with nowhere to put its first message is worse
            // than a refusal, because the failure surfaces later and to the
            // wrong person.
            if (available < 100L * 1024 * 1024)
                return (false, "Less than 100 MB remains in the pool.");
        }

        return (true, null);
    }

    /// <summary>
    /// The quota a new mailbox receives.
    ///
    /// Precedence: explicit override, then the category default, then the
    /// organisation setting. Under pooled storage there is no per-mailbox
    /// limit, so the pool size is returned — the mailbox is bounded by the
    /// shared allocation, not by itself.
    /// </summary>
    public async Task<long> ResolveQuotaAsync(
        Guid tenantId, Guid? categoryId, long? explicitQuotaBytes, CancellationToken ct = default)
    {
        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == tenantId, ct)
            ?? throw new InvalidOperationException($"Tenant {tenantId} not found");

        if (org.StorageModel == "pooled")
            return org.PooledStorageBytes ?? DefaultPerUserQuota;

        if (explicitQuotaBytes is long q && q > 0)
            return q;

        if (categoryId is Guid cid)
        {
            var catQuota = await db.UserCategories.AsNoTracking()
                .Where(c => c.Id == cid)
                .Select(c => c.DefaultQuotaBytes)
                .FirstOrDefaultAsync(ct);
            if (catQuota is long cq && cq > 0) return cq;
        }

        return org.PerUserQuotaBytes ?? DefaultPerUserQuota;
    }

    /// <summary>
    /// Whether a mailbox can accept a message of this size.
    ///
    /// Callers must reject with SMTP 452 (temporary) rather than 552
    /// (permanent). A temporary failure makes the sender retry; a permanent
    /// one discards their message. Getting this backwards loses customer mail
    /// and is not recoverable.
    /// </summary>
    public async Task<bool> CanAcceptAsync(Guid mailboxId, long sizeBytes, CancellationToken ct = default)
    {
        var mb = await db.Mailboxes.AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == mailboxId, ct);
        if (mb is null || !mb.IsActive) return false;

        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == mb.TenantId, ct);
        if (org is null || org.Status == "suspended") return false;

        if (org.StorageModel == "pooled")
        {
            var poolUsed = await db.Mailboxes.SumAsync(m => m.UsedBytes, ct);
            return poolUsed + sizeBytes <= (org.PooledStorageBytes ?? 0);
        }

        return mb.UsedBytes + sizeBytes <= mb.QuotaBytes;
    }
}
