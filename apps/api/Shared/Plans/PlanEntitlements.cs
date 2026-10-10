using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Shared.Plans;

/// <summary>
/// What one organisation is entitled to, feature by feature, and where each
/// answer came from — and the warnings when what they USE differs from that.
///
/// ─────────────────────────────────────────────────────────────────────────
///  DERIVED, NEVER STORED (rule 10, the CTO's 9 Sept entitlement ruling):
///  plan features, plus grants, minus revokes. Worked out here on every read.
///
///  WARN FIRST (Amit, 26 Sept 2026). Nothing in this file stops anything, and
///  nothing calls it on a request path that could. It is read by the operator
///  console, and by the organisation's own console only when the platform
///  setting plans.warn_clients is on. A future "stop at the limit" is a
///  separate decision with its own review.
///
///  EXISTING CUSTOMERS KEEP EVERYTHING (Amit, 26 Sept): tenants.keeps_everything
///  means every feature, no limits, no warnings. A revoke override still wins
///  over it: a revoke is a hold, and a hold that "keeps everything" can
///  silently defeat is the signature bug the overrides ruling names.
///
///  The caller must already be in this organisation's scope (platform scope
///  or its own session). Every query also says TenantId == tenantId, so the
///  answer does not depend on which tables have RLS or a query filter.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class PlanEntitlements
{
    public sealed record FeatureState(
        string Code, string? ProductCode, string Name, string? Description, string Kind, string? Unit,
        bool Included, long? Limit, string Source, Guid? OverrideId, DateTimeOffset? OverrideExpiresAt);

    public sealed record Result(
        bool KeepsEverything, Guid? PlanId, string? PlanName, string[] PlanProducts,
        bool PlanListsFeatures, List<FeatureState> Features);

    public sealed record Warning(string Code, string Level, string Message);

    public static async Task<Result> ResolveAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var keeps = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenantId).Select(t => t.KeepsEverything).FirstOrDefaultAsync(ct);

        var sub = await db.Subscriptions.AsNoTracking()
            .Where(s => s.TenantId == tenantId && s.UserId == null)
            .OrderByDescending(s => s.StartedAt)
            .Select(s => new { s.PlanId })
            .FirstOrDefaultAsync(ct);
        var plan = sub is null ? null
            : await db.Plans.AsNoTracking().FirstOrDefaultAsync(p => p.Id == sub.PlanId, ct);

        var products = plan?.IncludedProducts ?? [];
        var planLimits = plan is null
            ? new Dictionary<string, long>()
            : await db.PlanFeatureLimits.AsNoTracking()
                .Where(l => l.PlanId == plan.Id)
                .ToDictionaryAsync(l => l.FeatureCode, l => l.LimitValue, ct);

        var now = DateTimeOffset.UtcNow;
        var overrides = await db.FeatureOverrides.AsNoTracking()
            .Where(o => o.TenantId == tenantId && o.WithdrawnAt == null
                        && (o.ExpiresAt == null || o.ExpiresAt > now))
            .ToDictionaryAsync(o => o.FeatureCode, ct);

        var catalogue = await db.Features.AsNoTracking()
            .OrderBy(f => f.ProductCode == null ? 1 : 0).ThenBy(f => f.ProductCode)
            .ThenBy(f => f.SortOrder)
            .ToListAsync(ct);

        var states = new List<FeatureState>(catalogue.Count);
        foreach (var f in catalogue)
        {
            overrides.TryGetValue(f.Code, out var ov);
            var productIn = f.ProductCode is null || products.Contains(f.ProductCode);

            bool included;
            long? limit = null;
            string source;

            if (f.Kind == "limit")
            {
                // A limit is always "included"; the question is the number.
                included = true;
                if (ov?.Mode == "limit") { limit = ov.LimitValue; source = "override"; }
                else if (keeps) { source = "keeps everything"; }
                else if (planLimits.TryGetValue(f.Code, out var pl)) { limit = pl; source = "plan"; }
                else { source = plan is null ? "no plan" : "plan (no limit)"; }
            }
            else if (ov?.Mode == "revoke") { included = false; source = "override: held"; }
            else if (ov?.Mode == "grant") { included = true; source = "override: granted"; }
            else if (keeps) { included = true; source = "keeps everything"; }
            else if (plan is null) { included = false; source = "no plan"; }
            else if (plan.IncludedFeatures is null) { included = productIn; source = productIn ? "plan" : "module not in plan"; }
            else
            {
                included = productIn && plan.IncludedFeatures.Contains(f.Code);
                source = included ? "plan" : productIn ? "not in plan" : "module not in plan";
            }

            states.Add(new FeatureState(f.Code, f.ProductCode, f.Name, f.Description, f.Kind, f.Unit,
                included, limit, source, ov?.Id, ov?.ExpiresAt));
        }

        return new Result(keeps, plan?.Id, plan?.Name, products, plan?.IncludedFeatures is not null, states);
    }

    /// <summary>
    /// Where use and entitlement differ. Levels: "not_in_plan" (in use, not
    /// included), "over" (past a limit), "near" (80% of a limit).
    /// </summary>
    public static async Task<List<Warning>> WarningsAsync(
        AppDbContext db, SettingsReader settings, Guid tenantId, Result ent, CancellationToken ct)
    {
        var warnings = new List<Warning>();
        if (ent.KeepsEverything) return warnings;

        var t = await db.Tenants.AsNoTracking().FirstAsync(x => x.Id == tenantId, ct);
        var monthStart = MeteredAiGateway.MonthStart(DateTimeOffset.UtcNow);
        var aiThisMonth = db.AiUsage.AsNoTracking()
            .Where(u => u.TenantId == tenantId && u.CreatedAt >= monthStart
                        // Counted as AiUsageReport counts them: sent, whether or not it worked.
                        && (u.Outcome == "ok" || u.Outcome == "failed"));

        var shared = await db.Mailboxes.AsNoTracking()
            .CountAsync(m => m.TenantId == tenantId && m.Type == "shared" && m.IsActive, ct);

        // What "in use" means, one feature at a time. Each is the organisation
        // having it switched on or having used it — not merely being able to.
        var inUse = new Dictionary<string, bool>
        {
            ["ai.enabled"] = t.AllowAi,
            ["mail.ai"] = t.AllowMailAi || t.MailAiTriageSince != null
                          || await aiThisMonth.AnyAsync(u => u.Feature.StartsWith("mail."), ct),
            // Docs AI's own switch (#406), or any Docs AI used this month.
            ["docs.ai"] = t.AllowDocsAi
                          || await aiThisMonth.AnyAsync(u => u.Feature.StartsWith("docs."), ct),
            ["mail.shared_mailboxes"] = shared > 0,
            ["mail.send_api"] = await db.MailApiKeys.AsNoTracking()
                .AnyAsync(k => k.TenantId == tenantId && k.RevokedAt == null, ct),
            ["mail.aliases"] = await db.Aliases.AsNoTracking()
                .AnyAsync(a => a.TenantId == tenantId && a.IsActive, ct),
            ["connect.recording"] = t.AllowConnectRecording,
            ["connect.ai_minutes"] = await aiThisMonth.AnyAsync(u => u.Feature.StartsWith("connect."), ct),
            ["connect.guests"] = t.AllowConnectGuests,
            ["connect.public_recording_links"] = await db.Set<Modules.Connect.ConnectTenantSettings>().AsNoTracking()
                .AnyAsync(s => s.TenantId == tenantId && s.AllowPublicRecordingLinks, ct),
            // No row means the default, which is ON (20260816-space-public-links).
            ["space.public_links"] = !await db.SpaceTenantSettings.AsNoTracking()
                .AnyAsync(s => s.TenantId == tenantId && !s.AllowPublicLinks, ct),
        };

        foreach (var f in ent.Features.Where(f => f.Kind == "switch" && !f.Included))
        {
            if (!inUse.TryGetValue(f.Code, out var used) || !used) continue;
            // A module the plan leaves out entirely: warn only if the module is
            // in use, which for these features the feature's own use implies.
            warnings.Add(new Warning(f.Code, "not_in_plan",
                f.Source == "override: held"
                    ? $"{f.Name} is on hold for this organisation but still switched on or in use."
                    : $"{f.Name} is in use but not included in the plan."));
        }

        // Modules people have been given that the plan does not include.
        var granted = await db.ProductAccess.AsNoTracking()
            .Where(p => p.TenantId == tenantId && p.RevokedAt == null)
            .Select(p => p.ProductCode).Distinct().ToListAsync(ct);
        foreach (var code in granted.Where(c => !ent.PlanProducts.Contains(c)))
        {
            var name = await db.Products.AsNoTracking().Where(p => p.Code == code)
                .Select(p => p.Name).FirstOrDefaultAsync(ct) ?? code;
            warnings.Add(new Warning($"module.{code}", "not_in_plan",
                $"People have access to {name}, which the plan does not include."));
        }

        long? LimitOf(string code) => ent.Features.FirstOrDefault(f => f.Code == code)?.Limit;
        void Compare(string code, string what, long used, long? limit)
        {
            if (limit is not long max) return;
            if (used > max)
                warnings.Add(new Warning(code, "over", $"{what}: {used:N0} used, the plan allows {max:N0}."));
            else if (max > 0 && used * 100 >= max * 80)
                warnings.Add(new Warning(code, "near", $"{what}: {used:N0} of {max:N0} used."));
        }

        Compare("mail.shared_mailboxes.max", "Shared mailboxes", shared, LimitOf("mail.shared_mailboxes.max"));

        // No AI allowance here: AI credits (AiCredits, PR 307) own it and send
        // their own 80% / 100% warnings.

        // The plan's older limits, which already stop growth; said here too so
        // one list holds everything worth a phone call.
        var plan = ent.PlanId is Guid pid
            ? await db.Plans.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pid, ct) : null;
        if (plan?.MaxUsers is int maxUsers)
            Compare("plan.max_users", "People",
                await db.Users.AsNoTracking().CountAsync(u => u.TenantId == tenantId && u.Status != "deleted", ct), maxUsers);
        if (plan?.MaxDomains is int maxDomains)
            Compare("plan.max_domains", "Domains",
                await db.Domains.AsNoTracking().CountAsync(d => d.TenantId == tenantId && !d.IsPlatform, ct), maxDomains);

        return warnings;
    }
}
