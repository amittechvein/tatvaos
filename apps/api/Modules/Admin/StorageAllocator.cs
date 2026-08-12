using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Admin;

/// <summary>
/// Answers the storage and seat questions for an organisation.
///
/// Storage is a CORE concern, not a Mail one. The customer buys one number and
/// their admin splits it across products — 1.5 TB to Mail, 0.5 TB to Drive,
/// rebalanced whenever they like. This class reads core.storage_pools and
/// core.storage_allocations and answers per product, so Drive can ask the same
/// questions later without any of this being rewritten.
///
/// Two allocation models exist because they suit different customers and price
/// differently:
///
///   per_user  Each user has their own fixed quota. Predictable, bills cleanly
///             per seat, easy to explain. Commits far more storage than is
///             used when consumption is uneven.
///
///   pooled    One allocation shared by everyone. A school with 200 students
///             at 2 GB and 40 staff at 15 GB needs about 1 TB; the same school
///             on a flat 20 GB per-user quota commits 4.8 TB. Cheaper, but
///             when the pool fills EVERY mailbox stops receiving at once —
///             which is why the warning thresholds matter more here.
///
/// All of it lives in one place so the web app, the admin console, the
/// delivery path and the billing job reach the same answer. Quota logic
/// scattered across call sites is how a mailbox ends up accepting mail it has
/// no room for.
/// </summary>
public sealed class StorageAllocator(AppDbContext db)
{
    public const long DefaultPerUserQuota = 15L * 1024 * 1024 * 1024;

    /// <summary>Warn the admin here. Well below the point of failure.</summary>
    public const double WarnThreshold = 0.80;
    /// <summary>Block new users here, while existing mail still flows.</summary>
    public const double CriticalThreshold = 0.95;

    public sealed record Capacity(
        string StorageModel,
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

    /// <summary>
    /// Recomputes core.storage_allocations.used_bytes from the mailbox figures,
    /// which are the source of truth. Pass null to reconcile every tenant.
    ///
    /// See 17-storage-usage.sql for why this is a database function: it crosses
    /// tenants in one statement, it keeps the fix out of the Mail lane's files,
    /// and a derived figure cannot drift the way an incremental counter does.
    ///
    /// Cheap enough to call on a page load — it is one GROUP BY over one
    /// tenant's mailboxes — which is why the storage endpoints call it before
    /// reading. Opening the storage page repairs that organisation's number.
    /// </summary>
    public async Task<int> ReconcileUsageAsync(Guid? tenantId, CancellationToken ct = default)
        => await db.Database
            .SqlQuery<int>($"SELECT core.reconcile_storage_usage({tenantId}) AS \"Value\"")
            .FirstOrDefaultAsync(ct);

    public async Task<Capacity> GetCapacityAsync(
        Guid tenantId, string productCode = "mail", CancellationToken ct = default)
    {
        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == tenantId, ct)
            ?? throw new InvalidOperationException($"Tenant {tenantId} not found");

        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == tenantId, ct);

        // Seat limit comes from the plan behind the live subscription, not from
        // a column on the tenant. One place to change when a customer upgrades.
        var maxUsers = await db.Subscriptions.AsNoTracking()
            .Where(s => s.TenantId == tenantId && (s.Status == "active" || s.Status == "trial"))
            .Select(s => s.Plan!.MaxUsers)
            .FirstOrDefaultAsync(ct);

        // People, not mailboxes. A shared support@ mailbox is not a seat, and
        // billing a customer for it would be wrong.
        var userCount = await db.Users.CountAsync(u => u.Status != "deleted", ct);

        var alloc = await db.StorageAllocations.AsNoTracking()
            .FirstOrDefaultAsync(a => a.TenantId == tenantId && a.ProductCode == productCode, ct);

        var model = pool?.StorageModel ?? "per_user";
        long totalBytes;

        if (model == "pooled")
        {
            // An explicit allocation wins. NULL means "draw from whatever is
            // left", so subtract what the other products have claimed.
            if (alloc?.AllocatedBytes is long a)
            {
                totalBytes = a;
            }
            else
            {
                var claimedElsewhere = await db.StorageAllocations.AsNoTracking()
                    .Where(x => x.TenantId == tenantId && x.ProductCode != productCode
                                && x.AllocatedBytes != null)
                    .SumAsync(x => x.AllocatedBytes!.Value, ct);
                totalBytes = Math.Max(0, (pool?.TotalBytes ?? 0) - claimedElsewhere);
            }
        }
        else
        {
            // Per-user commits quota x seats. Using the plan's seat count
            // rather than the current headcount means the figure reflects what
            // was SOLD, which is what the customer is paying for.
            var perUser = pool?.PerUserQuotaBytes ?? DefaultPerUserQuota;
            totalBytes = perUser * (maxUsers ?? userCount);
        }

