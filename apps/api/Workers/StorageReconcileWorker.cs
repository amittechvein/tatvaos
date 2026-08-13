using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Keeps core.storage_allocations.used_bytes honest.
///
/// The figure is DERIVED from mail.mailboxes rather than counted up as messages
/// arrive, so it cannot drift — a crash between filing a message and bumping a
/// counter would silently lose a delta forever, and nothing would ever notice.
/// Recomputing from the truth has no such failure mode.
///
/// The storage endpoints also reconcile the one tenant being viewed, so an
/// admin looking at the page always sees an exact figure. This worker exists
/// for everything that reads the number WITHOUT a human present: the add-user
/// gate, the pooled-storage quota check on the delivery path, and billing
/// later. Those must not be the first thing to notice a stale figure.
///
/// Every fifteen minutes is deliberate. The number moves slowly (mailboxes grow
/// over days), the pass is one GROUP BY across the platform, and the thresholds
/// it feeds are 80% and 95% — none of which turn on a quarter of an hour.
/// </summary>
public sealed class StorageReconcileWorker(
    IServiceScopeFactory scopeFactory, ILogger<StorageReconcileWorker> log)
    : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Long enough for the API to finish starting and for the schema to have
    /// been applied. Reconciling in the first seconds of boot competes with
    /// startup for the connection pool and buys nothing.
    /// </summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(StartupDelay, ct);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        log.LogInformation(
            "Storage reconcile running every {Minutes} minutes", Interval.TotalMinutes);

        using var timer = new PeriodicTimer(Interval);

        do
        {
            try
            {
                // Its own scope per pass: a BackgroundService is a singleton and
                // AppDbContext is scoped, so holding one across the lifetime of
                // the worker would leak a connection and accumulate tracked
                // entities for as long as the process runs.
                using var scope = scopeFactory.CreateScope();
                var storage = scope.ServiceProvider.GetRequiredService<StorageAllocator>();

                var rows = await storage.ReconcileUsageAsync(null, ct);

                // Only worth a line when something actually moved. A quiet
                // platform logging "0 rows" four times an hour is noise that
                // trains people to skim past this component's real messages.
                if (rows > 0)
                    log.LogInformation("Storage reconcile updated {Rows} allocation row(s)", rows);

                // Warnings run AFTER reconcile, in the same pass, so they are
                // judged on figures that were just made correct rather than on
                // whatever the last cycle left behind.
                await WarnAsync(scope, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Never let one bad pass kill the worker. The next tick retries,
                // and a permanently broken reconcile shows up as a stale figure
                // rather than as storage silently ceasing to be measured.
                log.LogError(ex, "Storage reconcile pass failed; retrying next interval");
            }
        }
        while (await timer.WaitForNextTickAsync(ct));
    }

    // =====================================================================
    //  WARNING THE ADMIN BEFORE THE POOL FILLS
    // =====================================================================
    //
    //  StorageAllocator has carried thresholds at 80% and 95% from the start,
    //  and nothing ever acted on them — the console painted a colour and no
    //  one was told. The first thing a customer learned about their storage
    //  was that mail had stopped.
    //
    //  Under POOLED storage that failure is not gradual: one number crosses a
    //  line and every mailbox in the organisation stops accepting mail at the
    //  same moment. A warning that arrives afterwards is a post-mortem.
    //
    //  Sent ONCE per threshold crossed, tracked by storage_pools.warned_level.
    //  Repeating every fifteen minutes is how an alert becomes a filter rule.
    // =====================================================================
    private async Task WarnAsync(IServiceScope scope, CancellationToken ct)
    {
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var storage = scope.ServiceProvider.GetRequiredService<StorageAllocator>();
        var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();

        // Cross-tenant: core.tenants carries no RLS, so the live list can be
        // read before any tenant context is set.
        var tenants = await db.Tenants.AsNoTracking()
            .Where(t => t.Status == "active" || t.Status == "trial")
            .Select(t => new { t.Id, t.Name })
            .ToListAsync(ct);

        var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');

        foreach (var org in tenants)
        {
            if (ct.IsCancellationRequested) return;

            try
            {
                // Per tenant, because capacity depends on the plan's seat count
                // and the pool's model — neither expressible in one query
                // across every organisation.
                tenant.EnterPlatformScope(org.Id, actingUserId: Guid.Empty);
                await db.SyncTenantAsync(ct);

                var capacity = await storage.GetCapacityAsync(org.Id, "mail", ct);
                var level = capacity.IsCritical ? "critical" : capacity.IsWarning ? "warn" : null;

                var pool = await db.StoragePools.FirstOrDefaultAsync(p => p.TenantId == org.Id, ct);
                if (pool is null) continue;

                // Below every threshold: clear the marker so a later refill
                // warns again. A one-time-ever alert is worse than none —
                // people free space, fill up again, and hear nothing.
                if (level is null)
                {
                    if (pool.WarnedLevel is not null)
                    {
                        pool.WarnedLevel = null;
                        await db.SaveChangesAsync(ct);
                    }
                    continue;
                }

                // Already told them at this level or higher. "critical" ranks
                // above "warn", so falling from critical to warn does not
                // re-send — the situation improved, which is not news.
                if (pool.WarnedLevel == level || pool.WarnedLevel == "critical") continue;

                var admins = await db.Users.AsNoTracking()
                    .Where(u => u.Status == "active"
                                && (u.Role == "org_owner" || u.Role == "org_admin"))
                    .Select(u => new { u.Email, u.DisplayName })
                    .ToListAsync(ct);

                if (admins.Count == 0)
                {
                    // Worth a log line: an organisation with no reachable admin
                    // cannot be warned at all, and that is a support problem
                    // rather than a quiet no-op.
                    log.LogWarning("{Org} is at {Level} storage but has no active administrator to warn",
                        org.Name, level);
                    continue;
                }

                var percent = (int)Math.Round(capacity.UsedFraction * 100);
                var critical = level == "critical";
                var pooled = capacity.StorageModel == "pooled";

                foreach (var admin in admins)
                {
                    await mailer.SendHtmlAsync(
                        admin.Email,
                        StorageWarningEmail.Subject(org.Name, percent, critical),
                        StorageWarningEmail.Html(
                            admin.DisplayName, org.Name, baseUrl, percent, critical, pooled,
                            Bytes(capacity.UsedBytes), Bytes(capacity.TotalBytes)),
                        from: "no_reply@tatvaos.com", ct);
                }

                // Marked only AFTER the sends. If mail throws, the level stays
                // unset and the next pass tries again — the failure mode is a
                // duplicate warning rather than a silent one.
                pool.WarnedLevel = level;
                await db.SaveChangesAsync(ct);

                log.LogInformation("Warned {Count} administrator(s) of {Org}: storage {Percent}% ({Level})",
                    admins.Count, org.Name, percent, level);
            }
            catch (Exception ex)
            {
                // One bad tenant must not stop the rest being warned.
                log.LogError(ex, "Storage warning failed for {Org}", org.Name);
            }
        }
    }

    /// <summary>Human-readable size for the email body.</summary>
    private static string Bytes(long b)
    {
        const long GB = 1024L * 1024 * 1024;
        if (b >= 1024L * GB) return $"{b / (double)(1024L * GB):0.#} TB";
        if (b >= GB) return $"{b / (double)GB:0.#} GB";
        return $"{b / (1024.0 * 1024):0} MB";
    }
}
