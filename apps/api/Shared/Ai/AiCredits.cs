using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// AI credits — what a customer's AI allowance is counted in (Amit, 26 Sept
/// 2026: the plan decides, pooled or per user; customers see credits, not
/// tokens; warn at 80 %, stop at 100 %). Schema and reasoning:
/// 20260926-b-ai-credits.sql.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY CREDITS AND NOT TOKENS. A token is our cost and means nothing to a
///  school's administrator — "you have used 184,300 tokens" answers no
///  question they have. A credit is one AI action, weighted by how much work
///  it is: they can predict it, and they can see which feature spends it.
///  Tokens are still metered underneath (core.ai_usage), for our own costs.
///
///  ONLY ANSWERED REQUESTS COST CREDITS. A refusal (paused, over a limit,
///  switched off) and a provider failure cost nothing: the customer got
///  nothing. (Tokens count failed calls because the provider may bill them;
///  credits are what WE charge, and we do not charge for our failures.)
///
///  THE COSTS ARE HERE, IN CODE, for now. Changing what an action costs is a
///  pricing decision (Amit's) and a promise to customers (Mr. Singh's), and
///  both should see a diff, not a settings change nobody reviewed.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiCredits
{
    /// <summary>Credits one ANSWERED request of a feature costs. Unknown features cost 1.</summary>
    public static int CostOf(string feature) => feature switch
    {
        "mail.rewrite" => 1,
        "mail.suggest" => 1,
        "mail.summary" => 2,
        "mail.triage" => 1,
        "connect.minutes" => 5,
        // Docs AI, per action (Amit, 3 Oct 2026, taking Mr. Singh's 1 / 1 / 1 / 5).
        // Write with AI is the one that produces new text at length.
        "docs.summarize" => 1,
        "docs.rewrite" => 1,       // Improve, Shorten, Expand, Formal, Simpler
        "docs.translate" => 1,
        "docs.write" => 5,
        "docs" => 1,               // the single label used before 3 Oct 2026; kept so old rows price as charged
        "platform.probe" => 0,        // the operator's own health check
        _ => 1,
    };

    /// <summary>What the allowance is and where it came from, for the screens and the gateway.</summary>
    /// <param name="Allowance">Credits a month; null = no credit limit.</param>
    /// <param name="Source">"override", "plan" or "none".</param>
    /// <param name="Model">"pooled" or "per_user" (when from a plan).</param>
    public sealed record Allowance(int? Credits, string Source, string? PlanName, string? Model,
        int? PerUser, int? Users)
    {
        /// <summary>What the plan or override gives, before this month's top-ups. Null = no limit.</summary>
        public int? Base { get; init; }
        /// <summary>This month's live top-up credits (counted in Credits only when there is a limit).</summary>
        public int TopUp { get; init; }
    }

    /// <summary>
    /// The CURRENT tenant's allowance (the caller's DbContext is tenant-scoped).
    /// Override first; else the live subscription's plan; else none.
    /// Per-user: the subscription's seats when set, otherwise the active users.
    /// </summary>
    public static async Task<Allowance> AllowanceAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        // Plan or override first, then this month's top-ups on top (26 Sept 2026).
        var a = await BaseAllowanceAsync(db, tenantId, ct);
        var month = MeteredAiGateway.MonthOf(DateTimeOffset.UtcNow);
        var topUp = await db.AiCreditTopups.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.TenantId == tenantId && t.Month == month && t.WithdrawnAt == null)
            .SumAsync(t => (int?)t.Credits, ct) ?? 0;
        // No limit stays no limit: a top-up adds to a limit, it cannot create one.
        return a with { Credits = a.Credits is int c ? checked(c + topUp) : null, Base = a.Credits, TopUp = topUp };
    }

    private static async Task<Allowance> BaseAllowanceAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var over = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenantId).Select(t => t.AiCreditsOverride).FirstOrDefaultAsync(ct);
        if (over is int o) return new Allowance(o, "override", null, null, null, null);

        var sub = await db.Subscriptions.IgnoreQueryFilters().AsNoTracking()
            .Where(s => s.TenantId == tenantId && s.Status != "cancelled")
            .OrderByDescending(s => s.StartedAt)
            .Select(s => new { s.Seats, s.Plan!.Name, s.Plan.AiCreditModel, s.Plan.AiCreditsPerUser, s.Plan.AiCreditsPooled })
            .FirstOrDefaultAsync(ct);
        if (sub is null) return new Allowance(null, "none", null, null, null, null);

        if (sub.AiCreditModel == "per_user")
        {
            if (sub.AiCreditsPerUser is not int per) return new Allowance(null, "plan", sub.Name, "per_user", null, null);
            var users = sub.Seats > 0
                ? sub.Seats
                : await db.Users.IgnoreQueryFilters().AsNoTracking().CountAsync(u => u.TenantId == tenantId && u.Status == "active", ct);
            return new Allowance(checked(per * Math.Max(0, users)), "plan", sub.Name, "per_user", per, users);
        }
        return new Allowance(sub.AiCreditsPooled, "plan", sub.Name, "pooled", null, null);
    }

    /// <summary>Credits the CURRENT tenant has spent this month (India time): answered requests only.</summary>
    public static async Task<(int Used, List<(string Feature, int Credits)> ByFeature)> UsedThisMonthAsync(
        AppDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var from = MeteredAiGateway.MonthStart(now);
        var rows = await db.AiUsage.AsNoTracking()
            .Where(u => u.CreatedAt >= from && u.Outcome == "ok")
            .GroupBy(u => u.Feature)
            .Select(g => new { Feature = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var by = rows.Select(r => (r.Feature, Credits: r.Count * CostOf(r.Feature)))
            .Where(x => x.Credits > 0).OrderByDescending(x => x.Credits).ToList();
        return (by.Sum(x => x.Credits), by);
    }

    public const string OutOfCredits =
        "Your organisation has used its TatvaOS AI credits for this month. They renew on the 1st; "
        + "an administrator can see the usage on the TatvaOS AI page.";
}
