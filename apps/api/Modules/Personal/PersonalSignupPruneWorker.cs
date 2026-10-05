using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Runs signup's one prune (JoinEndpoints.PruneAsync) every hour.
///
/// The prune also runs at each new signup start, and that used to be the only
/// trigger. But while signup is switched off nobody starts one — so an
/// abandoned signup's PLAIN-TEXT phone number, promised to live at most a day,
/// would sit there until the next visitor, however long that took. Mr. Singh
/// asked (PR 311) that the number is kept only until completion or one day;
/// this is what makes "one day" true with the door shut.
///
/// Logs counts only — never a number, never a signup's fields.
/// </summary>
public sealed class PersonalSignupPruneWorker(
    IServiceScopeFactory scopes, ILogger<PersonalSignupPruneWorker> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromHours(1);
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        try { await Task.Delay(StartupDelay, stopping); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(Tick);
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var (signups, attempts) = await JoinEndpoints.PruneAsync(db, DateTimeOffset.UtcNow, stopping);
                if (signups + attempts > 0)
                    log.LogInformation("Signup prune: {Signups} abandoned signup(s), {Attempts} old attempt(s) removed",
                        signups, attempts);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { return; }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Signup prune failed; next pass in an hour");
            }
        }
        while (await SafeWaitAsync(timer, stopping));
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
