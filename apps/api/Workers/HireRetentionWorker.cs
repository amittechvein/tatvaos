using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Deletes Hire candidates whose retention period has run out — Amit's
/// decision, 24 September 2026: six months after the decision by default,
/// shorter if the organisation chooses, longer only with the candidate's
/// recorded consent.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHO goes, and the window, live in hire.sweep_expired_candidates()
///  (20260924-e-hire-retention.sql), not here: the rule is in one place and
///  a caller cannot pass a longer or shorter one. This worker only decides
///  WHEN — ten minutes after start, then every six hours. The sweep is
///  idempotent, so a restart (every deploy) or a missed tick changes nothing
///  but timing; a candidate is at most six hours past their date.
///
///  A FAILURE IS LOUD. Unlike a sweep of expired codes, a sweep that stops
///  running means personal data kept longer than promised — quietly. So a
///  failure is logged at Error on every tick until it succeeds, and the
///  count is logged at Information when it does, so "it ran" is visible in
///  the logs rather than inferred from silence.
///
///  Called as tatvaos_app with NO tenant: the function is SECURITY DEFINER
///  and sweeps every organisation in one pass, writing one count-only audit
///  row per organisation. Proven by tests/hire/test-retention.sh.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class HireRetentionWorker(IServiceScopeFactory scopes, ILogger<HireRetentionWorker> log) : BackgroundService
{
    private static readonly TimeSpan StartDelay = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try { await Task.Delay(StartDelay, ct); }
        catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            await SweepAsync(ct);
            try { await Task.Delay(Interval, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var erased = await db.Database
                .SqlQuery<int?>($"""SELECT hire.sweep_expired_candidates() AS "Value" """)
                .SingleAsync(ct);
            // NULL = switched off (platform setting hire.retention_sweep_enabled,
            // Mr. Singh 2 Oct 2026: off until a lawyer confirms the periods).
            // Said every tick, so the log never reads as a working sweep.
            if (erased is null)
                log.LogInformation("Hire retention sweep is OFF (platform setting hire.retention_sweep_enabled is not 'true'): nobody erased.");
            else
                log.LogInformation("Hire retention sweep: {Erased} candidate(s) past their retention period erased.", erased);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutting down.
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Hire retention sweep FAILED - candidates past their retention period are not being deleted. Will retry in {Hours}h.",
                Interval.TotalHours);
        }
    }
}
