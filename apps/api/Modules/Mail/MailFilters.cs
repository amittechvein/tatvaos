using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// The meaning of a filter rule, in one place.
///
/// ─────────────────────────────────────────────────────────────────────────
///  The rule's conditions and actions live in jsonb, which the database
///  cannot validate. This file is what makes that safe: the API parses
///  incoming rules through here before writing, and the ingest worker
///  evaluates through here when mail arrives. One definition, so a rule
///  cannot mean one thing when it is saved and another when it runs.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailFilters
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Fields a condition may test. Anything else is rejected.</summary>
    public static readonly string[] Fields = ["from", "to", "subject", "body"];

    /// <summary>Comparisons a condition may use.</summary>
    public static readonly string[] Ops = ["contains", "equals"];

    public sealed record Condition(string Field, string Op, string Value);

    /// <param name="CategoryId">
    /// The colour category to apply, or null. APPENDED WITH A DEFAULT on
    /// purpose: `actions` is jsonb, so every rule written before categories
    /// existed deserialises with this null and behaves exactly as it did.
    /// Adding a category action needed no migration and no change to the
    /// engine — which is the payoff for the ruling that people write the
    /// rules rather than the product guessing.
    /// </param>
    public sealed record Actions(
        Guid? MoveToFolderId, bool MarkRead, bool Flag, Guid? CategoryId = null)
    {
        /// <summary>A rule that does nothing is a rule someone will file a bug about.</summary>
        public bool IsEmpty => MoveToFolderId is null && !MarkRead && !Flag;
    }

    // ------------------------------------------------------------------
    //  Parsing. Both sides read rules through these, and both tolerate
    //  malformed JSON by returning empty rather than throwing — a corrupt
    //  rule must never stop mail being delivered.
    // ------------------------------------------------------------------
    public static List<Condition> ParseConditions(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<Condition>>(json, Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static Actions ParseActions(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new Actions(null, false, false);
        try
        {
            return JsonSerializer.Deserialize<Actions>(json, Json)
                   ?? new Actions(null, false, false);
        }
        catch (JsonException)
        {
            return new Actions(null, false, false);
        }
    }

    public static string Serialise(IEnumerable<Condition> conditions) =>
        JsonSerializer.Serialize(conditions, Json);

    public static string Serialise(Actions actions) =>
        JsonSerializer.Serialize(actions, Json);

    /// <summary>
    /// Normalises and validates what a client sent. Returns null with a reason
    /// rather than throwing, so the endpoint can answer 400 with something a
    /// person can act on.
    /// </summary>
    public static (List<Condition>? Conditions, string? Error) ValidateConditions(
        IEnumerable<Condition>? incoming)
    {
        var list = incoming?.ToList() ?? [];
        if (list.Count == 0)
            return (null, "A rule needs at least one condition.");

        var cleaned = new List<Condition>();
        foreach (var c in list)
        {
            var field = (c.Field ?? "").Trim().ToLowerInvariant();
            var op = (c.Op ?? "").Trim().ToLowerInvariant();
            var value = (c.Value ?? "").Trim();

            if (!Fields.Contains(field))
                return (null, $"\"{c.Field}\" is not something a rule can match on.");
            if (!Ops.Contains(op))
                return (null, $"\"{c.Op}\" is not a comparison a rule can use.");
            if (value.Length == 0)
                return (null, "A condition needs something to match against.");

            cleaned.Add(new Condition(field, op, value));
        }
        return (cleaned, null);
    }

    // ------------------------------------------------------------------
    //  Evaluation
    // ------------------------------------------------------------------

    /// <summary>The parts of a message a rule can see.</summary>
    public sealed record Subject(
        string? From, IEnumerable<string>? To, string? Title, string? Body);

    private static bool Test(Condition c, Subject m)
    {
        // Null-safe: a message with no subject simply does not match a
        // subject rule, rather than blowing up mid-ingest.
        var haystack = c.Field switch
        {
            "from" => m.From ?? "",
            "to" => string.Join(' ', m.To ?? []),
            "subject" => m.Title ?? "",
            "body" => m.Body ?? "",
            _ => "",
        };

        return c.Op switch
        {
            "contains" => haystack.Contains(c.Value, StringComparison.OrdinalIgnoreCase),
            "equals" => haystack.Equals(c.Value, StringComparison.OrdinalIgnoreCase),
            _ => false,
        };
    }

    /// <summary>
    /// Does this rule apply to this message?
    ///
    /// A rule with no conditions matches NOTHING, deliberately. The opposite —
    /// treating "no conditions" as "everything" — turns a half-finished rule
    /// into one that silently files every message the person receives.
    /// </summary>
    public static bool Matches(IReadOnlyList<Condition> conditions, bool matchAll, Subject m)
    {
        if (conditions.Count == 0) return false;
        return matchAll ? conditions.All(c => Test(c, m)) : conditions.Any(c => Test(c, m));
    }
}
