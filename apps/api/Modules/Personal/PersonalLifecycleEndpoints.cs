using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// Build plan §4.2, §8, §9 (part F).
///
///  The person:   GET /api/me/lifecycle, POST /api/me/delete (password
///                required), POST /api/me/delete/cancel, GET /api/me/export.
///  The operator: GET /api/admin/personal-accounts (list, search, filter),
///                GET /api/admin/personal-accounts/stats,
///                POST /api/admin/personal-accounts/{id}/suspend|resume|delete,
///                POST /api/admin/personal-lifecycle/run (one pass now).
///
/// Every person route answers 404 for an organisation account: this is not
/// how anyone in an organisation leaves (their administrator offboards them).
/// NO PHONE NUMBER anywhere in the operator's list (§9).
/// </summary>
public static class PersonalLifecycleEndpoints
{
    public static void MapPersonalLifecycleEndpoints(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/api/me").RequireAuthorization("User").WithTags("Account");
        me.MapGet("/lifecycle", MineAsync);
        me.MapPost("/delete", DeleteMeAsync);
        me.MapPost("/delete/cancel", CancelMineAsync);
        // Download my data: signed in to get a link; the link is one-use and
        // expires in ten minutes (PersonalExportLink). No direct GET: it
        // would be a second way in, around the once-a-day rule.
        me.MapPost("/export/link", ExportLinkAsync);
        app.MapGet("/api/me/export/file", ExportFileAsync).AllowAnonymous().WithTags("Account");

        var op = app.MapGroup("/api/admin/personal-accounts").RequireOperator()
            .WithTags("Platform administration");
        op.MapGet("/", ListAsync);
        op.MapGet("/stats", StatsAsync);
        op.MapPost("/{userId:guid}/suspend", SuspendAsync);
        op.MapPost("/{userId:guid}/resume", ResumeAsync);
        // Its own transaction (OperatorWriteTransaction): PersonalLifecycle.PurgeAsync
        // commits the rows and their audit line together, THEN removes files,
        // which no rollback could bring back.
        op.MapPost("/{userId:guid}/delete", OperatorDeleteAsync)
            .WithMetadata(new OperatorWriteTransaction.ManagesOwnTransaction());
        // One pass of the lifecycle worker, by hand: each purge in it owns its
        // transaction and removes files after its commit, as above.
        app.MapPost("/api/admin/personal-lifecycle/run", RunAsync)
            .RequireOperator().WithTags("Platform administration")
            .WithMetadata(new OperatorWriteTransaction.ManagesOwnTransaction());
    }

    private static readonly object NotPersonal = new { error = "That is not a personal account." };

    private static async Task<bool> IsPersonalAsync(PersonalHouse houses, TenantContext tenant, CancellationToken ct) =>
        await houses.IsPersonalHouseAsync(tenant.TenantId, ct);

