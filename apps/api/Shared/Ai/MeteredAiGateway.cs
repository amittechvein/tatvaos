using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// The AI gateway every module actually gets: the provider gateway
/// (OpenAiGateway) wrapped in metering and limits.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY A WRAPPER
///
///  Mr. Singh's ruling, 24 Sept 2026, on TatvaOS Docs putting AI one click
///  away: metering is mandatory and comes first; limits second and
///  generous; and a platform-wide stop. Enforcing them HERE, where
///  IAiGateway is resolved, means no module can forget them — the same
///  reasoning that put the consent check inside CompleteAsync. The provider
///  code is untouched and still knows nothing of limits.
///
///  ORDER OF CHECKS, and what each costs the customer:
///    1. not configured / no consent → the inner gateway's own refusal,
///       NOT metered (nothing was about to be sent)
///   1b. a product switch that is off (mail.* needs allow_mail_ai;
///       mail.triage also needs mail_ai_triage_since — AiProductSwitch)
///       → refused, NOT metered, for the same reason
///    2. the operator's pause        → refused_paused
///    3. the person's hourly limit   → refused_person_limit
///    4. the organisation's month    → refused_org_limit
///    5. the provider                → ok | failed, with its token counts
///  Every step from 2 on writes one core.ai_usage row. Refusals too: a flood
///  of them is what abuse looks like.
///
///  FAIL-CLOSED. If usage cannot be read, the request is not sent — the same
///  stance as the consent check. If usage cannot be WRITTEN after a call, the
///  answer is still returned (the money is already spent) and the failure is
///  logged as an error, because an unmetered call is exactly what this class
///  exists to prevent and someone must see it.
///
///  NEVER CONTENT. Counts, feature, outcome, who, when.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class MeteredAiGateway(
    IServiceProvider services, AppDbContext db, TenantContext tenant, SettingsReader settings,
    SystemMailer mailer, IConfiguration config, ILogger<MeteredAiGateway> log) : IAiGateway
{
    /// <summary>
    /// The provider, constructed HERE and nowhere else. OpenAiGateway is not
    /// registered in DI, so it cannot be injected around this class; building
    /// it with ActivatorUtilities still gives it its own dependencies from the
    /// same scope (the same TenantContext and AppDbContext as this request).
    /// </summary>
    private readonly OpenAiGateway inner = ActivatorUtilities.CreateInstance<OpenAiGateway>(services);

    /// <summary>
    /// Used only when a setting row is MISSING altogether (the migration seeds
    /// both, so this is a fail-safe, not a configuration). An EMPTY value means
    /// no limit; 0 means none allowed — Mr. Singh on PR 280: zero must mean zero.
    /// </summary>
    public const int DefaultPerPersonPerHour = 50;
    public const long DefaultOrgMonthlyTokens = 2_000_000;

    private static readonly System.Text.RegularExpressions.Regex FeaturePattern =
        new("^[a-z][a-z0-9._-]{0,63}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>India has no daylight saving; a fixed offset is exact, and needs no tzdata in the container.</summary>
    private static readonly TimeSpan India = TimeSpan.FromMinutes(330);

    public bool IsConfigured => inner.IsConfigured;
    public string Model => inner.Model;
    public string? DataLocation => inner.DataLocation;
    public string? Vendor => inner.Vendor;
    public Task<bool> EnabledForTenantAsync(CancellationToken ct) => inner.EnabledForTenantAsync(ct);

    /// <summary>The limits in force. NULL means no limit; 0 means none allowed.</summary>
    public sealed record Limits(bool Paused, int? PerPersonPerHour, long? OrgMonthlyTokens);

    /// <summary>
    /// The limits in force, from the operator's settings. One reader for the
    /// gateway and the screens.
    ///   row missing        → the default (the migration seeds both rows)
    ///   value empty        → NO limit (null)
    ///   value a number ≥ 0 → that number; 0 allows none
    ///   anything else      → the default, and a warning: a typo must not
    ///                        silently mean "unlimited"
    /// </summary>
    public static async Task<Limits> ReadLimitsAsync(SettingsReader settings, CancellationToken ct, ILogger? log = null)
    {
        var all = await settings.GetAsync(ct);
        var paused = all.TryGetValue(SettingKeys.AiPaused, out var p)
                     && string.Equals(p?.Trim(), "true", StringComparison.OrdinalIgnoreCase);
        return new Limits(paused,
            (int?)Read(all, SettingKeys.AiPerPersonPerHour, DefaultPerPersonPerHour, int.MaxValue, log),
            Read(all, SettingKeys.AiOrgMonthlyTokens, DefaultOrgMonthlyTokens, long.MaxValue, log));
    }

    private static long? Read(Dictionary<string, string> all, string key, long fallback, long max, ILogger? log)
    {
        if (!all.TryGetValue(key, out var raw)) return fallback;
        var v = raw.Trim().Replace(",", "").Replace("_", "");
        if (v.Length == 0) return null;
        if (long.TryParse(v, out var n) && n >= 0 && n <= max) return n;
        log?.LogWarning("Setting {Key} is not a whole number ('{Raw}'); using the default {Fallback}.", key, raw, fallback);
        return fallback;
    }

    /// <summary>
    /// The instant the current month began, India time — the month customers
    /// think in — RETURNED IN UTC. Npgsql refuses to send a timestamptz with
    /// any other offset (measured: "Cannot write DateTimeOffset with
    /// Offset=05:30:00"), and the first version of this failed closed on every
    /// request because of it.
    /// </summary>
    public static DateTimeOffset MonthStart(DateTimeOffset now)
    {
        var local = now.ToOffset(India);
        return new DateTimeOffset(local.Year, local.Month, 1, 0, 0, 0, India).ToUniversalTime();
    }

    /// <summary>
    /// The month as a DATE, India time (the alert key). NOT derived from
    /// MonthStart: in UTC that instant is the previous day at 18:30, which
    /// would name the previous month.
    /// </summary>
    public static DateOnly MonthOf(DateTimeOffset now)
    {
        var local = now.ToOffset(India);
        return new DateOnly(local.Year, local.Month, 1);
    }

    /// <summary>Tokens the CURRENT tenant has spent this month (ok and failed calls — both reached the provider).</summary>
    public static async Task<long> MonthTokensAsync(AppDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var from = MonthStart(now);
        return await db.AiUsage.AsNoTracking()
            .Where(u => u.CreatedAt >= from && (u.Outcome == "ok" || u.Outcome == "failed"))
            .SumAsync(u => (long)u.TokensIn + u.TokensOut, ct);
    }

    public async Task<AiResult> CompleteAsync(
        string instruction, string input, CancellationToken ct, string feature)
    {
        // 0. No valid label, no request. Not metered — there is no honest
        //    bucket to meter it under — but loud, because it is a code bug.
        if (feature is null || !FeaturePattern.IsMatch(feature))
        {
            log.LogError("AI request REFUSED: missing or invalid feature label '{Feature}'. Every caller must name its feature.",
                feature ?? "(null)");
            return AiResult.Failed("This AI request could not be sent (it did not say which feature it was for).");
        }

        // 0b. A personal account has no organisation and no administrator,
        //     so the provider gateway's refusal ("an administrator can switch
        //     it on") would be wrong words. Its own, here, unmetered.
        var personal = tenant.HasTenant && await services.GetRequiredService<TatvaOS.Api.Modules.Personal.PersonalHouse>()
            .IsPersonalHouseAsync(tenant.TenantId, ct);
        if (personal && inner.IsConfigured && !await inner.EnabledForTenantAsync(ct))
            return AiResult.Failed("Switch AI on in your Account settings first.");

        // 1. Nothing will be sent: let the provider gateway give its own
        //    refusal, unmetered.
        if (!inner.IsConfigured || !tenant.HasTenant || !await inner.EnabledForTenantAsync(ct))
            return await inner.CompleteAsync(instruction, input, ct, feature);

        // 1a. Is this feature offered to this organisation at all (AiGate,
        //     30 Sept 2026)? Every label has a list; one without is refused.
        //     Before the product switches, so a feature shipped ahead of its
        //     disclosure is refused here whatever an administrator switched on.
        if (!await AiGate.AllowedAsync(db, tenant.TenantId, feature, log, ct))
            return AiResult.Failed(AiGate.RefusalFor(feature));

        // 1a-bis (merged 6 Oct 2026, round one): the AiGate above applies to the
        //     personal house too, so personal AI minutes are refused until the house
        //     is on the feature lists - a launch step, and it fails closed.
        // 1a. A PERSONAL account (build plan §4.5, §5): consent was the
        //     person's own switch (OpenAiGateway). Here, what their PLAN allows:
        //     AI meeting minutes only, on Premium or during their trial. Mail
        //     AI is out of scope for personal plans. Refused unmetered, like
        //     the product switches below: nothing was about to be sent.
        if (personal)
        {
            var refusal = await TatvaOS.Api.Modules.Personal.PersonalAiService.PlanRefusalAsync(
                services.GetRequiredService<TatvaOS.Api.Shared.Plans.EffectiveSettings>(), tenant.UserId, feature, ct);
            if (refusal is not null) return AiResult.Failed(refusal);
        }

        // 1b. The product's own switch, where it has one (Mail, 25 Sept 2026).
        //     Same standing as consent: nothing was about to be sent, so not
        //     metered — and refused here so no Mail caller can forget it.
        if (AiProductSwitch.IsMail(feature) && !await AiProductSwitch.MailAllowedAsync(db, tenant, log, ct))
            return AiResult.Failed(AiProductSwitch.MailOff);
        //     …and that feature's own switch (26 Sept 2026); an unknown mail.*
        //     label is refused (AiProductSwitch.FeatureOn).
        if (AiProductSwitch.IsMail(feature) && !await AiProductSwitch.MailAllowedAsync(db, tenant, log, ct, feature))
            return AiResult.Failed(AiProductSwitch.MailFeatureOff);
        //     Sorting incoming mail has a switch of its own on top (step 3):
        //     it sends mail nobody clicked on.
        if (feature == AiProductSwitch.MailTriageFeature
            && !await AiProductSwitch.TriageAllowedAsync(db, tenant, log, ct))
            return AiResult.Failed(AiProductSwitch.MailTriageOff);
        //     Docs AI's own switch (10 Oct 2026, #406): every docs.* label,
        //     so no Docs caller can forget it — as Mail's above.
        if (AiProductSwitch.IsDocs(feature) && !await AiProductSwitch.DocsAllowedAsync(db, tenant, log, ct))
            return AiResult.Failed(AiProductSwitch.DocsOff);

        var now = DateTimeOffset.UtcNow;
        var user = tenant.UserId;
        Limits limits;
        long monthUsed;
        AiCredits.Allowance credits;
        var creditsUsed = 0;
        var cost = AiCredits.CostOf(feature);
        try
        {
            limits = await ReadLimitsAsync(settings, ct, log);

            // 2. The operator's stop.
            if (limits.Paused)
            {
                await RecordAsync(feature, "refused_paused", 0, 0, ct);
                return AiResult.Failed(
                    "TatvaOS AI is paused across the platform for the moment. Everything else works as normal; please try again later.");
            }

            // 3. This person, last hour. Background work (no person) is
            //    counted against the organisation only.
            if (user is Guid uid && limits.PerPersonPerHour is int perHour)
            {
                var since = now.AddHours(-1);
                var recent = await db.AiUsage.AsNoTracking()
                    .CountAsync(u => u.UserId == uid && u.CreatedAt >= since
                                     && (u.Outcome == "ok" || u.Outcome == "failed"), ct);
                if (recent >= perHour)
                {
                    await RecordAsync(feature, "refused_person_limit", 0, 0, ct);
                    return AiResult.Failed(perHour == 0
                        ? "TatvaOS AI is not available to individual requests at the moment."
                        : $"You have used TatvaOS AI {perHour} times in the last hour, which is the limit. " +
                          "Please try again a little later.");
                }
            }

            // 4. This organisation, this month. null = no ceiling; 0 = none
            //    allowed (an operator stopping an organisation's AI).
            monthUsed = await MonthTokensAsync(db, now, ct);
            if (limits.OrgMonthlyTokens is long cap && monthUsed >= cap)
            {
                await RecordAsync(feature, "refused_org_limit", 0, 0, ct);
                return AiResult.Failed(
                    "Your organisation has used its TatvaOS AI allowance for this month. It renews on the 1st; " +
                    "an administrator can see the usage on the TatvaOS AI page.");
            }

            // 4b. This organisation's AI CREDITS this month (26 Sept 2026):
            //     from its plan (pooled, or per user × users) or the operator's
            //     override. Refused when this request would go past it — so
            //     100 % is a stop, not a suggestion. Recorded as an org-limit
            //     refusal (the ai_usage CHECK allows no new outcome word).
            credits = await AiCredits.AllowanceAsync(db, tenant.TenantId, ct);
            if (credits.Credits is int allowance && cost > 0)
            {
                creditsUsed = (await AiCredits.UsedThisMonthAsync(db, now, ct)).Used;
                if (creditsUsed + cost > allowance)
                {
                    await RecordAsync(feature, "refused_org_limit", 0, 0, ct);
                    return AiResult.Failed(AiCredits.OutOfCredits);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Fail closed: an unmetered, unlimited call is the one outcome
            // this class exists to prevent.
            log.LogWarning(ex, "AI usage could not be checked for tenant {Tenant}; request refused fail-closed.",
                tenant.TenantId);
            return AiResult.Failed("TatvaOS AI could not check your usage just now, so nothing was sent. Please try again.");
        }

        // 5. The provider.
        var result = await inner.CompleteAsync(instruction, input, ct, feature);
        await RecordAsync(feature, result.Error is null ? "ok" : "failed", result.TokensIn, result.TokensOut, ct);

        if (result.Error is null && limits.OrgMonthlyTokens is long ceiling && ceiling > 0)
            await MaybeWarnAsync(monthUsed + result.TokensIn + result.TokensOut, ceiling, now, ct);
        // Credits: warn at 80 % and 100 % of the allowance, once each a month.
        if (result.Error is null && credits.Credits is int creditCap && creditCap > 0 && cost > 0)
            await MaybeWarnAsync(creditsUsed + cost, creditCap, now, ct, credits: true);

        return result;
    }

    private async Task RecordAsync(string feature, string outcome, int tokensIn, int tokensOut, CancellationToken ct)
    {
        // Raw INSERT, not db.Add + SaveChanges: this DbContext belongs to the
        // CALLER, and SaveChanges would also write whatever the calling
        // feature has half-changed (or leave a failed row tracked for the
        // caller's next save to trip over).
        var f = string.IsNullOrWhiteSpace(feature) ? "other" : feature.Length > 64 ? feature[..64] : feature;
        var model = Model.Length > 100 ? Model[..100] : Model;
        try
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO core.ai_usage (tenant_id, user_id, feature, outcome, tokens_in, tokens_out, model)
                VALUES ({tenant.TenantId}, {tenant.UserId}, {f}, {outcome}, {Math.Max(0, tokensIn)}, {Math.Max(0, tokensOut)},
                        {model})
                """, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex,
                "AI USAGE NOT RECORDED: tenant {Tenant} feature {Feature} outcome {Outcome} {In}in/{Out}out. " +
                "This call is missing from metering.", tenant.TenantId, feature, outcome, tokensIn, tokensOut);
        }
    }

    /// <summary>
    /// Email the organisation's administrators once at 80 % and once at 100 %
    /// of the month's ceiling. Sent BEFORE the marker is written, as the
    /// storage warnings are: if mail fails, the next request tries again —
    /// a duplicate warning is better than a silent one.
    /// </summary>
    private async Task MaybeWarnAsync(long used, long ceiling, DateTimeOffset now, CancellationToken ct, bool credits = false)
    {
        short level = used >= ceiling ? (short)100 : used * 10 >= ceiling * 8 ? (short)80 : (short)0;
        if (level == 0) return;

        try
        {
            var month = MonthOf(now);
            // Keyed by the ceiling too: raising it mid-month means the new
            // one warns again when reached (Mr. Singh's note on PR 280).
            // Credits keep their own markers (ai_credit_alerts) so a credit
            // allowance equal to the token ceiling cannot swallow a warning.
            var sent = credits
                ? await db.AiCreditAlerts.AsNoTracking()
                    .Where(a => a.Month == month && a.Allowance == ceiling)
                    .Select(a => a.Level)
                    .ToListAsync(ct)
                : await db.AiUsageAlerts.AsNoTracking()
                    .Where(a => a.Month == month && a.Ceiling == ceiling)
                    .Select(a => a.Level)
                    .ToListAsync(ct);
            if (sent.Contains(level) || (level == 80 && sent.Contains((short)100))) return;

            var org = await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId).Select(t => t.Name).FirstOrDefaultAsync(ct) ?? "Your organisation";
            var admins = await db.Users.AsNoTracking()
                .Where(u => u.Status == "active" && (u.Role == "org_owner" || u.Role == "org_admin"))
                .Select(u => new { u.Email, u.DisplayName })
                .ToListAsync(ct);
            if (admins.Count == 0)
            {
                log.LogWarning("Tenant {Tenant} reached {Level}% of its AI allowance but has no active administrator to tell.",
                    tenant.TenantId, level);
                return;
            }

            var baseUrl = (config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');
            var percent = (int)Math.Min(100, used * 100 / ceiling);
            var delivered = 0;
            foreach (var a in admins)
                if (await mailer.SendHtmlAsync(a.Email,
                        AiUsageWarningEmail.Subject(org, level),
                        AiUsageWarningEmail.Html(a.DisplayName, org, baseUrl, level, percent),
                        from: "no_reply@tatvaos.com", ct))
                    delivered++;

            // SystemMailer reports failure by returning false, not by
            // throwing. Found in the local run: relying on an exception would
            // have written the marker after a failed send and lost the warning
            // for the rest of the month. No delivery, no marker — the next
            // request tries again.
            if (delivered == 0)
            {
                log.LogWarning("AI allowance warning for tenant {Tenant} at {Level}% could not be sent to any administrator; will retry.",
                    tenant.TenantId, level);
                return;
            }

            // Reaching 100 first (one large request) also settles 80: the
            // lesser warning would only arrive after the greater one. Raw SQL
            // for the same reason as RecordAsync; ON CONFLICT because two
            // requests can cross the line together.
            foreach (var lvl in level == 100 ? new short[] { 100, 80 } : new short[] { level })
            {
                if (credits)
                    await db.Database.ExecuteSqlInterpolatedAsync($"""
                        INSERT INTO core.ai_credit_alerts (tenant_id, month, level, allowance)
                        VALUES ({tenant.TenantId}, {month}, {lvl}, {(int)ceiling})
                        ON CONFLICT DO NOTHING
                        """, ct);
                else
                    await db.Database.ExecuteSqlInterpolatedAsync($"""
                        INSERT INTO core.ai_usage_alerts (tenant_id, month, level, ceiling)
                        VALUES ({tenant.TenantId}, {month}, {lvl}, {ceiling})
                        ON CONFLICT DO NOTHING
                        """, ct);
            }

            log.LogInformation("Warned {Delivered} of {Count} administrator(s) of tenant {Tenant}: AI allowance {Level}%",
                delivered, admins.Count, tenant.TenantId, level);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Logged, never thrown: the customer's AI answer is already in hand.
            // (Two requests crossing the line together can each send the
            // warning once before either marker lands — a duplicate, not a gap.)
            log.LogWarning(ex, "AI allowance warning for tenant {Tenant} at {Level}% did not complete.", tenant.TenantId, level);
        }
    }
}
