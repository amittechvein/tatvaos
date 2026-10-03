using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Plans per person (build plan §2.2, part A).
///
///  GET /api/me/plan — the signed-in person's effective settings. What the
///  Account page's Plan section (part D, §4.2) will show; for an organisation
///  account it is the organisation's plan, warn-only, as today.
///
///  GET/PUT /api/admin/personal-accounts/{userId}/plan — the operator's view
///  and the ONLY way anyone moves between Free, Basic and Premium until
///  payments exist (§2.2: "for testing and goodwill"). A reason is required
///  and audited, into the house's own log.
/// </summary>
public static class PersonalPlanEndpoints
{
    private static readonly string[] Live = ["trial", "active", "past_due"];

    public static void MapPersonalPlanEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/me/plan", MineAsync)
            .RequireAuthorization("User").WithTags("Account");

        var g = app.MapGroup("/api/admin/personal-accounts")
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");
        g.MapGet("/{userId:guid}/plan", GetAsync);
        g.MapPut("/{userId:guid}/plan", ChangeAsync);
    }

    private static object Shape(EffectiveSettings.Answer a) => new
    {
        a.PlanId, a.PlanName, a.Personal, a.Enforced, a.StorageBytes,
        aiTrial = a.AiTrial is null ? null : new
        {
            a.AiTrial.StartedAt, a.AiTrial.EndsAt, a.AiTrial.Active,
            daysLeft = a.AiTrial.Active
                ? (int)Math.Ceiling((a.AiTrial.EndsAt - DateTimeOffset.UtcNow).TotalDays) : 0,
        },
        features = a.Features.Values.OrderBy(f => f.Code)
            .Select(f => new { f.Code, f.Kind, f.Unit, f.Included, f.Limit, f.Source }),
    };

    // ------------------------------------------------------------------
    private static async Task<IResult> MineAsync(
        EffectiveSettings settings, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid me) return Results.Unauthorized();
        var answer = await settings.ForUserAsync(me, ct);
        return answer is null ? Results.NotFound() : Results.Ok(Shape(answer));
    }

    // ------------------------------------------------------------------
    /// <summary>The person's house, entered as platform scope; null if not a personal account.</summary>
    private static async Task<Guid?> EnterHouseOfAsync(
        Guid userId, AppDbContext db, PersonalHouse houses, TenantContext tenant, CancellationToken ct)
    {
        var tenantId = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId).Select(u => (Guid?)u.TenantId).FirstOrDefaultAsync(ct);
        if (tenantId is not Guid t || !await houses.IsPersonalHouseAsync(t, ct)) return null;
        tenant.EnterPlatformScope(t, tenant.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);
        return t;
    }

    private static readonly object NotPersonal = new { error = "That is not a personal account." };

    private static async Task<IResult> GetAsync(
        Guid userId, AppDbContext db, PersonalHouse houses, TenantContext tenant,
        EffectiveSettings settings, CancellationToken ct)
    {
        if (await EnterHouseOfAsync(userId, db, houses, tenant, ct) is null) return Results.NotFound(NotPersonal);
        var answer = await settings.ForUserAsync(userId, ct);
        return answer is null ? Results.NotFound() : Results.Ok(Shape(answer));
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ChangeAsync(
        Guid userId, ChangePersonalPlanRequest req, AppDbContext db, PersonalHouse houses,
        TenantContext tenant, EffectiveSettings settings, AuditWriter audit, CancellationToken ct)
    {
        var reason = req.Reason?.Trim();
        if (string.IsNullOrEmpty(reason))
            return Results.BadRequest(new { error = "Say why — testing, goodwill, a support case. It goes in the audit log." });

        var plan = await db.Plans.AsNoTracking().FirstOrDefaultAsync(p => p.Id == req.PlanId, ct);
        if (plan is null) return Results.BadRequest(new { error = "Unknown plan." });
        if (plan.Audience != "personal")
            return Results.BadRequest(new { error = "That is an organisation plan. A personal account needs a personal plan." });

        if (await EnterHouseOfAsync(userId, db, houses, tenant, ct) is not Guid house)
            return Results.NotFound(NotPersonal);

        var before = await settings.ForUserAsync(userId, ct);

        // Two saves in one transaction: the cancelled row must be written
        // before the new live one, or the one-live-plan-per-person index
        // (ux_core_subs_one_live_per_user) refuses the pair.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var live = await db.Subscriptions
            .Where(s => s.TenantId == house && s.UserId == userId && Live.Contains(s.Status))
            .ToListAsync(ct);
        foreach (var s in live) { s.Status = "cancelled"; s.CancelledAt = now; }
        await db.SaveChangesAsync(ct);

        // Free is the absence of a row (derived, decision 0002). Anything
        // else is a row naming the person.
        if (plan.Id != EffectiveSettings.PersonalFreePlanId)
        {
            db.Subscriptions.Add(new Subscription
            {
                TenantId = house, UserId = userId, PlanId = plan.Id,
                Status = "active", Seats = 1, StartedAt = now,
            });
            await db.SaveChangesAsync(ct);
        }

        await audit.WriteAsync("personal.plan_changed", "user", userId.ToString(),
            before: new { planId = before?.PlanId, plan = before?.PlanName },
            after: new { planId = plan.Id, plan = plan.Name, reason }, ct: ct);
        await tx.CommitAsync(ct);

        var after = await settings.ForUserAsync(userId, ct);
        return after is null ? Results.NotFound() : Results.Ok(Shape(after));
    }
}

public sealed record ChangePersonalPlanRequest(Guid PlanId, string? Reason);
