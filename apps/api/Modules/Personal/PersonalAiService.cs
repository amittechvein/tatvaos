using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// A personal account's AI: their own switch (D3), what their plan lets it
/// do (§4.5), and the trial (D6, §5).
///
/// ─────────────────────────────────────────────────────────────────────────
///  Two questions, answered in two places on purpose:
///
///   CONSENT — "did this person say yes?" — OpenAiGateway.EnabledForTenantAsync
///   reads core.personal_ai for the house. The one consent check every AI
///   call already passes, fail-closed.
///
///   ENTITLEMENT — "does their plan let them?" — PlanRefusalAsync, called by
///   MeteredAiGateway before anything is sent: AI meeting minutes only
///   (connect.minutes), on Premium or in a running trial. Mail AI is out of
///   scope for personal plans (build plan, "Out of scope").
///
///  THE TRIAL starts the first time a person confirms the switch, if their
///  plan does not already include AI minutes, and only if their phone number
///  has never had one — core.ai_trials is keyed by the phone fingerprint and
///  outlives the account (§8). Its length is the plan's ai.trial_days.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class PersonalAiService(
    AppDbContext db, EffectiveSettings settings, AuditWriter audit, TatvaOS.Api.Shared.Ai.IAiGateway ai)
{
    /// <summary>
    /// What the person confirms (§4.2). The place is the gateway's configured
    /// Ai:DataLocation — the same one organisation consent prints — never a
    /// country typed here: a provider that moves would make a hard-coded
    /// sentence a false statement the person agreed to.
    /// </summary>
    public string ConfirmSentence =>
        $"When AI is on, the words spoken in the meetings you host are sent to an AI service in "
        + $"{ai.DataLocation ?? "another country"} to write the minutes. Nothing is sent while it is off.";

    /// <summary>AI features a personal plan may use, and the plan feature that must be included.</summary>
    private static readonly Dictionary<string, string> PlanFeatureFor = new()
    {
        ["connect.minutes"] = "connect.ai_minutes",
    };

    /// <summary>Null when the plan allows this AI feature for this person; else the sentence to show.</summary>
    public static async Task<string?> PlanRefusalAsync(
        EffectiveSettings settings, Guid? userId, string feature, CancellationToken ct)
    {
        if (userId is not Guid uid) return "AI needs to know whose account this is for.";
        if (!PlanFeatureFor.TryGetValue(feature, out var planFeature))
            return "That AI feature isn't part of personal accounts.";
        var answer = await settings.ForUserAsync(uid, ct);
        if (answer is null || !answer.Has(planFeature))
            return answer?.AiTrial is { Active: false }
                ? "Your AI trial has ended. Premium keeps AI minutes on."
                : "AI minutes are part of Premium.";
        return null;
    }

    public sealed record State(bool Enabled, bool Confirmed, EffectiveSettings.Trial? Trial, bool Included, string ConfirmSentence);

    public async Task<State> GetAsync(Guid userId, CancellationToken ct)
    {
        var row = await db.PersonalAi.AsNoTracking().FirstOrDefaultAsync(a => a.UserId == userId, ct);
        var answer = await settings.ForUserAsync(userId, ct);
        return new State(row?.Enabled ?? false, row?.ConfirmedAt is not null, answer?.AiTrial,
            answer?.Has("connect.ai_minutes") ?? false, ConfirmSentence);
    }

    /// <summary>
    /// Switch on (with confirm) or off. Returns null on success, else the
    /// sentence. Switching on unconfirmed is refused — the confirmation IS
    /// the consent, and a client that skips the dialog must not get past it.
    /// </summary>
    public async Task<string?> SetAsync(Guid userId, bool on, bool confirm, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var row = await db.PersonalAi.FirstOrDefaultAsync(a => a.UserId == userId, ct);
        if (on && !confirm && row?.ConfirmedAt is null)
            return "Please confirm first: " + ConfirmSentence;

        if (row is null)
        {
            row = new PersonalAiConsent { UserId = userId };
            db.PersonalAi.Add(row);
        }
        var before = new { row.Enabled, confirmed = row.ConfirmedAt is not null };
        row.Enabled = on;
        if (on && confirm) row.ConfirmedAt ??= now;
        row.ChangedAt = now;

        if (on) await StartTrialIfDueAsync(userId, now, ct);

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(on ? "personal.ai_on" : "personal.ai_off", "user", userId.ToString(),
            before: before, after: new { row.Enabled, confirmed = row.ConfirmedAt is not null }, ct: ct);
        return null;
    }

    /// <summary>
    /// The trial, if this is the moment for one: the plan does not include AI
    /// minutes, the plan offers a trial (ai.trial_days), and this phone
    /// number has never had one. One row per number, EVER — the primary key
    /// makes a second impossible even if two requests race.
    /// </summary>
    private async Task StartTrialIfDueAsync(Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var answer = await settings.ForUserAsync(userId, ct);
        if (answer is null || !answer.Personal) return;
        if (answer.Has("connect.ai_minutes")) return;                // Premium, or a trial already running
        if (answer.Limit("ai.trial_days") is not long days || days <= 0) return;

        var phoneHash = await db.PersonalAccounts.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.UserId == userId).Select(a => a.PhoneHash).FirstOrDefaultAsync(ct);
        if (phoneHash is null) return;
        if (await db.AiTrials.AsNoTracking().AnyAsync(t => t.PhoneHash == phoneHash, ct)) return;

        db.AiTrials.Add(new AiTrial
        {
            PhoneHash = phoneHash, UserId = userId, StartedAt = now, EndsAt = now.AddDays(days),
        });
    }
}
