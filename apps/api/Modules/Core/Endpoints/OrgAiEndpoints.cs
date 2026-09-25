using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// The organisation's AI consent switch — the screen for core.tenants.allow_ai.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Until this existed the switch was a one-line UPDATE run by Techvein,
///  which is fine for Techvein and disqualifying in a sales call: "can we
///  turn it off ourselves?" must be answered with a screen, not a promise
///  that somebody else will run SQL.
///
///  ORG-ADMIN, not per-user, deliberately: consent to send an organisation's
///  content to an external AI provider is the organisation's decision, made
///  once by someone with the authority to make it — the same governance
///  shape as allow_public_links and allow_connect_recording.
///
///  The GET also reports whether the PLATFORM has AI at all (a key
///  configured), so the screen can say "AI is not available on this
///  platform" instead of showing a switch that flips nothing.
///
///  Every change is audited with who and when. For a hospital, "who agreed,
///  and when" is not metadata — it is the answer to the only question their
///  compliance officer will ask.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class OrgAiEndpoints
{
    public static void MapOrgAiEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/ai")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Org");

        g.MapGet("", GetAsync);
        g.MapPut("", PutAsync);
    }

    /// <summary>
    /// Either or both. Enabled is the organisation's consent (allow_ai);
    /// Mail is Mail's own switch on top of it (allow_mail_ai, 25 Sept 2026).
    /// </summary>
    public sealed record PutRequest(bool? Enabled, bool? Mail = null);

    private static async Task<IResult> GetAsync(
        AppDbContext db, TenantContext tenant, IAiGateway ai,
        TatvaOS.Api.Shared.Settings.SettingsReader settings, CancellationToken ct)
    {
        var row = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenant.TenantId)
            .Select(t => new { t.AllowAi, t.AllowMailAi })
            .FirstOrDefaultAsync(ct);
        if (row is null) return Results.NotFound();

        return Results.Ok(new
        {
            enabled = row.AllowAi,
            // Whether the platform can do AI at all. Without a key the switch
            // is honest about being decorative.
            platformConfigured = ai.IsConfigured,
            model = ai.IsConfigured ? ai.Model : null,
            // Where the data goes when enabled — said HERE, by the API, so the
            // consent screen can never soften it. The place comes from
            // Ai:DataLocation, which the gateway REQUIRES beside the key and
            // checks against the hosts it knows (api.openai.com is in the
            // United States); a vendor move that forgets this setting turns AI
            // off rather than letting this sentence go stale. Mr. Singh, 23
            // Sept 2026: "nobody will remember it exists" — so nothing has to.
            disclosure = ai.IsConfigured
                ? "When enabled, meeting transcripts from this organisation are "
                  + $"processed by TatvaOS AI on a third-party service in {ai.DataLocation}. "
                  + "Nothing is sent while this is off."
                : "TatvaOS AI is not configured on this platform. Nothing is sent.",
            // Mail's own switch. Meaningful only while `enabled` is on — the
            // gateway needs both — and the screen says so.
            mailEnabled = row.AllowMailAi,
            // What Mail sends, in the API's words for the same reason as
            // `disclosure`. Kept SEPARATE from it: that sentence is asserted
            // word for word by tests/ai/disclosure-matches-host.sh and mirrored
            // on the public privacy page, and changing what customers are told
            // goes past the CTO. This one grows as Mail's AI features do.
            mailDisclosure = ai.IsConfigured
                ? "When Mail AI is on, text a person chooses to send to TatvaOS AI (for example "
                  + "the draft they ask it to rewrite) is processed on a third-party service in "
                  + $"{ai.DataLocation}. Nothing is sent unless they ask."
                : "TatvaOS AI is not configured on this platform. Nothing is sent.",
            // This month's use against the allowance — the number the
            // administrator is emailed about at 80 % and 100 % (MeteredAiGateway).
            usage = await AiUsageReport.ThisMonthAsync(db, settings, ct),
        });
    }

    private static async Task<IResult> PutAsync(
        PutRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (req?.Enabled is null && req?.Mail is null)
            return Results.BadRequest(new { error = "Say on or off." });

        var row = await db.Tenants
            .FirstOrDefaultAsync(t => t.Id == tenant.TenantId, ct);
        if (row is null) return Results.NotFound();

        var before = new { allowAi = row.AllowAi, allowMailAi = row.AllowMailAi };
        if (req.Enabled is bool enabled) row.AllowAi = enabled;
        if (req.Mail is bool mail) row.AllowMailAi = mail;

        if (row.AllowAi == before.allowAi && row.AllowMailAi == before.allowMailAi)
            return Results.Ok(new { enabled = row.AllowAi, mailEnabled = row.AllowMailAi });   // idempotent, no audit noise

        await db.SaveChangesAsync(ct);

        // One audit row per switch that actually moved, each named for what
        // it did — "who turned Mail AI on" must be answerable on its own.
        //
        // productCode: NULL for the organisation's consent, "mail" for Mail's.
        // It said "core" until 25 Sept 2026, and "core" is NOT a row in
        // core.products (audit_logs.product_code is a foreign key to it): the
        // switch was saved by the SaveChanges above, then the audit insert
        // threw, so the administrator saw an error, AI was on anyway, and
        // "who agreed, and when" — the reason this screen exists — was never
        // written. Found by tests/ai/mail-ai.test.mjs. Core's audit rows have
        // always carried null (AuditWriter's own note).
        if (row.AllowAi != before.allowAi)
            await audit.WriteAsync("org.ai." + (row.AllowAi ? "enabled" : "disabled"),
                "core.tenant", row.Id.ToString(),
                before: new { allowAi = before.allowAi }, after: new { allowAi = row.AllowAi },
                ct: ct, productCode: null);
        if (row.AllowMailAi != before.allowMailAi)
            await audit.WriteAsync("org.ai.mail." + (row.AllowMailAi ? "enabled" : "disabled"),
                "core.tenant", row.Id.ToString(),
                before: new { allowMailAi = before.allowMailAi }, after: new { allowMailAi = row.AllowMailAi },
                ct: ct, productCode: "mail");

        return Results.Ok(new { enabled = row.AllowAi, mailEnabled = row.AllowMailAi });
    }
}
