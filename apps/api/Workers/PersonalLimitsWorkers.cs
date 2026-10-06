using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Modules.Personal;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Ends a personal host's meeting when their plan's time is up (build plan
/// §4.5: "Free meetings: warnings at 50 and 55 minutes, and the meeting ends
/// at 60"). The warnings are the room page's, from the meeting's startedAt and
/// planLimits.maxMinutes; the END is here, on the server, so a closed tab or a
/// modified client changes nothing.
///
/// Every 30 seconds, meetings in the personal house that are active and have
/// a start time. The HOST's plan decides (D2). Ended the way a host ends one —
/// LiveKit deletes the room and everyone is disconnected; the room_finished
/// webhook stamps ended_at. If LiveKit does not accept, the meeting is NOT
/// marked ended here (it is still running) and the next pass tries again.
///
/// Organisations are never looked at: the query is the house's meetings only.
/// </summary>
public sealed class PersonalMeetingLimitWorker(IServiceScopeFactory scopes, ILogger<PersonalMeetingLimitWorker> log)
    : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try { await PassAsync(stop); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Personal meeting limit pass failed; next pass in {Seconds}s", Every.TotalSeconds);
            }
            try { await Task.Delay(Every, stop); } catch (OperationCanceledException) { return; }
        }
    }

    private async Task PassAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var houses = scope.ServiceProvider.GetRequiredService<PersonalHouse>();
        if (await houses.HouseIdAsync(ct) is not Guid house) return;

        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var plans = scope.ServiceProvider.GetRequiredService<EffectiveSettings>();
        var rooms = scope.ServiceProvider.GetRequiredService<LiveKitRoomClient>();

        tenant.EnterAnonymousScope(house, "system");
        await db.SyncTenantAsync(ct);

        var running = await db.ConnectMeetings
            .Where(m => m.TenantId == house && m.Status == "active" && m.StartedAt != null)
            .ToListAsync(ct);
        var now = DateTimeOffset.UtcNow;

        foreach (var m in running)
        {
            var hostPlan = await PersonalMeetingRules.HostPlanAsync(db, plans, m, ct);
            if (hostPlan?.Limit("connect.max_minutes") is not long max) continue;
            if (now - m.StartedAt!.Value < TimeSpan.FromMinutes(max)) continue;

            log.LogInformation("Meeting {Meeting} reached its host's {Max}-minute limit; ending it for everyone",
                m.Id, max);
            bool accepted;
            try { accepted = await rooms.EndAsync(m.Id, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Meeting {Meeting} is over its limit but the media server did not answer", m.Id);
                continue;
            }
            if (!accepted)
            {
                log.LogWarning("Meeting {Meeting} is over its limit but the media server refused to end it; retrying next pass", m.Id);
                continue;
            }
            m.Status = "ended";
            m.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
        }
    }
}

/// <summary>
/// The AI trial's two notices (build plan §5): a reminder on day 12, and a
/// note when it ends — "Your AI trial has ended. Premium keeps AI minutes
/// on." Each sent once (ai_trials.reminded_at / ended_notice_at), to the
/// person's own address. Hourly: a day's precision is all either promises.
///
/// The trial itself needs nothing from here to END: EffectiveSettings reads
/// ends_at on every call, so AI minutes stop at the moment it passes whether
/// or not this has run.
/// </summary>
public sealed class PersonalTrialWorker(IServiceScopeFactory scopes, ILogger<PersonalTrialWorker> log)
    : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    /// <summary>Day 12 of a 15-day trial: three days before the end.</summary>
    private static readonly TimeSpan RemindBeforeEnd = TimeSpan.FromDays(3);

    // DRAFT wording — customer-facing, for Mr. Singh and Amit (build plan §10).
    public const string ReminderSubject = "Your TatvaOS AI trial ends in 3 days";
    public const string ReminderBody =
        "Your AI trial ends on {0}. Until then, TatvaOS AI writes the minutes of the meetings you host.\n\n"
        + "When it ends, the minutes already written stay where they are. Premium keeps AI minutes on.";
    public const string EndedSubject = "Your TatvaOS AI trial has ended";
    public const string EndedBody =
        "Your AI trial has ended. Premium keeps AI minutes on.\n\n"
        + "The minutes already written for your meetings stay where they are.";

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try { await PassAsync(stop); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "AI trial notice pass failed; next pass in an hour");
            }
            try { await Task.Delay(Every, stop); } catch (OperationCanceledException) { return; }
        }
    }

    internal async Task PassAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();
        var now = DateTimeOffset.UtcNow;

        var due = await db.AiTrials
            .Where(t => t.UserId != null
                        && ((t.RemindedAt == null && t.EndsAt > now && t.EndsAt - now <= RemindBeforeEnd)
                            || (t.EndedNoticeAt == null && t.EndsAt <= now)))
            .ToListAsync(ct);

        foreach (var t in due)
        {
            var to = await db.Users.IgnoreQueryFilters().AsNoTracking()
                .Where(u => u.Id == t.UserId && u.Status == "active")
                .Select(u => u.Email).FirstOrDefaultAsync(ct);
            if (to is null) continue;

            // Marked sent ONLY when the mail edge took it: a notice marked on a
            // failed send would never be tried again. The next hourly pass
            // retries anything not marked.
            if (t.EndsAt <= now)
            {
                if (!await mailer.SendAsync(to, EndedSubject, EndedBody, ct))
                {
                    log.LogWarning("AI trial end note for user {User} not sent; will retry", t.UserId);
                    continue;
                }
                t.EndedNoticeAt = now;
                t.RemindedAt ??= now;     // never remind about a trial that is already over
            }
            else
            {
                var endsIndia = t.EndsAt.ToOffset(TimeSpan.FromMinutes(330));
                if (!await mailer.SendAsync(to, ReminderSubject, string.Format(ReminderBody, endsIndia.ToString("d MMMM")), ct))
                {
                    log.LogWarning("AI trial reminder for user {User} not sent; will retry", t.UserId);
                    continue;
                }
                t.RemindedAt = now;
            }
            await db.SaveChangesAsync(ct);
            log.LogInformation("AI trial notice sent for user {User} ({Which})", t.UserId,
                t.EndedNoticeAt == now ? "ended" : "reminder");
        }
    }
}

/// <summary>
/// The personal account lifecycle, hourly (build plan §8): the inactive rule's
/// warnings and deletion, due purges (self-delete after 7 days, operator,
/// inactive), and retrying files a purge could not remove. PersonalLifecycle
/// holds the rules; this only runs them.
/// </summary>
public sealed class PersonalLifecycleWorker(IServiceScopeFactory scopes, ILogger<PersonalLifecycleWorker> log)
    : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var report = await scope.ServiceProvider.GetRequiredService<PersonalLifecycle>().RunPassAsync(stop);
                if (report.Warned + report.FinalWarned + report.Scheduled + report.Purged + report.LeftoversCleared > 0
                    || report.LeftoversRemaining > 0)
                    log.LogInformation("Personal lifecycle pass: {Report}", report);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogError(ex, "Personal lifecycle pass failed; next pass in an hour");
            }
            try { await Task.Delay(Every, stop); } catch (OperationCanceledException) { return; }
        }
    }
}
