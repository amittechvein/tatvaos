using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Per-product AI switches, on top of the organisation's consent.
///
/// ─────────────────────────────────────────────────────────────────────────
///  core.tenants.allow_ai says "this organisation's content may go to the AI
///  provider". It was enough while meeting minutes were the only caller.
///  Mail is the first product an organisation may want to keep out on its
///  own (Amit, 25 Sept 2026: "Mail ai on/off switch") — see
///  20260925-mail-ai-switch.sql for why.
///
///  Keyed by the FEATURE LABEL every request has carried since PR 280, and
///  checked in MeteredAiGateway beside the consent check, so a Mail feature
///  that forgets to ask is refused anyway. Fail-closed: if the switch cannot
///  be read, the answer is no.
///
///  A new product that wants its own switch adds a prefix and a column here;
///  products without one (connect.*, docs) are governed by allow_ai alone,
///  exactly as before.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiProductSwitch
{
    public const string MailPrefix = "mail.";

    public const string MailOff =
        "TatvaOS AI is not switched on for Mail in this organisation. An administrator can turn it on "
        + "under TatvaOS AI.";

    /// <summary>Sorting incoming mail: needs Mail AI AND its own switch.</summary>
    public const string MailTriageFeature = "mail.triage";

    public const string MailTriageOff =
        "Sorting incoming mail with TatvaOS AI is not switched on for this organisation.";

    /// <summary>
    /// Organisation types sorting is NOT offered to. Amit, 25 Sept 2026:
    /// "Don't offer sorting to clinics yet" — sorting sends every new email,
    /// patients' included, to a provider in the United States with nobody
    /// clicking, and that waits for an India-region provider (the move
    /// OpenAiGateway's header already ties to "the moment a hospital asks").
    /// Clinics sign up as "hospital"; after sign-up only the platform operator
    /// can change a type, so an organisation cannot relabel itself round this.
    /// Help me write and suggested replies stay available to them.
    /// </summary>
    public static readonly string[] TriageNotOfferedTo = ["hospital"];

    public const string MailTriageNotOffered =
        "Sorting incoming mail is not available for hospitals and clinics yet. It will be offered once "
        + "TatvaOS AI runs on a service in India.";

    public static bool TriageOfferedTo(string? orgType) =>
        !TriageNotOfferedTo.Contains((orgType ?? "").Trim().ToLowerInvariant());

    /// <summary>
    /// Whether the CURRENT tenant has sorting on (mail_ai_triage_since set).
    /// Fail-closed, like the Mail switch.
    /// </summary>
    public static async Task<bool> TriageAllowedAsync(
        AppDbContext db, TenantContext tenant, ILogger log, CancellationToken ct)
    {
        if (!tenant.HasTenant) return false;
        try
        {
            // Switched on AND offered to this kind of organisation: a type
            // changed to hospital after sorting was on stops it here too.
            var row = await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId)
                .Select(t => new { On = t.MailAiTriageSince != null, t.Type })
                .FirstOrDefaultAsync(ct);
            return row is not null && row.On && TriageOfferedTo(row.Type);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read the Mail AI sorting switch for tenant {Tenant} — refused fail-closed.",
                tenant.TenantId);
            return false;
        }
    }

    // ── WHICH ORGANISATIONS MAY USE MAIL AI AT ALL ───────────────────────────
    //
    //  Mr. Singh, 25 Sept 2026, after Mail AI shipped ahead of its privacy
    //  text: "Until they're live, either show the Mail AI switches only to
    //  Techvein's organisation, or tell me why that's harder than I think."
    //  It is a platform setting (ai.mail.organisations), not code, so it is
    //  lifted by emptying it on the Settings page — no deploy.
    //
    //  Checked HERE, inside MailAllowedAsync, which every mail.* request
    //  already passes through in the gateway — so Help me write, suggested
    //  replies and sorting are all behind it without a line in any of them.
    //
    //    row missing / empty  → every organisation may (no gate)
    //    a list of ids        → only those
    //    unreadable           → nobody (fail-closed, like every switch here)
    //    ids that do not parse are ignored and logged; a list with NONE that
    //    parses allows nobody — a typo must not open the gate.

    public const string MailNotOffered =
        "TatvaOS AI in Mail is not available for your organisation yet. It will be offered once our "
        + "privacy policy has been updated to describe it.";

    /// <summary>Whether this organisation is on the Mail AI list (or there is no list). Fail-closed.</summary>
    public static async Task<bool> MailOfferedToAsync(AppDbContext db, Guid tenantId, ILogger log, CancellationToken ct)
    {
        try
        {
            var all = await new SettingsReader(db).GetAsync(ct);
            if (!all.TryGetValue(SettingKeys.AiMailOrganisations, out var raw) || string.IsNullOrWhiteSpace(raw))
                return true;
            var ids = ParseOrganisations(raw, log);
            return ids.Contains(tenantId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read {Key}; Mail AI refused fail-closed for tenant {Tenant}.",
                SettingKeys.AiMailOrganisations, tenantId);
            return false;
        }
    }

    /// <summary>The ids in the setting. Bad entries are logged and skipped.</summary>
    public static HashSet<Guid> ParseOrganisations(string raw, ILogger? log = null)
    {
        var ids = new HashSet<Guid>();
        foreach (var part in raw.Split([',', ';', ' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (Guid.TryParse(part, out var id)) ids.Add(id);
            else log?.LogWarning("{Key} has an entry that is not an organisation id: '{Entry}' (ignored).",
                SettingKeys.AiMailOrganisations, part);
        }
        return ids;
    }

    public static bool IsMail(string feature) =>
        feature.StartsWith(MailPrefix, StringComparison.Ordinal);

    // ── EACH MAIL FEATURE'S OWN SWITCH (26 Sept 2026) ────────────────────────
    public const string MailRewriteFeature = "mail.rewrite";
    public const string MailSuggestFeature = "mail.suggest";
    public const string MailSummaryFeature = "mail.summary";

    /// <summary>
    /// What each feature starts as when an organisation first turns Mail AI
    /// on, and what the operator's offer action resets it to. Only Help me
    /// write starts on: it sends a person's own draft, when they ask.
    /// Suggested replies send someone ELSE's email the moment it is opened,
    /// with nobody asking, so the administrator turns them on deliberately,
    /// like Summarise and sorting (Mr. Singh, 30 Sept 2026). The column
    /// defaults in local/postgres/init must say the same.
    /// </summary>
    public const bool DefaultRewrite = true;
    public const bool DefaultSuggest = false;
    public const bool DefaultSummary = false;

    public const string MailFeatureOff =
        "This TatvaOS AI feature is switched off for your organisation. An administrator can turn it on "
        + "under TatvaOS AI.";

    /// <summary>Which Mail features this organisation has on (each inside Mail AI).</summary>
    public sealed record MailFeatures(bool Rewrite, bool Suggest, bool Summary);

    public static async Task<MailFeatures> MailFeaturesAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var f = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == tenantId)
            .Select(t => new MailFeatures(t.MailAiRewrite, t.MailAiSuggest, t.MailAiSummary))
            .FirstOrDefaultAsync(ct);
        return f ?? new MailFeatures(false, false, false);
    }

    /// <summary>
    /// Whether a mail.* feature label is on for this organisation. Sorting
    /// (mail.triage) has its own check, TriageAllowedAsync. An unknown mail.*
    /// label is REFUSED: a new Mail feature must be given a switch here, or it
    /// would ride on the Mail consent without an administrator being able to
    /// turn it off.
    /// </summary>
    public static bool FeatureOn(MailFeatures f, string feature) => feature switch
    {
        MailRewriteFeature => f.Rewrite,
        MailSuggestFeature => f.Suggest,
        MailSummaryFeature => f.Summary,
        MailTriageFeature => true,
        _ => false,
    };

    /// <summary>
    /// Whether the CURRENT tenant has Mail AI on. Says nothing about allow_ai;
    /// the gateway checks that first, and the status endpoint checks both.
    /// </summary>
    public static async Task<bool> MailAllowedAsync(
        AppDbContext db, TenantContext tenant, ILogger log, CancellationToken ct, string? feature = null)
    {
        if (!tenant.HasTenant) return false;
        try
        {
            var on = await db.Tenants.AsNoTracking()
                .Where(t => t.Id == tenant.TenantId)
                .Select(t => t.AllowMailAi)
                .FirstOrDefaultAsync(ct);
            // Switched on AND on the Mail AI list (or there is no list) AND,
            // when a feature is named, that feature's own switch is on.
            if (!on || !await MailOfferedToAsync(db, tenant.TenantId, log, ct)) return false;
            return feature is null || FeatureOn(await MailFeaturesAsync(db, tenant.TenantId, ct), feature);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read the Mail AI switch for tenant {Tenant} — refused fail-closed.",
                tenant.TenantId);
            return false;
        }
    }
}