        // Read, never computed here: this runs on every user-creation check
        // and, via CanAcceptAsync, on every inbound message, so it has to stay
        // O(1). The column is kept honest out of band — see ReconcileUsageAsync
        // and StorageReconcileWorker. Until 17-storage-usage.sql shipped,
        // NOTHING wrote it and this was always zero.
        var usedBytes = alloc?.UsedBytes ?? 0;

        var fraction = totalBytes > 0 ? (double)usedBytes / totalBytes : 0;
        var available = Math.Max(0, totalBytes - usedBytes);

        var (canAdd, reason) = EvaluateCanAddUser(org.Status, model, maxUsers, userCount, fraction, available);

        return new Capacity(
            StorageModel: model,
            TotalBytes: totalBytes,
            UsedBytes: usedBytes,
            AvailableBytes: available,
            UsedFraction: fraction,
            IsWarning: fraction >= WarnThreshold,
            IsCritical: fraction >= CriticalThreshold,
            UserCount: userCount,
            MaxUsers: maxUsers,
            CanAddUser: canAdd,
            Reason: reason);
    }

    private static (bool, string?) EvaluateCanAddUser(
        string orgStatus, string model, int? maxUsers, int userCount, double fraction, long available)
    {
        if (orgStatus == "suspended")
            return (false, "Organisation is suspended.");

        if (maxUsers is int max && userCount >= max)
            return (false, $"User limit reached ({max}). Upgrade the plan to add more.");

        if (model == "pooled")
        {
            if (fraction >= CriticalThreshold)
                return (false, "Storage pool is above 95%. Existing mail still flows, but new users are blocked until space is freed or the allocation is raised.");

            // A new mailbox with nowhere to put its first message is worse than
            // a refusal, because the failure surfaces later and to the wrong
            // person.
            if (available < 100L * 1024 * 1024)
                return (false, "Less than 100 MB remains in the pool.");
        }

        return (true, null);
    }

    /// <summary>
    /// The quota a new mailbox receives.
    ///
    /// Precedence: explicit override, then the category default, then the pool
    /// setting. Under pooled storage there is no per-mailbox limit, so the
    /// product's allocation is returned — the mailbox is bounded by the shared
    /// allocation, not by itself.
    /// </summary>
    public async Task<long> ResolveQuotaAsync(
        Guid tenantId, Guid? departmentId, long? explicitQuotaBytes,
        string productCode = "mail", CancellationToken ct = default)
    {
        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == tenantId, ct);

        if (pool?.StorageModel == "pooled")
        {
            var capacity = await GetCapacityAsync(tenantId, productCode, ct);
            return capacity.TotalBytes > 0 ? capacity.TotalBytes : DefaultPerUserQuota;
        }

        if (explicitQuotaBytes is long q && q > 0)
            return q;

        // Walks UP the department tree until it finds a value — a team with no
        // quota of its own takes its parent's, and its parent's parent's after
        // that. Resolved in SQL because the users list needs it per row, and a
        // walk per person in C# is one query each on a screen built for four
        // hundred people.
        if (departmentId is Guid did)
        {
            var inherited = await db.Database
                .SqlQuery<long?>($"SELECT core.department_effective_quota({did}) AS \"Value\"")
                .FirstOrDefaultAsync(ct);
            if (inherited is long iq && iq > 0) return iq;
        }

        return pool?.PerUserQuotaBytes ?? DefaultPerUserQuota;
    }

    /// <summary>
    /// Whether a mailbox can accept a message of this size.
    ///
    /// Callers must reject with SMTP 452 (temporary) rather than 552
    /// (permanent). A temporary failure makes the sender retry; a permanent one
    /// discards their message. Getting this backwards loses customer mail and
    /// is not recoverable.
    /// </summary>
    public async Task<bool> CanAcceptAsync(Guid mailboxId, long sizeBytes, CancellationToken ct = default)
    {
        var mb = await db.Mailboxes.AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == mailboxId, ct);
        if (mb is null || !mb.IsActive) return false;

        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == mb.TenantId, ct);
        if (org is null || org.Status == "suspended") return false;

        // A suspended person stops receiving. A shared mailbox has no person
        // behind it and is governed by the mailbox row alone.
        if (mb.UserId is Guid uid)
        {
            var userActive = await db.Users.AsNoTracking()
                .AnyAsync(u => u.Id == uid && u.Status == "active", ct);
            if (!userActive) return false;
        }

        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == mb.TenantId, ct);

        if (pool?.StorageModel == "pooled")
        {
            var alloc = await db.StorageAllocations.AsNoTracking()
                .FirstOrDefaultAsync(a => a.TenantId == mb.TenantId && a.ProductCode == "mail", ct);
            var cap = alloc?.AllocatedBytes ?? pool.TotalBytes;
            return (alloc?.UsedBytes ?? 0) + sizeBytes <= cap;
        }

        return mb.UsedBytes + sizeBytes <= mb.QuotaBytes;
    }
}
