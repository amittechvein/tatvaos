using Microsoft.Extensions.Logging;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Which organisations may use TatvaOS AI in Mail: the platform setting
/// ai.mail.organisations, read. Its own file, with nothing but the rule in
/// it, so tests/ai/mail-ai-list can compile it and ask it every question.
///
/// ─────────────────────────────────────────────────────────────────────────
///  EMPTY MEANS NONE (Mr. Singh, 29 Sept 2026).
///
///  It meant EVERYONE until then: a missing row, an empty value, a value of
///  spaces — each opened Mail AI to every organisation on the platform. That
///  is the "empty means everyone" shape he had already ruled against for
///  recording sharing's test list, and the failure it invites is the quiet
///  one: a setting cleared by accident, a row lost in a restore, a
///  settings screen that saves "" for "nothing typed", and the gate is open
///  with nothing on any screen saying so.
///
///    missing / empty / blank   → nobody
///    exactly "all"             → every organisation (the word, alone)
///    organisation ids          → only those
///    ids that do not parse     → ignored and logged; none that parse → nobody
///
///  "all" counts only on its own. Mixed into a list it is an entry that is
///  not an id, ignored like any other, and the list rules: "all, <id>" is
///  that one organisation, not everyone.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailAiOrganisationList
{
    public const string Everyone = "all";

    public static bool Allows(string? raw, Guid tenantId, ILogger? log = null)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        if (string.Equals(raw.Trim(), Everyone, StringComparison.OrdinalIgnoreCase)) return true;
        return Parse(raw, log).Contains(tenantId);
    }

    /// <summary>The ids in the setting. Bad entries are logged and skipped.</summary>
    public static HashSet<Guid> Parse(string raw, ILogger? log = null)
    {
        var ids = new HashSet<Guid>();
        foreach (var part in raw.Split([',', ';', ' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (Guid.TryParse(part, out var id)) ids.Add(id);
            else log?.LogWarning("ai.mail.organisations has an entry that is not an organisation id: '{Entry}' (ignored).", part);
        }
        return ids;
    }
}
