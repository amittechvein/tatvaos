using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Features inside modules, per organisation (Amit, 26 Sept 2026): what each
/// customer is entitled to and why, the exceptions the operator makes, and
/// the warnings where use and plan differ. WARN FIRST: nothing here stops
/// anything — see PlanEntitlements.
/// </summary>
public static class PlanFeatureEndpoints
{
    public sealed record CreateOverrideRequest(
        string? FeatureCode, string? Mode, long? LimitValue, DateTimeOffset? ExpiresAt, string? Reason);

    public sealed record KeepsEverythingRequest(bool KeepsEverything, string? Reason);

    public static void MapPlanFeatureEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/features", FeaturesAsync)
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");

        var org = app.MapGroup("/api/admin/organisations/{id:guid}")
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");
        org.MapGet("/plan", PlanAsync);
        org.MapPost("/feature-overrides", CreateOverrideAsync);
        org.MapPost("/feature-overrides/{overrideId:guid}/withdraw", WithdrawOverrideAsync);
        org.MapPut("/keeps-everything", KeepsEverythingAsync);

        app.MapGet("/api/admin/plan-warnings", AllWarningsAsync)
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");

        // The organisation's own view — only when the operator has switched
        // client warnings on (plans.warn_clients). Warnings, never the plan's
        // internals or the operator's reasons.
        app.MapGet("/api/org/plan-warnings", OrgWarningsAsync)
            .RequireAuthorization("OrgAdmin").WithTags("Organisation administration");
    }

    private static async Task<IResult> FeaturesAsync(AppDbContext db, CancellationToken ct) =>
        Results.Ok(await db.Features.AsNoTracking()
            .OrderBy(f => f.ProductCode == null ? 1 : 0).ThenBy(f => f.ProductCode).ThenBy(f => f.SortOrder)
            .Select(f => new { f.Code, f.ProductCode, f.Name, f.Description, f.Kind, f.Unit })
            .ToListAsync(ct));

    // ------------------------------------------------------------------
    private static async Task<IResult> PlanAsync(
        Guid id, AppDbContext db, TenantContext tenant, SettingsReader settings,
        HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();
        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var ent = await PlanEntitlements.ResolveAsync(db, id, ct);
        var warnings = await PlanEntitlements.WarningsAsync(db, settings, id, ent, ct);

        // The last twenty exceptions, live and past: "who gave them this, and
        // when did it end" is the question a support call asks.
        var overrides = await db.FeatureOverrides.AsNoTracking()
            .Where(o => o.TenantId == id)
            .OrderByDescending(o => o.CreatedAt).Take(20)
            .ToListAsync(ct);
        // The operator is a user of Techvein, not of this organisation, so the
        // name is read outside the tenant filter — in its own query, so that
        // IgnoreQueryFilters cannot reach the overrides query above.
        var actorIds = overrides.Select(o => o.GrantedBy).Distinct().ToList();
        var names = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => actorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return Results.Ok(new
        {
            entitlements = ent,
            warnings,
            overrides = overrides.Select(o => new
            {
                o.Id, o.FeatureCode, o.Mode, o.LimitValue, o.ExpiresAt, o.Reason, o.CreatedAt, o.WithdrawnAt,
                grantedBy = names.GetValueOrDefault(o.GrantedBy),
            }),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CreateOverrideAsync(
        Guid id, CreateOverrideRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();

        var feature = await db.Features.AsNoTracking().FirstOrDefaultAsync(f => f.Code == req.FeatureCode, ct);
        if (feature is null) return Results.BadRequest(new { error = "Unknown feature." });
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length == 0)
            return Results.BadRequest(new { error = "Say why. An exception nobody can explain becomes permanent." });

        var mode = req.Mode;
        if (feature.Kind == "limit")
        {
            if (mode != "limit" || req.LimitValue is null or < 0)
                return Results.BadRequest(new { error = "A limit needs a number, 0 or more." });
        }
        else if (mode is not ("grant" or "revoke") || req.LimitValue is not null)
            return Results.BadRequest(new { error = "A feature is granted or held, not given a number." });

        if (req.ExpiresAt is DateTimeOffset exp && exp <= DateTimeOffset.UtcNow)
            return Results.BadRequest(new { error = "The end date is in the past." });

        var actor = CurrentUserId(http);
        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);

        // One live exception per feature (the database's unique index says the
        // same). A new one replaces the old, and the old is kept, withdrawn.
        var live = await db.FeatureOverrides
            .Where(o => o.TenantId == id && o.FeatureCode == feature.Code && o.WithdrawnAt == null)
            .ToListAsync(ct);
        foreach (var o in live) o.WithdrawnAt = DateTimeOffset.UtcNow;
        if (live.Count > 0) await db.SaveChangesAsync(ct);

        var row = new FeatureOverride
        {
            TenantId = id, FeatureCode = feature.Code, Mode = mode!,
            LimitValue = req.LimitValue, ExpiresAt = req.ExpiresAt,
            GrantedBy = actor, Reason = reason,
        };
        db.FeatureOverrides.Add(row);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("organisation.feature_override.created", "core.feature_override", row.Id.ToString(),
            before: live.Count > 0 ? new { replaced = live.Select(o => new { o.Id, o.Mode, o.LimitValue }) } : null,
            after: new { row.FeatureCode, row.Mode, row.LimitValue, row.ExpiresAt, row.Reason }, ct: ct);

        return Results.Ok(new { row.Id, row.FeatureCode, row.Mode, row.LimitValue, row.ExpiresAt });
    }

    private static async Task<IResult> WithdrawOverrideAsync(
        Guid id, Guid overrideId, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return Results.NotFound();
        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var row = await db.FeatureOverrides
            .FirstOrDefaultAsync(o => o.Id == overrideId && o.TenantId == id && o.WithdrawnAt == null, ct);
        if (row is null) return Results.NotFound();

        row.WithdrawnAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("organisation.feature_override.withdrawn", "core.feature_override", row.Id.ToString(),
            before: new { row.FeatureCode, row.Mode, row.LimitValue }, ct: ct);
        return Results.Ok(new { withdrawn = true });
    }

    private static async Task<IResult> KeepsEverythingAsync(
        Guid id, KeepsEverythingRequest req, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();
        if (string.IsNullOrWhiteSpace(req.Reason))
            return Results.BadRequest(new { error = "Say why — this changes what the customer is entitled to." });

        var before = org.KeepsEverything;
        org.KeepsEverything = req.KeepsEverything;
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("organisation.keeps_everything", "tenant", id.ToString(),
            before: new { keepsEverything = before },
            after: new { keepsEverything = org.KeepsEverything, reason = req.Reason!.Trim() }, ct: ct);
        return Results.Ok(new { org.Id, org.KeepsEverything });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Every organisation with something worth a phone call. One tenant at a
    /// time, like the organisation list — there is no "see everything" mode.
    /// </summary>
    private static async Task<IResult> AllWarningsAsync(
        AppDbContext db, TenantContext tenant, SettingsReader settings, HttpContext http, CancellationToken ct)
    {
        var orgs = await db.Tenants.AsNoTracking()
            .Where(t => t.Status != "deleted")
            .OrderBy(t => t.Name)
            .Select(t => new { t.Id, t.Name, t.KeepsEverything })
            .ToListAsync(ct);

        var actor = CurrentUserId(http);
        var result = new List<object>();
        foreach (var o in orgs)
        {
            if (o.KeepsEverything) continue;
            tenant.EnterPlatformScope(o.Id, actor);
            await db.SyncTenantAsync(ct);
            var ent = await PlanEntitlements.ResolveAsync(db, o.Id, ct);
            var w = await PlanEntitlements.WarningsAsync(db, settings, o.Id, ent, ct);
            if (w.Count > 0) result.Add(new { o.Id, o.Name, planName = ent.PlanName, warnings = w });
        }
        return Results.Ok(new { organisations = result, keepEverything = orgs.Count(o => o.KeepsEverything) });
    }

    private static async Task<IResult> OrgWarningsAsync(
        AppDbContext db, TenantContext tenant, SettingsReader settings, CancellationToken ct)
    {
        if (!await settings.FlagAsync(SettingKeys.PlansWarnClients, false, ct))
            return Results.Ok(new { enabled = false, warnings = Array.Empty<object>() });

        var id = tenant.TenantId;
        var ent = await PlanEntitlements.ResolveAsync(db, id, ct);
        var w = await PlanEntitlements.WarningsAsync(db, settings, id, ent, ct);
        return Results.Ok(new
        {
            enabled = true,
            planName = ent.PlanName,
            warnings = w.Select(x => new { x.Code, x.Level, x.Message }),
        });
    }

    private static Guid CurrentUserId(HttpContext http) =>
        TatvaOS.Api.Shared.Auth.SignedIn.UserIdOrEmpty(http);
}
