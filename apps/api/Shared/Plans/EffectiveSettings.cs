using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Personal;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Plans;

/// <summary>
/// THE one answer to "what may this person have, and how much?" (build plan
/// personal-plans-build-plan.md §2.5). Every limit check — meeting size, a
/// recording, a send, an upload, AI — asks this, on the server, and nothing
/// else. Part A makes the answer; part D wires each product to it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE MODEL, TWO BEHAVIOURS.
///
///  An ORGANISATION account gets exactly what PlanEntitlements (PR 309) says —
///  the same features, the same sources — with Enforced = false. Amit's
///  26 Sept ruling for organisations is WARN FIRST, and nothing here changes
///  that: a caller that sees Enforced = false must not refuse anything.
///  Existing customers are unchanged by construction; this only re-reads.
///
///  A PERSONAL account (the house tenant, PersonalHouse) gets its own plan —
///  the live subscription with its user_id, or Personal Free when it has
///  none — with Enforced = true: these are hard limits (§4, §5).
///
///  DERIVED, NEVER STORED (decision 0002): worked out on every call, so an
///  upgrade is seen on the very next check with no sign-out (§5).
///
///  What the personal answer deliberately IGNORES:
///   - tenants.keeps_everything — the house never keeps everything (the
///     migration re-asserts false), and even if it said so, strangers must
///     not inherit it.
///   - core.feature_overrides on the house — an exception granted to the
///     house would apply to every stranger in it at once (§6: the house's
///     organisation-level switches must never switch anything on for
///     anyone). Per-person exceptions are the operator's plan change.
///   - core.tenants.allow_ai on the house — same reason. AI consent is per
///     person (D3); part D reads that, alongside this answer.
///
///  The caller must already be in the person's tenant scope (their own
///  session, or the operator in platform scope), as for PlanEntitlements:
///  core.subscriptions is RLS-forced and would otherwise read as empty — and
///  an empty read for a personal account means Free, which is the safe side.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class EffectiveSettings(AppDbContext db, PersonalHouse houses, ILogger<EffectiveSettings> log)
{
    /// <summary>Everyone in the house with no subscription row is on this.</summary>
    public static readonly Guid PersonalFreePlanId = Guid.Parse("b0000000-0000-0000-0000-000000000001");

    /// <summary>What an AI trial switches on while it runs (D6: AI meeting minutes only).</summary>
    public static readonly string[] TrialFeatures = ["ai.enabled", "connect.ai_minutes"];

    public sealed record Feature(string Code, string Kind, string? Unit, bool Included, long? Limit, string Source);

    public sealed record Trial(DateTimeOffset StartedAt, DateTimeOffset EndsAt, bool Active);

    public sealed record Answer(
        Guid UserId, Guid TenantId,
        bool Personal,
        bool Enforced,              // true = hard limits (personal); false = warn only, never refuse on it

        Guid? PlanId, string? PlanName,
        long? StorageBytes,          // mail and files together, per person; null for an organisation

        Trial? AiTrial,
        IReadOnlyDictionary<string, Feature> Features)
    {
        public bool Has(string code) => Features.TryGetValue(code, out var f) && f.Included;
        /// <summary>The number, or null for no limit (or an unknown code).</summary>
        public long? Limit(string code) => Features.TryGetValue(code, out var f) ? f.Limit : null;
    }

    /// <summary>Null when there is no such person.</summary>
    public async Task<Answer?> ForUserAsync(Guid userId, CancellationToken ct = default)
    {
        var user = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Id, u.TenantId })
            .FirstOrDefaultAsync(ct);
        if (user is null) return null;

        if (!await houses.IsPersonalHouseAsync(user.TenantId, ct))
            return await ForOrganisationUserAsync(user.Id, user.TenantId, ct);

        return await ForPersonalUserAsync(user.Id, user.TenantId, ct);
    }

    // ------------------------------------------------------------------
    private async Task<Answer> ForOrganisationUserAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        var ent = await PlanEntitlements.ResolveAsync(db, tenantId, ct);
        var features = ent.Features.ToDictionary(
            f => f.Code,
            f => new Feature(f.Code, f.Kind, f.Unit, f.Included, f.Limit, f.Source));
        return new Answer(userId, tenantId, Personal: false, Enforced: false,
            ent.PlanId, ent.PlanName, StorageBytes: null, AiTrial: null, features);
    }

    // ------------------------------------------------------------------
    private async Task<Answer> ForPersonalUserAsync(Guid userId, Guid tenantId, CancellationToken ct)
    {
        var liveStatuses = new[] { "trial", "active", "past_due" };
        var subscribed = await db.Subscriptions.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.TenantId == tenantId && s.UserId == userId && liveStatuses.Contains(s.Status))
            .OrderByDescending(s => s.StartedAt)
            .Select(s => (Guid?)s.PlanId)
            .FirstOrDefaultAsync(ct);

        var plan = await db.Plans.AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == (subscribed ?? PersonalFreePlanId) && p.Audience == "personal", ct);
        if (plan is null && subscribed is not null)
        {
            // Their plan is gone or no longer personal: Free, loudly.
            log.LogError("Personal account {User} is subscribed to plan {Plan}, which is missing or not personal; answering Free",
                userId, subscribed);
            plan = await db.Plans.AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == PersonalFreePlanId && p.Audience == "personal", ct);
        }

        var catalogue = await db.Features.AsNoTracking().ToListAsync(ct);

        if (plan is null)
        {
            // No Free plan at all — a broken catalogue. FAIL CLOSED: nothing
            // included and every limit zero, so part D's checks refuse rather
            // than wave everything through. Logged as an error every time.
            log.LogError("Personal Free plan {Plan} is missing; answering with everything off for {User}",
                PersonalFreePlanId, userId);
            var closed = catalogue.ToDictionary(f => f.Code,
                f => new Feature(f.Code, f.Kind, f.Unit, Included: false, Limit: f.Kind == "limit" ? 0 : null, "no plan"));
            return new Answer(userId, tenantId, true, true, null, null, 0, null, closed);
        }

        var limits = await db.PlanFeatureLimits.AsNoTracking()
            .Where(l => l.PlanId == plan.Id)
            .ToDictionaryAsync(l => l.FeatureCode, l => l.LimitValue, ct);

        // The trial is keyed by the phone fingerprint, not the account — one
        // per number, ever (D6, §8).
        var phoneHash = await db.PersonalAccounts.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.UserId == userId).Select(a => a.PhoneHash).FirstOrDefaultAsync(ct);
        var trialRow = phoneHash is null ? null
            : await db.AiTrials.AsNoTracking().FirstOrDefaultAsync(t => t.PhoneHash == phoneHash, ct);
        var now = DateTimeOffset.UtcNow;
        var trial = trialRow is null ? null : new Trial(trialRow.StartedAt, trialRow.EndsAt, now < trialRow.EndsAt);

        var features = new Dictionary<string, Feature>(catalogue.Count);
        foreach (var f in catalogue)
        {
            if (f.Kind == "limit")
            {
                var has = limits.TryGetValue(f.Code, out var n);
                features[f.Code] = new Feature(f.Code, f.Kind, f.Unit, true, has ? n : null,
                    has ? "plan" : "plan (no limit)");
                continue;
            }

            var productIn = f.ProductCode is null || plan.IncludedProducts.Contains(f.ProductCode);
            var included = productIn && (plan.IncludedFeatures?.Contains(f.Code) ?? true);
            var source = included ? "plan" : productIn ? "not in plan" : "module not in plan";
            if (!included && trial is { Active: true } && TrialFeatures.Contains(f.Code))
            {
                included = true;
                source = "trial";
            }
            features[f.Code] = new Feature(f.Code, f.Kind, f.Unit, included, null, source);
        }

        return new Answer(userId, tenantId, Personal: true, Enforced: true,
            plan.Id, plan.Name, plan.PerUserQuotaBytes, trial, features);
    }
}
