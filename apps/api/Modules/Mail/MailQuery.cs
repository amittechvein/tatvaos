using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Turns what somebody typed in the search box into a query.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Supported, and deliberately no more:
///
///    from:priya            sender address or display name, substring
///    to:priya@school.in    a recipient - see the note below, this one is EXACT
///    subject:"q3 report"   subject, substring; quotes hold a phrase together
///    has:attachment        carries at least one attachment
///    is:unread is:read     read state
///    is:flagged            flagged
///    after:2026-08-01      received on or after that day (UTC)
///    before:2026-08-13     received strictly before that day (UTC)
///
///  Everything else in the box is free text and keeps the old behaviour:
///  the full-text vector, plus ILIKE over subject, sender and preview so a
///  partial word still finds something the tsquery would miss.
///
///  AN UNKNOWN OPERATOR IS TREATED AS FREE TEXT, not dropped. Somebody
///  searching for "ratio:2" means it literally, and silently discarding half
///  their query while returning confident-looking results is the worst thing
///  a search box can do.
///
///  WHY to: IS EXACT WHEN from: IS NOT. Recipients live in a text[] column.
///  Substring matching inside an array needs an unnest subquery, and whether
///  a given EF/Npgsql pair translates that is something you find out at
///  runtime - on this platform, in production, because there is nowhere else
///  to find it out. Array containment translates to = ANY and has for years.
///  So to: matches a whole address, which is the common case, and a partial
///  recipient is still findable as free text because to_addrs is indexed into
///  the search vector at weight B. A narrower feature that works beats a
///  broader one that might 500.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailQuery
{
    public sealed record Parsed(
        string Text,
        List<string> From,
        List<string> To,
        List<string> Subject,
        bool? HasAttachment,
        bool? IsRead,
        bool? IsFlagged,
        DateTimeOffset? After,
        DateTimeOffset? Before);

    /// <summary>
    /// % and _ are LIKE wildcards; a person typing them means the characters.
    /// </summary>
    private static string Like(string value) =>
        "%" + value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    /// <summary>
    /// Splits on whitespace, but keeps "quoted phrases" whole - including
    /// after an operator, so subject:"q3 report" is one condition rather than
    /// a subject filter plus a stray word.
    /// </summary>
    private static List<string> Tokenise(string q)
    {
        var tokens = new List<string>();
        var current = new System.Text.StringBuilder();
        var inQuotes = false;

        foreach (var ch in q)
        {
            if (ch == '"') { inQuotes = !inQuotes; continue; }
            if (!inQuotes && char.IsWhiteSpace(ch))
            {
                if (current.Length > 0) { tokens.Add(current.ToString()); current.Clear(); }
                continue;
            }
            current.Append(ch);
        }
        if (current.Length > 0) tokens.Add(current.ToString());

        return tokens;
    }

    public static Parsed Parse(string? q)
    {
        var from = new List<string>();
        var to = new List<string>();
        var subject = new List<string>();
        bool? hasAttachment = null, isRead = null, isFlagged = null;
        DateTimeOffset? after = null, before = null;
        var text = new List<string>();

        foreach (var token in Tokenise(q ?? ""))
        {
            var colon = token.IndexOf(':');
            // No colon, or nothing after it: plain text. "12:30" keeps its
            // colon and stays text, because "12" is not an operator.
            if (colon <= 0 || colon == token.Length - 1) { text.Add(token); continue; }

            var key = token[..colon].ToLowerInvariant();
            var value = token[(colon + 1)..];

            switch (key)
            {
                case "from": from.Add(value); break;
                case "to": to.Add(value.ToLowerInvariant()); break;
                case "subject": subject.Add(value); break;

                case "has" when value.Equals("attachment", StringComparison.OrdinalIgnoreCase):
                    hasAttachment = true; break;

                case "is" when value.Equals("unread", StringComparison.OrdinalIgnoreCase):
                    isRead = false; break;
                case "is" when value.Equals("read", StringComparison.OrdinalIgnoreCase):
                    isRead = true; break;
                case "is" when value.Equals("flagged", StringComparison.OrdinalIgnoreCase):
                    isFlagged = true; break;

                case "after" when TryDay(value, out var a): after = a; break;
                case "before" when TryDay(value, out var b): before = b; break;

                // A recognised operator with an unusable value ("is:banana",
                // "after:soon"), and anything unrecognised, is kept as text
                // rather than thrown away. See the class note.
                default: text.Add(token); break;
            }
        }

        return new Parsed(
            string.Join(' ', text).Trim(),
            from, to, subject, hasAttachment, isRead, isFlagged, after, before);
    }

    /// <summary>Midnight UTC on the given day. Date only - times are noise here.</summary>
    private static bool TryDay(string value, out DateTimeOffset day)
    {
        day = default;
        if (!DateOnly.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var d))
            return false;
        day = new DateTimeOffset(d.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero);
        return true;
    }

    /// <summary>
    /// Narrows a message query by everything the box asked for. The caller has
    /// already scoped it to a mailbox - this only ever adds conditions.
    /// </summary>
    public static IQueryable<Message> Apply(IQueryable<Message> query, string? q)
    {
        var p = Parse(q);

        foreach (var value in p.From)
        {
            var pattern = Like(value);
            query = query.Where(m =>
                EF.Functions.ILike(m.FromAddr ?? "", pattern, "\\")
                || EF.Functions.ILike(m.FromName ?? "", pattern, "\\"));
        }

        foreach (var value in p.To)
        {
            var address = value;
            query = query.Where(m =>
                (m.ToAddrs != null && m.ToAddrs.Contains(address))
                || (m.CcAddrs != null && m.CcAddrs.Contains(address)));
        }

        foreach (var value in p.Subject)
        {
            var pattern = Like(value);
            query = query.Where(m => EF.Functions.ILike(m.Subject ?? "", pattern, "\\"));
        }

        if (p.HasAttachment is true) query = query.Where(m => m.HasAttachments);
        if (p.IsRead is bool read) query = query.Where(m => m.IsRead == read);
        if (p.IsFlagged is true) query = query.Where(m => m.IsFlagged);
        if (p.After is DateTimeOffset a) query = query.Where(m => m.ReceivedAt >= a);
        if (p.Before is DateTimeOffset b) query = query.Where(m => m.ReceivedAt < b);

        // Free text last, and only when there is some. "from:priya" on its own
        // is a complete question; matching it against an empty string as well
        // would answer a different one.
        if (p.Text.Length > 0)
        {
            var term = p.Text;
            var pattern = Like(term);
            query = query.Where(m =>
                (m.SearchVector != null
                 && m.SearchVector.Matches(EF.Functions.WebSearchToTsQuery("simple", term)))
                || EF.Functions.ILike(m.Subject ?? "", pattern, "\\")
                || EF.Functions.ILike(m.FromAddr ?? "", pattern, "\\")
                || EF.Functions.ILike(m.FromName ?? "", pattern, "\\")
                || EF.Functions.ILike(m.Snippet ?? "", pattern, "\\"));
        }

        return query;
    }
}
