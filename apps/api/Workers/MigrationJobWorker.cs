using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Migration;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Runs Google Workspace migration jobs (migration.jobs). The work itself is
/// in MigrationJobRunner; this is only the loop and the organisations.
///
/// ─────────────────────────────────────────────────────────────────────────
///  OFF unless Migration:Runner is "on". Nothing creates a job yet; when
///  something does, switching this on is a decision, made where it can be
///  seen, not a consequence of deploying.
///
///  ONE ORGANISATION AT A TIME, IN ITS OWN SCOPE (the CalendarReminderWorker
///  pattern, decision 0007). The only cross-organisation question - who has a
///  job ready - goes to migration.job_tenants(), a SECURITY DEFINER function
///  returning ids only. Each organisation then gets a fresh scope, its own
///  AppDbContext and TenantContext, and its jobs are read and written under
///  RLS like any signed-in request. IgnoreQueryFilters() would not switch RLS
///  off and must not be reached for: with no tenant set the forced policies
///  show nothing, and "nothing to do" is not an error - which is how the
///  reminder worker sent nothing for six weeks.
///
///  An organisation's turn is capped at Migration:SliceSeconds, then the next
///  one goes, so a 40,000-message mailbox does not hold up everyone else's.
///
///  The owner name written into each lease is machine, process and a random
///  part: a restarted process is a different owner, so it can never mistake
///  the dead process's lease for its own.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MigrationJobWorker(
    IServiceScopeFactory scopes,
    IConfiguration config,
    ILogger<MigrationJobWorker> log) : BackgroundService
{
    private readonly string _owner =
        $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid().ToString("N")[..8]}";

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        if (!string.Equals((config["Migration:Runner"] ?? "off").Trim(), "on", StringComparison.OrdinalIgnoreCase))
        {
            log.LogInformation("Migration job runner is off (Migration:Runner)");
            return;
        }

        var tick = TimeSpan.FromSeconds(Math.Clamp(config.GetValue("Migration:TickSeconds", 15), 1, 3600));
        log.LogInformation("Migration job runner on, as {Owner}, every {Tick}", _owner, tick);

        while (!stopping.IsCancellationRequested)
        {
            try { await SweepAsync(stopping); }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                log.LogError("Migration sweep failed: {Error}", MigrationJobRunner.Describe(ex));
            }

            try { await Task.Delay(tick, stopping); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SweepAsync(CancellationToken stopping)
    {
        List<Guid> tenants;
        using (var scope0 = scopes.CreateScope())
        {
            var db0 = scope0.ServiceProvider.GetRequiredService<AppDbContext>();
            tenants = await db0.Database
                .SqlQuery<Guid>($"""SELECT tenant_id AS "Value" FROM migration.job_tenants()""")
                .ToListAsync(stopping);
        }

        foreach (var tenantId in tenants)
        {
            if (stopping.IsCancellationRequested) return;
            // One organisation's failure must not cost the others their turn.
            try
            {
                using var scope = scopes.CreateScope();
                var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                tenant.EnterAnonymousScope(tenantId, "system");
                await db.SyncTenantAsync(stopping);

                var runner = scope.ServiceProvider.GetRequiredService<MigrationJobRunner>();
                await runner.RunOrganisationAsync(_owner, stopping);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                log.LogError("Migration sweep failed for organisation {TenantId}: {Error}",
                    tenantId, MigrationJobRunner.Describe(ex));
            }
        }
    }
}
