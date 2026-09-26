using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Mail;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Sorts new inbox mail with TatvaOS AI (Mail AI step 3 — see MailTriage for
/// what is sent and what never is).
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE RULES THIS FOLLOWS, EACH BORROWED FROM A WORKER THAT LEARNED IT:
///
///  · TENANT SCOPE, THEN SyncTenantAsync ON THE NEXT LINE (ConnectNotesWorker).
///    mail.messages is FORCE ROW LEVEL SECURITY; a scope change the database
///    session never heard about makes every write here a silent no-op.
///    core.tenants carries no RLS, which is what lets the first read find the
///    organisations with sorting on.
///
///  · CLAIM BEFORE SENDING (ConnectNotesWorker). ai_labelled_at is set by a
///    conditional UPDATE before the text goes anywhere, so two API containers
///    can never both send the same message. A provider failure un-claims it
///    for the next tick; a refusal (paused, over the limit) stops that
///    organisation for this tick rather than hammering a closed door.
///
///  · NEVER THE BACK CATALOGUE (VacationReplyWorker). Only mail that arrived
///    after sorting was switched on, and at most a week old.
///
///  · A DAILY CEILING PER ORGANISATION. The monthly token allowance is shared
///    with Help me write, suggested replies and meeting minutes; a busy inbox
///    sorted without limit could spend it all by the 10th and switch the
///    features people click on off with it. DailyCeiling is a placeholder for
///    Amit's number; past it, the rest of the day's mail stays unlabelled.
///
///  Background work has no person, so MeteredAiGateway counts it against the
///  organisation only — nobody's hourly allowance is spent by the sorter.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MailTriageWorker(
    IServiceScopeFactory scopes, IConfiguration config, ILogger<MailTriageWorker> log) : BackgroundService
{
    /// <summary>Messages per organisation per tick.</summary>
    private const int BatchSize = 20;

    /// <summary>AI requests per organisation per 24 hours. Amit's number to set; see the header.</summary>
    public const int DailyCeiling = 300;

    private static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(
            int.TryParse(config["Mail:TriageIntervalSeconds"], out var s) ? Math.Max(5, s) : 60);

        while (!ct.IsCancellationRequested)
        {
            try { await SweepAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { log.LogWarning(ex, "Mail sorting sweep failed; retrying next tick"); }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        List<(Guid Id, DateTimeOffset Since)> orgs;
        using (var probe = scopes.CreateScope())
        {
            var ai = probe.ServiceProvider.GetRequiredService<IAiGateway>();
            if (!ai.IsConfigured) return;
            var db0 = probe.ServiceProvider.GetRequiredService<AppDbContext>();
            // core.tenants has no RLS: this is the one cross-organisation read.
            orgs = (await db0.Tenants.IgnoreQueryFilters().AsNoTracking()
                    .Where(t => t.AllowAi && t.AllowMailAi && t.MailAiTriageSince != null && t.SuspendedAt == null
                                // Not offered to clinics yet (AiProductSwitch.TriageNotOfferedTo).
                                && !AiProductSwitch.TriageNotOfferedTo.Contains(t.Type))
                    .Select(t => new { t.Id, Since = t.MailAiTriageSince!.Value })
                    .ToListAsync(ct))
                .Select(t => (t.Id, t.Since)).ToList();

            // Only organisations on the Mail AI list, if there is one — the
            // gateway would refuse the rest anyway; this spares them a claim
            // and an un-claim every minute.
            var log0 = probe.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger("MailTriage");
            var kept = new List<(Guid Id, DateTimeOffset Since)>();
            foreach (var o in orgs)
                if (await AiProductSwitch.MailOfferedToAsync(db0, o.Id, log0, ct)) kept.Add(o);
            orgs = kept;
        }

        foreach (var org in orgs)
        {
            if (ct.IsCancellationRequested) return;
            try { await ForOrganisationAsync(org.Id, org.Since, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) { log.LogWarning(ex, "Mail sorting failed for tenant {Tenant}", org.Id); }
        }
    }

    private async Task ForOrganisationAsync(Guid tenantId, DateTimeOffset since, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var ai = scope.ServiceProvider.GetRequiredService<IAiGateway>();

        tenant.EnterAnonymousScope(tenantId, "system");
        await db.SyncTenantAsync(ct);

        var now = DateTimeOffset.UtcNow;
        var cutoff = since > now - MaxAge ? since : now - MaxAge;

        // The day's ceiling, counted from the meter itself (ok and failed
        // calls reached the provider; refusals did not).
        var dayAgo = now.AddDays(-1);
        var spent = await db.AiUsage.AsNoTracking()
            .CountAsync(u => u.Feature == MailTriage.Feature && u.CreatedAt >= dayAgo
                             && (u.Outcome == "ok" || u.Outcome == "failed"), ct);
        if (spent >= DailyCeiling) return;

        var candidates = await (
                from m in db.Messages.AsNoTracking()
                join f in db.Folders.AsNoTracking() on m.FolderId equals f.Id
                join b in db.Mailboxes.AsNoTracking() on m.MailboxId equals b.Id
                where f.SpecialUse == "\\Inbox" && m.AiLabelledAt == null && m.ReceivedAt >= cutoff
                orderby m.ReceivedAt descending
                select new { m.Id, m.FromAddr, m.FromName, m.Subject, m.BodyText, m.Snippet, m.SentByUserId, Address = b.Address })
            .Take(Math.Min(BatchSize, DailyCeiling - spent))
            .ToListAsync(ct);

        foreach (var c in candidates)
        {
            if (ct.IsCancellationRequested) return;

            // Claim first. Zero rows = someone else has it.
            var claimed = await db.Messages
                .Where(m => m.Id == c.Id && m.AiLabelledAt == null)
                .ExecuteUpdateAsync(u => u.SetProperty(m => m.AiLabelledAt, DateTimeOffset.UtcNow), ct);
            if (claimed == 0) continue;

            // Mail this mailbox sent: looked at, left alone, nothing sent.
            if (c.SentByUserId is not null
                || string.Equals(c.FromAddr?.Trim(), c.Address, StringComparison.OrdinalIgnoreCase))
                continue;

            // An automated sender is Updates by rule — the provider is not asked.
            if (MailSuggestions.IsAutomated(c.FromAddr))
            {
                await SetLabelAsync(db, c.Id, "updates", ct);
                continue;
            }

            var result = await ai.CompleteAsync(MailTriage.Instruction,
                MailTriage.Input(c.FromName, c.Subject, c.BodyText ?? c.Snippet), ct, MailTriage.Feature);

            // The call may have taken a while; the scope must not be assumed to
            // have survived it (ConnectNotesWorker re-asserts for the same reason).
            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);

            if (result.Error is not null)
            {
                // Un-claim so the next tick can try again, and stop this
                // organisation for now: a pause, a limit or a provider outage
                // is not going to lift in the next few milliseconds.
                await db.Messages.Where(m => m.Id == c.Id)
                    .ExecuteUpdateAsync(u => u.SetProperty(m => m.AiLabelledAt, (DateTimeOffset?)null), ct);
                log.LogInformation("Mail sorting paused for tenant {Tenant} this tick: {Reason}", tenantId, result.Error);
                return;
            }

            // An answer naming no label leaves the message claimed and
            // unlabelled — asking again would get the same answer and bill twice.
            if (MailTriage.Parse(result.Text) is string label)
                await SetLabelAsync(db, c.Id, label, ct);
        }
    }

    private static Task<int> SetLabelAsync(AppDbContext db, Guid id, string label, CancellationToken ct) =>
        db.Messages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(u => u.SetProperty(m => m.AiLabel, label), ct);
}
