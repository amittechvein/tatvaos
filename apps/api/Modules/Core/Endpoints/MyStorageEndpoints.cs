using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// "How much room do I have left?" — one answer, for every product.
///
/// ─────────────────────────────────────────────────────────────────────────
///  This is the endpoint every rail meter reads and the account page expands.
///  It exists because the meters used to disagree: Mail showed a mailbox
///  quota, Space showed the organisation's pool, and a customer given "30 GB"
///  could find neither number.
///
///  Any signed-in person may read their OWN figure — deliberately not
///  admin-gated. Knowing how full you are is not an administrative privilege,
///  and a meter that 403s for employees is a meter that does not exist.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MyStorageEndpoints
{
    public static void MapMyStorageEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/account/storage", MineAsync)
           .RequireAuthorization("User")
           .WithTags("Account");
    }

    public sealed record ProductUsage(string Code, string Name, long UsedBytes);

    private sealed record UsageRow(string ProductCode, long UsedBytes);

    private static async Task<IResult> MineAsync(
        AppDbContext db, TenantContext tenant, StorageAllocator storage, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == uid)
            .Select(u => new { u.DepartmentId, u.StorageQuotaBytes })
            .FirstOrDefaultAsync(ct);

        if (user is null) return Results.NotFound();

        // The per-product split comes from ONE SQL function, so the products
        // cannot drift apart in how they count themselves.
        var rows = await db.Database
            .SqlQuery<UsageRow>($"SELECT product_code AS \"ProductCode\", used_bytes AS \"UsedBytes\" FROM core.user_storage_usage({uid})")
            .ToListAsync(ct);

        // No explicit allowance means inherit — department, then organisation.
        // Resolved here rather than in SQL because that inheritance already
        // lives in StorageAllocator and two copies of it would disagree.
        var quota = user.StorageQuotaBytes
                    ?? await storage.ResolveQuotaAsync(tenant.TenantId, user.DepartmentId, null, "mail", ct);

        var used = rows.Sum(r => r.UsedBytes);

        // Names come from the catalogue, so a product renamed there is renamed
        // here — "TatvaOS Drive" became "TatvaOS Space" and this must follow.
        var names = await db.Products.AsNoTracking()
            .ToDictionaryAsync(p => p.Code, p => p.Name, ct);

        var products = rows
            .Select(r => new ProductUsage(
                r.ProductCode,
                names.GetValueOrDefault(r.ProductCode, r.ProductCode),
                r.UsedBytes))
            // Heaviest first: the person asking is looking for what to delete.
            .OrderByDescending(p => p.UsedBytes)
            .ToList();

        return Results.Ok(new
        {
            quotaBytes = quota,
            usedBytes = used,
            availableBytes = Math.Max(0, quota - used),
            usedFraction = quota > 0 ? (double)used / quota : 0,
            isWarning = quota > 0 && used >= quota * 0.8,
            isCritical = quota > 0 && used >= quota * 0.95,
            products,
            // Said once, here, so every surface can repeat it verbatim rather
            // than inventing its own wording for the same fact.
            note = "This is your total across all TatvaOS products. "
                 + "Shared mailboxes and organisation files are not counted against you.",
        });
    }
}
