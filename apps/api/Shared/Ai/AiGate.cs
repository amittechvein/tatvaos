using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Which organisations may use each TatvaOS AI feature: every feature label,
/// and the platform setting that lists the organisations allowed to use it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY (Mr. Singh, 30 Sept 2026)
///
///  On 25 Sept a customer used Mail AI before its privacy text existed,
///  because the feature went live ahead of its disclosure. The Techvein-only
///  list stopped them the next morning; this makes the order impossible to
///  get wrong again:
///
///    * every AI feature has a list, here, and ships with it EMPTY — which
///      means nobody (PR 360) — until its disclosure is live;
///    * the feature's code and its entry here go in the same PR;
///    * a label that is NOT here is refused (fail-closed), in the gateway;
///    * every method that sends anything to an AI provider calls
///      AllowedAsync first — tests/ai/every-ai-entry-calls-gate.sh fails the
///      build when one does not.
///
///  The organisation's own switches (allow_ai, Mail's) are still the
///  CONSENT. This list is OURS: whether we offer the feature to them yet.
///
///  The lists and their starting values (Mr. Singh, 30 Sept):
///    ai.mail.organisations      Techvein until the Mail AI text is live
///    ai.connect.organisations   all — minutes' disclosure is live; each
///                               organisation's allow_ai stays the consent
///    ai.docs.organisations      empty — Docs is off for everyone
///    ai.sheets.organisations    empty — Sheets is off for everyone (added
///                               2 Oct 2026, when Sheets merged after this)
///  20260930-ai-feature-lists.sql writes the Connect and Docs rows ONCE, if
///  absent, so the deploy that brings this in cannot switch minutes off by
///  a forgotten setting.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiGate
{
    /// <summary>Every AI feature label, and its list. A new feature adds a line here, in its own PR.</summary>
    public static readonly IReadOnlyDictionary<string, string> Features = new Dictionary<string, string>
    {
        [AiProductSwitch.MailRewriteFeature] = SettingKeys.AiMailOrganisations,
        [AiProductSwitch.MailSuggestFeature] = SettingKeys.AiMailOrganisations,
        [AiProductSwitch.MailSummaryFeature] = SettingKeys.AiMailOrganisations,
        [AiProductSwitch.MailTriageFeature] = SettingKeys.AiMailOrganisations,
        [ConnectMinutes] = SettingKeys.AiConnectOrganisations,
        // A recording's AUDIO, uploaded to a transcription service. Not
        // through IAiGateway (ConnectTranscriber posts it itself), which is
        // why it is named here and gated where it is sent.
        [ConnectTranscription] = SettingKeys.AiConnectOrganisations,
        [Docs] = SettingKeys.AiDocsOrganisations,
        // Sheets (merged 1 Oct 2026, after this registry was written): its own
        // list, EMPTY until Sheets AI has a disclosure - the same start as Docs.
        [Sheets] = SettingKeys.AiSheetsOrganisations,
    };

    public const string ConnectMinutes = "connect.minutes";
    public const string ConnectTranscription = "connect.transcription";
    public const string Docs = "docs";
    public const string Sheets = "sheets";

    /// <summary>
    /// Labels that carry nothing of any organisation's and need no list: the
    /// operator's probe sends a fixed "ping" (AiStatusEndpoints). Kept to a
    /// named, reviewed list rather than a pattern.
    /// </summary>
    public static readonly IReadOnlySet<string> NoOrganisationContent = new HashSet<string> { "platform.probe" };

    public const string NotOffered =
        "This TatvaOS AI feature is not available for your organisation yet.";

    /// <summary>The sentence to show when a feature is refused here.</summary>
    public static string RefusalFor(string feature) =>
        AiProductSwitch.IsMail(feature) ? AiProductSwitch.MailNotOffered : NotOffered;

    /// <summary>
    /// Whether this organisation is on the list for this feature. Unknown
    /// label, no organisation, or a setting that cannot be read: no.
    /// </summary>
    public static async Task<bool> AllowedAsync(
        AppDbContext db, Guid? tenantId, string feature, ILogger log, CancellationToken ct)
    {
        if (NoOrganisationContent.Contains(feature)) return true;
        if (!Features.TryGetValue(feature, out var key))
        {
            log.LogError("AI feature '{Feature}' has no organisation list (AiGate.Features) - refused. "
                + "A new AI feature must add its list in the same PR.", feature);
            return false;
        }
        if (tenantId is not Guid id || id == Guid.Empty) return false;
        try
        {
            var raw = await new SettingsReader(db).GetAsync(key, ct);
            return MailAiOrganisationList.Allows(raw, id, log);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Could not read {Key}; AI feature {Feature} refused fail-closed for tenant {Tenant}.",
                key, feature, id);
            return false;
        }
    }
}
