using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Ends the 48-hour hold on recovery emails an administrator set (decision
/// 0009): once a hold is due, the new address becomes the recovery address.
///
/// HOW IT CROSSES ORGANISATIONS (the 0007 worker rule, after the calendar
/// reminder incident): through core.apply_due_recovery_changes(), a SECURITY
/// DEFINER function. It never reads a forced-RLS table without a tenant, so it
/// cannot see "nothing due" by mistake. The function returns how many it
/// applied; a non-zero count is logged, so a hold that ended leaves a trace.
/// tests/recovery-admin/test-admin-recovery-email.sh runs this worker with a
/// hold due and checks the address moved.
/// </summary>
public sealed class RecoveryHoldWorker(IServiceScopeFactory scopes, ILogger<RecoveryHoldWorker> log)
    : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(30), stopping); }
        catch (OperationCanceledException) { return; }

        while (!stopping.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                // AS "Value" is EF's required alias for a scalar SqlQuery.
                var applied = (await db.Database
                    .SqlQuery<int>($"""SELECT core.apply_due_recovery_changes() AS "Value" """)
                    .ToListAsync(stopping)).FirstOrDefault();
                if (applied > 0)
                    log.LogInformation("Recovery email holds ended: {Count} applied", applied);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Recovery hold sweep failed");
            }

            try { await Task.Delay(Tick, stopping); }
            catch (OperationCanceledException) { break; }
        }
    }
}