    // ------------------------------------------------------------------
    private static async Task<IResult> MineAsync(
        TenantContext tenant, PersonalHouse houses, AppDbContext db, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await IsPersonalAsync(houses, tenant, ct)) return Results.NotFound(NotPersonal);
        var a = await db.PersonalAccounts.IgnoreQueryFilters().AsNoTracking().FirstAsync(x => x.UserId == uid, ct);
        return Results.Ok(new
        {
            deleteAfter = a.DeleteAfter,
            deletionReason = a.DeletionReason,
            canCancel = a.DeleteAfter is not null && a.DeletionReason != "operator",
            suspended = a.SuspendedAt is not null,
        });
    }

    public sealed record DeleteMeRequest(string? Password);

    private static async Task<IResult> DeleteMeAsync(
        DeleteMeRequest req, TenantContext tenant, PersonalHouse houses, AppDbContext db,
        IPasswordHasher hasher, PersonalLifecycle life, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await IsPersonalAsync(houses, tenant, ct)) return Results.NotFound(NotPersonal);
        // The password, again: deleting everything is not something a
        // borrowed, unlocked laptop should be able to do in one click.
        var hash = await db.Users.IgnoreQueryFilters().Where(u => u.Id == uid).Select(u => u.PasswordHash).FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(req.Password) || hash is null || !hasher.Verify(req.Password, hash))
            return Results.BadRequest(new { error = "That password isn't right." });
        var after = await life.RequestSelfDeletionAsync(uid, ct);
        return Results.Ok(new { deleteAfter = after });
    }

    private static async Task<IResult> CancelMineAsync(
        TenantContext tenant, PersonalHouse houses, PersonalLifecycle life, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await IsPersonalAsync(houses, tenant, ct)) return Results.NotFound(NotPersonal);
        return await life.CancelDeletionAsync(uid, ct)
            ? Results.Ok(new { cancelled = true })
            : Results.BadRequest(new { error = "There is no deletion to cancel." });
    }

    private static async Task<IResult> ExportLinkAsync(
        TenantContext tenant, PersonalHouse houses, AppDbContext db, PersonalExportLink links, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await IsPersonalAsync(houses, tenant, ct)) return Results.NotFound(NotPersonal);
        var acct = await db.PersonalAccounts.IgnoreQueryFilters().FirstAsync(a => a.UserId == uid, ct);
        var now = DateTimeOffset.UtcNow;
        if (acct.LastExportAt is DateTimeOffset last && now - last < PersonalExportLink.OncePer)
            return Results.Json(new
            {
                error = "You can download your data once a day. Try again after "
                        + (last + PersonalExportLink.OncePer).ToOffset(TimeSpan.FromMinutes(330)).ToString("d MMMM, h:mm tt") + ".",
            }, statusCode: 429);
        var (ticket, nonceHash, expires) = links.Issue(uid);
        acct.ExportNonceHash = nonceHash;       // replaces any earlier, unused link
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { url = $"/api/me/export/file?t={Uri.EscapeDataString(ticket)}", expiresAt = expires });
    }

    /// <summary>
    /// The link itself. Anonymous (a browser navigation carries no bearer
    /// token); the signed, unexpired, UNUSED ticket is the permission. Used
    /// the moment the download starts: the nonce is cleared and the day is
    /// counted before the first byte.
    /// </summary>
    private static async Task ExportFileAsync(
        HttpContext http, string? t, AppDbContext db, IBlobStore blobs, PersonalExportLink links,
        TenantContext tenant, TatvaOS.Api.Modules.Admin.AuditWriter audit, CancellationToken ct)
    {
        const string Dead = "This link has expired or been used. Ask for a new one from Account settings.";
        if (links.Verify(t) is not { } claim)
        {
            http.Response.StatusCode = 410;
            await http.Response.WriteAsJsonAsync(new { error = Dead }, ct);
            return;
        }
        var acct = await db.PersonalAccounts.IgnoreQueryFilters().FirstOrDefaultAsync(a => a.UserId == claim.UserId, ct);
        if (acct is null || acct.ExportNonceHash != PersonalExportLink.HashNonce(claim.Nonce))
        {
            http.Response.StatusCode = 410;
            await http.Response.WriteAsJsonAsync(new { error = Dead }, ct);
            return;
        }
        acct.ExportNonceHash = null;
        acct.LastExportAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        tenant.Set(acct.TenantId, acct.UserId, "employee");
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("personal.data_exported", "user", acct.UserId.ToString(), ct: ct);
        await PersonalExport.WriteAsync(http, db, blobs, acct.UserId, ct);
    }

    // ------------------------------------------------------------------
    //  The operator
    // ------------------------------------------------------------------
    private sealed class Row
    {
        public Guid UserId { get; set; }
        public string Email { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public DateTimeOffset CreatedAt { get; set; }
        public DateTimeOffset? LastLoginAt { get; set; }
        public string? PlanName { get; set; }
        public long? QuotaBytes { get; set; }
        public long UsedBytes { get; set; }
        public DateTimeOffset? TrialEndsAt { get; set; }
        public DateTimeOffset? SuspendedAt { get; set; }
        public string? SuspendedReason { get; set; }
        public DateTimeOffset? DeleteAfter { get; set; }
        public string? DeletionReason { get; set; }
    }

    /// <summary>
    /// filter: "all" (default) | "free" | "paid" | "suspended" | "deleting".
    /// q: part of the address. Newest first, 100 at a time.
    /// </summary>
    private static async Task<IResult> ListAsync(
        AppDbContext db, PersonalHouse houses, TenantContext tenant, CancellationToken ct,
        string? q = null, string? filter = null, int page = 1)
    {
        if (await houses.HouseIdAsync(ct) is not Guid house) return Results.Ok(new { rows = Array.Empty<object>(), total = 0 });
        tenant.EnterPlatformScope(house, tenant.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);

        var like = "%" + (q ?? "").Trim().Replace("%", "").Replace("_", "\\_") + "%";
        var f = (filter ?? "all").Trim().ToLowerInvariant();
        var skip = (Math.Max(1, page) - 1) * 100;
        // One query: the plan is the live personal subscription (none = Free),
        // storage is core.user_storage (the enforced figure), the trial is by
        // phone fingerprint. No phone column is selected.
        var rows = await db.Database.SqlQuery<Row>($"""
            SELECT u.id AS "UserId", u.email::text AS "Email", u.display_name AS "DisplayName",
                   pa.created_at AS "CreatedAt", u.last_login_at AS "LastLoginAt",
                   COALESCE(p.name, 'Personal Free') AS "PlanName",
                   st.quota_bytes AS "QuotaBytes", st.used_bytes AS "UsedBytes",
                   tr.ends_at AS "TrialEndsAt",
                   pa.suspended_at AS "SuspendedAt", pa.suspended_reason AS "SuspendedReason",
                   pa.delete_after AS "DeleteAfter", pa.deletion_reason AS "DeletionReason"
              FROM core.personal_accounts pa
              JOIN core.users u ON u.id = pa.user_id
              LEFT JOIN LATERAL (SELECT s.plan_id FROM core.subscriptions s
                                  WHERE s.user_id = u.id AND s.status IN ('trial','active','past_due')
                                  ORDER BY s.started_at DESC LIMIT 1) sub ON true
              LEFT JOIN core.plans p ON p.id = sub.plan_id
              LEFT JOIN core.ai_trials tr ON tr.phone_hash = pa.phone_hash
              CROSS JOIN LATERAL core.user_storage(u.id) st
             WHERE pa.tenant_id = {house}
               AND u.email::text ILIKE {like}
               AND ({f} = 'all'
                    OR ({f} = 'free' AND sub.plan_id IS NULL)
                    OR ({f} = 'paid' AND sub.plan_id IS NOT NULL)
                    OR ({f} = 'suspended' AND pa.suspended_at IS NOT NULL)
                    OR ({f} = 'deleting' AND pa.delete_after IS NOT NULL))
             ORDER BY pa.created_at DESC
             OFFSET {skip} LIMIT 100
            """).ToListAsync(ct);

        var now = DateTimeOffset.UtcNow;
        return Results.Ok(new
        {
            rows = rows.Select(r => new
            {
                r.UserId, r.Email, r.DisplayName, r.CreatedAt, r.LastLoginAt,
                plan = (r.PlanName ?? "Personal Free").Replace("Personal ", ""),
                r.QuotaBytes, r.UsedBytes,
                trial = r.TrialEndsAt is null ? "none" : r.TrialEndsAt > now ? "running" : "used",
                r.TrialEndsAt,
                status = r.DeleteAfter is not null ? "deleting" : r.SuspendedAt is not null ? "suspended" : "active",
                r.SuspendedReason, r.DeleteAfter, r.DeletionReason,
                // Part E (sending pauses) fills this; until then, never paused.
                sending = r.SuspendedAt is not null ? "blocked" : "normal",
            }),
        });
    }

    private sealed class DayCount { public DateTime Day { get; set; } public long Count { get; set; } }

    private static async Task<IResult> StatsAsync(AppDbContext db, PersonalHouse houses, TenantContext tenant, CancellationToken ct)
    {
        if (await houses.HouseIdAsync(ct) is not Guid house) return Results.Ok(new { });
        tenant.EnterPlatformScope(house, tenant.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);

        var since = DateTimeOffset.UtcNow.AddDays(-14);
        var signups = await db.Database.SqlQuery<DayCount>($"""
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS "Day", count(*) AS "Count"
              FROM core.personal_accounts WHERE tenant_id = {house} AND created_at >= {since}
             GROUP BY 1 ORDER BY 1
            """).ToListAsync(ct);
        // AI use during trials: tokens by day, from users whose trial window
        // covers the call. Counts, never content.
        var trialTokens = await db.Database.SqlQuery<DayCount>($"""
            SELECT (u.created_at AT TIME ZONE 'Asia/Kolkata')::date AS "Day",
                   sum(u.tokens_in + u.tokens_out) AS "Count"
              FROM core.ai_usage u
              JOIN core.ai_trials t ON t.user_id = u.user_id
                                   AND u.created_at BETWEEN t.started_at AND t.ends_at
             WHERE u.tenant_id = {house} AND u.created_at >= {since}
             GROUP BY 1 ORDER BY 1
            """).ToListAsync(ct);
        var trialsStarted = await db.AiTrials.CountAsync(ct);
        var converted = await (
            from t in db.AiTrials
            join s in db.Subscriptions.IgnoreQueryFilters() on t.UserId equals s.UserId
            join p in db.Plans on s.PlanId equals p.Id
            where s.Status == "active" && p.Id == new Guid("b0000000-0000-0000-0000-000000000003")
            select t.PhoneHash).Distinct().CountAsync(ct);

        return Results.Ok(new
        {
            accounts = await db.PersonalAccounts.IgnoreQueryFilters().CountAsync(a => a.TenantId == house, ct),
            signupsByDay = signups.Select(d => new { day = d.Day.ToString("yyyy-MM-dd"), count = d.Count }),
            trialsStarted, trialsConverted = converted,
            trialAiTokensByDay = trialTokens.Select(d => new { day = d.Day.ToString("yyyy-MM-dd"), tokens = d.Count }),
            suspended = await db.PersonalAccounts.IgnoreQueryFilters().CountAsync(a => a.TenantId == house && a.SuspendedAt != null, ct),
            deleting = await db.PersonalAccounts.IgnoreQueryFilters().CountAsync(a => a.TenantId == house && a.DeleteAfter != null, ct),
            purgeLeftovers = await db.PurgeLeftovers.CountAsync(ct),
            // Part E.
            sendingPauses = (int?)null,
        });
    }

    public sealed record ReasonRequest(string? Reason, string? ConfirmAddress = null);

    /// <summary>The account, in platform scope, if it is a personal one.</summary>
    private static async Task<string?> PersonalEmailAsync(Guid userId, AppDbContext db, PersonalHouse houses, TenantContext tenant, CancellationToken ct)
    {
        var u = await db.Users.IgnoreQueryFilters().AsNoTracking().Where(x => x.Id == userId)
            .Select(x => new { x.TenantId, x.Email }).FirstOrDefaultAsync(ct);
        if (u is null || !await houses.IsPersonalHouseAsync(u.TenantId, ct)) return null;
        tenant.EnterPlatformScope(u.TenantId, tenant.UserId ?? Guid.Empty);
        await db.SyncTenantAsync(ct);
        return u.Email;
    }

    private static async Task<IResult> SuspendAsync(
        Guid userId, ReasonRequest req, AppDbContext db, PersonalHouse houses, TenantContext tenant,
        PersonalLifecycle life, CancellationToken ct)
    {
        var operatorId = tenant.UserId ?? Guid.Empty;
        if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "Give the reason. It is kept with the suspension." });
        if (await PersonalEmailAsync(userId, db, houses, tenant, ct) is null) return Results.NotFound(NotPersonal);
        await life.SuspendAsync(userId, operatorId, req.Reason.Trim(), ct);
        return Results.Ok(new { suspended = true });
    }

    private static async Task<IResult> ResumeAsync(
        Guid userId, AppDbContext db, PersonalHouse houses, TenantContext tenant, PersonalLifecycle life, CancellationToken ct)
    {
        if (await PersonalEmailAsync(userId, db, houses, tenant, ct) is null) return Results.NotFound(NotPersonal);
        return await life.ResumeAsync(userId, ct) ? Results.Ok(new { resumed = true })
            : Results.BadRequest(new { error = "That account is not suspended." });
    }

    /// <summary>
    /// The operator deletes (§9). The address must be typed back — the one
    /// action on this console that cannot be undone gets the one extra step.
    /// It happens at the next lifecycle pass (or /run), not in this request.
    /// </summary>
    private static async Task<IResult> OperatorDeleteAsync(
        Guid userId, ReasonRequest req, AppDbContext db, PersonalHouse houses, TenantContext tenant,
        PersonalLifecycle life, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Reason)) return Results.BadRequest(new { error = "Give the reason. It is kept in the audit log." });
        if (await PersonalEmailAsync(userId, db, houses, tenant, ct) is not string email) return Results.NotFound(NotPersonal);
        if (!string.Equals(req.ConfirmAddress?.Trim(), email, StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "Type the account's address exactly to confirm." });
        await life.OperatorDeleteAsync(userId, req.Reason.Trim(), ct);
        return Results.Ok(new { scheduled = true });
    }

    private static async Task<IResult> RunAsync(PersonalLifecycle life, CancellationToken ct) =>
        Results.Ok(await life.RunPassAsync(ct));
}
