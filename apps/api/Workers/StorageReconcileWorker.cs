using TatvaOS.Api.Modules.Admin;

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
}
