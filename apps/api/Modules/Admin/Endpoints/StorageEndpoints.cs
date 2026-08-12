using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Storage, as an organisation's own administrator sees it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE ONE QUESTION THIS SCREEN EXISTS TO ANSWER.
///
///  "Am I going to run out, and who is using it all?" Everything here serves
///  that: total against used, the two thresholds, and the people sorted
///  heaviest-first so the answer is the top of the list rather than a search.
///
///  READING THIS PAGE REPAIRS THE NUMBER. Every read reconciles this tenant's
///  roll-up first (see 17-storage-usage.sql). It costs one GROUP BY over one
///  organisation's mailboxes and means an admin is never shown a stale figure
///  — which matters more here than anywhere else in the console, because the
///  whole point of the screen is to be trusted about a number.
///
///  Storage is a CORE concern, not a Mail one: the customer buys one figure
///  and splits it across products. These endpoints therefore live in Core and
///  report per product, so Drive slots in later without any of this changing.
///  Nothing here touches the Mail lane's files.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class StorageEndpoints
{
    public static void MapStorageEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/storage")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", OverviewAsync);
        g.MapGet("/users", ByUserAsync);
        g.MapPut("/allocations/{productCode}", SetAllocationAsync);
    }

    // ------------------------------------------------------------------
    public sealed record ProductUsage(
        string ProductCode,
        string ProductName,
        long? AllocatedBytes,
        long UsedBytes,
        double UsedFraction);

    public sealed record Overview(
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
        string? Reason,
        long? PerUserQuotaBytes,
        List<ProductUsage> Products);

    private static async Task<IResult> OverviewAsync(
        AppDbContext db, StorageAllocator storage, TenantContext tenant, CancellationToken ct)
    {
        // Repair before reading — see the class comment.
        await storage.ReconcileUsageAsync(tenant.TenantId, ct);

        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);

        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == tenant.TenantId, ct);

        var allocations = await db.StorageAllocations.AsNoTracking()
            .Select(a => new { a.ProductCode, a.AllocatedBytes, a.UsedBytes })
            .ToListAsync(ct);

        // Names come from core.products so the page never hard-codes a product
        // list — adding Drive to that table is enough to make it appear here.
        var names = await db.Products.AsNoTracking()
            .ToDictionaryAsync(p => p.Code, p => p.Name, ct);

        var products = allocations
            .Select(a =>
            {
                // Measured against its own allocation where it has one, else
                // against the pool it draws from. A product with neither shows
                // zero rather than dividing by it.
                var cap = a.AllocatedBytes ?? pool?.TotalBytes ?? 0;

                return new ProductUsage(
                    ProductCode: a.ProductCode,
                    ProductName: names.GetValueOrDefault(a.ProductCode, a.ProductCode),
                    AllocatedBytes: a.AllocatedBytes,
                    UsedBytes: a.UsedBytes,
                    UsedFraction: cap > 0 ? (double)a.UsedBytes / cap : 0);
            })
            .OrderByDescending(p => p.UsedBytes)
            .ToList();

        return Results.Ok(new Overview(
            StorageModel: capacity.StorageModel,
            TotalBytes: capacity.TotalBytes,
            UsedBytes: capacity.UsedBytes,
            AvailableBytes: capacity.AvailableBytes,
            UsedFraction: capacity.UsedFraction,
            IsWarning: capacity.IsWarning,
            IsCritical: capacity.IsCritical,
            UserCount: capacity.UserCount,
            MaxUsers: capacity.MaxUsers,
            CanAddUser: capacity.CanAddUser,
            Reason: capacity.Reason,
            PerUserQuotaBytes: pool?.PerUserQuotaBytes,
            Products: products));
    }

    // ------------------------------------------------------------------
    public sealed record UserUsage(
        Guid? UserId,
        string Address,
        string? DisplayName,
        bool IsShared,
        long UsedBytes,
        long QuotaBytes,
        double UsedFraction);

    /// <summary>
    /// Who is using the space, heaviest first.
    ///
    /// Ordered that way because the question behind this list is always "who do
    /// I talk to about freeing space" — and the answer is the top few rows.
    /// Alphabetical would make an admin read all four hundred.
    ///
    /// Shared mailboxes are included and MARKED. They consume real storage and
    /// leaving them out makes the numbers fail to add up, but they are not
    /// people, so an admin must not go looking for whoever owns support@.
    /// </summary>
    private static async Task<IResult> ByUserAsync(
        AppDbContext db, StorageAllocator storage, TenantContext tenant, CancellationToken ct)
    {
        await storage.ReconcileUsageAsync(tenant.TenantId, ct);

        var boxes = await db.Mailboxes.AsNoTracking()
            .Select(m => new { m.UserId, m.Address, m.UsedBytes, m.QuotaBytes })
            .ToListAsync(ct);

        // One lookup rather than a join per row: the display name lives on the
        // user and a shared mailbox has no user at all.
        var userIds = boxes.Where(b => b.UserId != null).Select(b => b.UserId!.Value).ToList();
        var names = await db.Users.AsNoTracking()
            .Where(u => userIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var rows = boxes
            .Select(b => new UserUsage(
                UserId: b.UserId,
                Address: b.Address,
                DisplayName: b.UserId is Guid id ? names.GetValueOrDefault(id) : null,
                IsShared: b.UserId is null,
                UsedBytes: b.UsedBytes,
                QuotaBytes: b.QuotaBytes,
                UsedFraction: b.QuotaBytes > 0 ? (double)b.UsedBytes / b.QuotaBytes : 0))
            .OrderByDescending(r => r.UsedBytes)
            .ToList();

        return Results.Ok(rows);
    }

    // ------------------------------------------------------------------
    public sealed record SetAllocationRequest(long? AllocatedBytes);

    /// <summary>
    /// Splits the pool across products — 1.5 TB to Mail, 0.5 TB to Drive.
    ///
    /// NULL means "draw from whatever is left", which is the default and the
    /// right answer for a single-product customer.
    ///
    /// The sum of explicit allocations may not exceed the pool. That is checked
    /// HERE rather than by a database constraint because a CHECK cannot see
    /// another table — core.pool_overcommitted() states the same rule in SQL so
    /// the intent survives, but the application is what enforces it.
    /// </summary>
    private static async Task<IResult> SetAllocationAsync(
        string productCode, SetAllocationRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        var code = productCode.Trim().ToLowerInvariant();

        var product = await db.Products.AsNoTracking()
            .FirstOrDefaultAsync(p => p.Code == code, ct);
        if (product is null)
            return Results.NotFound(new { error = $"No product '{code}'." });

        if (req.AllocatedBytes is long b && b < 0)
            return Results.BadRequest(new { error = "An allocation cannot be negative." });

        var pool = await db.StoragePools.AsNoTracking()
            .FirstOrDefaultAsync(p => p.TenantId == tenant.TenantId, ct);

        var existing = await db.StorageAllocations
            .FirstOrDefaultAsync(a => a.TenantId == tenant.TenantId && a.ProductCode == code, ct);

        if (req.AllocatedBytes is long want && pool is not null)
        {
            var claimedElsewhere = await db.StorageAllocations.AsNoTracking()
                .Where(a => a.ProductCode != code && a.AllocatedBytes != null)
                .SumAsync(a => a.AllocatedBytes!.Value, ct);

            if (claimedElsewhere + want > pool.TotalBytes)
                return Results.BadRequest(new
                {
                    error = "That would allocate more than the organisation's total storage.",
                    totalBytes = pool.TotalBytes,
                    alreadyAllocatedBytes = claimedElsewhere,
                    availableBytes = Math.Max(0, pool.TotalBytes - claimedElsewhere),
                });
        }

        // Refused rather than silently accepted: an allocation below what the
        // product is already holding cannot be honoured — the data is already
        // on disk — and pretending otherwise puts the console and reality into
        // disagreement, which is how a "full" mailbox reads as half empty.
        var used = existing?.UsedBytes ?? 0;
        if (req.AllocatedBytes is long limit && limit < used)
            return Results.BadRequest(new
            {
                error = "That is less than the product is already using. Free space first, or set a higher figure.",
                usedBytes = used,
            });

        var before = existing is null ? null : new { existing.AllocatedBytes };

        if (existing is null)
        {
            db.StorageAllocations.Add(new StorageAllocation
            {
                TenantId = tenant.TenantId,
                ProductCode = code,
                AllocatedBytes = req.AllocatedBytes,
                UsedBytes = 0,
                UpdatedAt = DateTimeOffset.UtcNow,
            });
        }
        else
        {
            existing.AllocatedBytes = req.AllocatedBytes;
            existing.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("storage.allocation_changed", "product", code,
            before: before, after: new { req.AllocatedBytes }, ct: ct);

        // Reconciled after the write so the response carries a figure that
        // already reflects the change the admin just made.
        await storage.ReconcileUsageAsync(tenant.TenantId, ct);
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, code, ct);

        return Results.Ok(new
        {
            saved = true,
            productCode = code,
            allocatedBytes = req.AllocatedBytes,
            usedBytes = capacity.UsedBytes,
            availableBytes = capacity.AvailableBytes,
        });
    }
}
