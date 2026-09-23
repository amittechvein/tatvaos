namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Turns a conversation's stored Message-IDs into the two headers RFC 5322
/// threads a reply on: In-Reply-To (the direct parent) and References (the
/// ancestry, oldest first, parent last).
///
/// It is a pure function on purpose. The rule it encodes is small and reads as
/// obviously right, which is exactly the kind of rule this codebase has been
/// wrong about before — so it is kept out of the database call and driven
/// directly by tests/mail-threading.
///
/// Amit, 23 September 2026: replies to a courier's support desk arrived as new
/// conversations, and the desk opened a fresh ticket for each one against the
/// same shipment. Nothing failed; the mail simply went out with no ancestry.
/// </summary>
public static class MailThreadHeaders
{
    /// <summary>
    /// How many ids References may carry. RFC 5322 §3.6.4 lets a client drop
    /// from the middle of a long chain; receivers thread on the root and the
    /// recent end, so those are what is kept.
    /// </summary>
    public const int MaxReferences = 20;

    public readonly record struct Result(string? InReplyTo, IReadOnlyList<string> References)
    {
        /// <summary>False means the reply will arrive as a new conversation.</summary>
        public bool CanThread => InReplyTo is { Length: > 0 };
    }

    /// <param name="ancestry">
    /// Every stored Message-ID in the conversation up to and including the
    /// parent, OLDEST FIRST. Nulls, blanks and duplicates are tolerated: the
    /// column is nullable and mail from before threading existed has none.
    /// </param>
    /// <param name="parentMessageId">
    /// The Message-ID of the message being answered. When it is missing — the
    /// parent predates ingestion storing the header — the newest id in the
    /// ancestry stands in, because a slightly wrong parent still threads and
    /// no parent at all does not.
    /// </param>
    public static Result Build(IEnumerable<string?>? ancestry, string? parentMessageId)
    {
        var ids = new List<string>();
        foreach (var raw in ancestry ?? [])
        {
            var id = Clean(raw);
            if (id.Length > 0 && !ids.Contains(id, StringComparer.Ordinal)) ids.Add(id);
        }

        var parent = Clean(parentMessageId);
        if (parent.Length == 0) parent = ids.Count > 0 ? ids[^1] : "";
        if (parent.Length == 0) return new Result(null, []);

        // The parent is appended last whatever its position was, so a receiver
        // reading the final entry reads the message actually being answered.
        ids.RemoveAll(id => string.Equals(id, parent, StringComparison.Ordinal));

        if (ids.Count > MaxReferences - 1)
        {
            // Keep the root — it is what groups the whole conversation — and
            // the most recent ids before the parent. Drop the middle.
            var keep = new List<string> { ids[0] };
            keep.AddRange(ids.Skip(ids.Count - (MaxReferences - 2)));
            ids = keep;
        }

        ids.Add(parent);
        return new Result(parent, ids);
    }

    /// <summary>
    /// Stored ids are bare (MimeKit's MessageId strips the brackets) but mail
    /// that arrived by other routes has been seen carrying them, and MimeKit
    /// adds its own on the way out — so a bracketed id would go out doubled.
    /// </summary>
    private static string Clean(string? s) =>
        s is null ? "" : s.Trim().Trim('<', '>').Trim();
}
