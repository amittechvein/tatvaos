using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// One organisation's AI use for the current month (India time), against
/// the limits in force. The ONE summary both screens show — the
/// organisation's own AI page and the operator's organisation dialog — so the
/// two can never disagree. Reads through the tenant-scoped context: the
/// caller sets the tenant (the organisation's own request, or the operator's
/// platform scope).
/// </summary>
public static class AiUsageReport
{
    public sealed record FeatureLine(string Feature, int Requests, long Tokens);
    public sealed record ModelLine(string Model, int Requests, long TokensIn, long TokensOut);

    /// <summary>CeilingTokens / PerPersonPerHour: null = no limit, 0 = none allowed.</summary>
    public sealed record Month(
        DateTimeOffset From, long Tokens, int Requests, int Refused,
        long? CeilingTokens, int? PerPersonPerHour, bool Paused, int PercentOfCeiling,
        List<FeatureLine> ByFeature, List<ModelLine> ByModel);

    /// <summary>This month's AI CREDITS for a screen: allowance, where it comes from, used, per feature.</summary>
    public sealed record Credits(int? Allowance, string Source, string? PlanName, string? Model, int? PerUser, int? Users,
        int Used, int Percent, List<CreditLine> ByFeature)
    {
        /// <summary>Plan or override before top-ups; null = no limit.</summary>
        public int? Base { get; init; }
        /// <summary>This month's live top-up credits.</summary>
        public int TopUp { get; init; }
    }
    public sealed record CreditLine(string Feature, int Credits);

    public static async Task<Credits> CreditsAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var a = await AiCredits.AllowanceAsync(db, tenantId, ct);
        var (used, by) = await AiCredits.UsedThisMonthAsync(db, DateTimeOffset.UtcNow, ct);
        var percent = a.Credits switch
        {
            null => 0,
            0 => 100,
            int cap => (int)Math.Min(100, (long)used * 100 / cap),
        };
        return new Credits(a.Credits, a.Source, a.PlanName, a.Model, a.PerUser, a.Users, used, percent,
            by.Select(x => new CreditLine(x.Feature, x.Credits)).ToList()) { Base = a.Base, TopUp = a.TopUp };
    }

    public static async Task<Month> ThisMonthAsync(AppDbContext db, SettingsReader settings, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var from = MeteredAiGateway.MonthStart(now);
        var limits = await MeteredAiGateway.ReadLimitsAsync(settings, ct);

        var rows = await db.AiUsage.AsNoTracking()
            .Where(u => u.CreatedAt >= from)
            .GroupBy(u => new { u.Feature, u.Outcome })
            .Select(g => new { g.Key.Feature, g.Key.Outcome, Count = g.Count(), Tokens = g.Sum(u => (long)u.TokensIn + u.TokensOut) })
            .ToListAsync(ct);
        // By model, in and out separately: a provider prices input and output
        // tokens differently, and money is what the pricing decision needs.
        var byModel = (await db.AiUsage.AsNoTracking()
            .Where(u => u.CreatedAt >= from && (u.Outcome == "ok" || u.Outcome == "failed"))
            .GroupBy(u => u.Model)
            .Select(g => new { Model = g.Key, Count = g.Count(), In = g.Sum(u => (long)u.TokensIn), Out = g.Sum(u => (long)u.TokensOut) })
            .ToListAsync(ct))
            .Select(m => new ModelLine(m.Model, m.Count, m.In, m.Out))
            .OrderByDescending(m => m.TokensIn + m.TokensOut)
            .ToList();

        bool Sent(string o) => o is "ok" or "failed";
        var tokens = rows.Where(r => Sent(r.Outcome)).Sum(r => r.Tokens);
        var requests = rows.Where(r => Sent(r.Outcome)).Sum(r => r.Count);
        var refused = rows.Where(r => !Sent(r.Outcome)).Sum(r => r.Count);
        var byFeature = rows.Where(r => Sent(r.Outcome))
            .GroupBy(r => r.Feature)
            .Select(g => new FeatureLine(g.Key, g.Sum(x => x.Count), g.Sum(x => x.Tokens)))
            .OrderByDescending(f => f.Tokens)
            .ToList();
        var percent = limits.OrgMonthlyTokens switch
        {
            null => 0,                        // no ceiling
            0 => 100,                         // none allowed: the allowance is all used
            long cap => (int)Math.Min(100, tokens * 100 / cap),
        };

        return new Month(from, tokens, requests, refused, limits.OrgMonthlyTokens,
            limits.PerPersonPerHour, limits.Paused, percent, byFeature, byModel);
    }
}
