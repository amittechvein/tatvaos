using System.Linq;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// What a message must expose to be sorted in a folder list. The Message entity
/// implements it; so does the plain row tests/mail-sort drives this rule with —
/// which is the point: the rule is written once, against this, and the test
/// compiles THIS file rather than a copy (tests/connect-order says why).
/// </summary>
public interface IMailSortable
{
    Guid Id { get; }
    DateTimeOffset ReceivedAt { get; }
    bool IsRead { get; }
    bool IsFlagged { get; }
    string? FromName { get; }
    string? FromAddr { get; }
    long SizeBytes { get; }
}

/// <summary>
/// The order of GET /api/mail/folders/{id}/messages?sort=…
///
/// Amit on his own phone, 19 Sept 2026: "sorting option on mail". The list had
/// exactly one order, newest first, on the web and on the phone.
///
/// WHY THIS IS ON THE SERVER AND NOT IN THE APP. The list is paged: the phone
/// holds thirty rows of a folder that may hold thirty thousand. Sorting those
/// thirty on the phone would show "oldest first" as the oldest of the NEWEST
/// thirty — a screen that looks exactly right and is wrong, with nothing to
/// notice unless you know what the first email you ever received was. The
/// order has to be decided where the whole folder is.
///
/// EVERY ORDER ENDS THE SAME WAY: newest first, then Id. Paging is skip/take,
/// so rows that tie on the sort key must come back in the same order on every
/// request or "Load more" repeats some and never shows others. A thousand
/// unread messages tie on IsRead; two from one delivery tie on ReceivedAt; Id
/// never ties.
///
/// 'newest' is NOT applied here. The endpoint keeps its original
/// OrderByDescending for the default, untouched, so that the day this file
/// turns out to hold an expression Npgsql cannot translate, what breaks is the
/// new feature and not everybody's inbox. The console test proves the ORDER; it
/// cannot prove the SQL. A real request against Postgres does that.
/// </summary>
public static class MailListSort
{
    public const string Newest = "newest";
    public const string Oldest = "oldest";
    public const string Unread = "unread";
    public const string Starred = "starred";
    public const string Sender = "sender";
    public const string Largest = "largest";

    public static readonly IReadOnlyList<string> All = [Newest, Oldest, Unread, Starred, Sender, Largest];

    /// <summary>
    /// Null, empty or whitespace is the default. Anything else must be one of
    /// <see cref="All"/>, exactly, in lower case — a client that sends
    /// "Oldest" has a bug worth a 400 today rather than a silently newest-first
    /// list under a header that says otherwise.
    /// </summary>
    public static bool TryParse(string? raw, out string key)
    {
        if (string.IsNullOrWhiteSpace(raw)) { key = Newest; return true; }
        key = raw;
        return All.Contains(raw, StringComparer.Ordinal);
    }

    /// <summary>For every key except <see cref="Newest"/>, which the endpoint orders itself.</summary>
    public static IOrderedQueryable<T> Apply<T>(IQueryable<T> q, string key) where T : class, IMailSortable =>
        key switch
        {
            Oldest => q.OrderBy(m => m.ReceivedAt).ThenBy(m => m.Id),

            // false sorts before true: unread (IsRead = false) first.
            Unread => q.OrderBy(m => m.IsRead)
                       .ThenByDescending(m => m.ReceivedAt).ThenBy(m => m.Id),

            Starred => q.OrderByDescending(m => m.IsFlagged)
                        .ThenByDescending(m => m.ReceivedAt).ThenBy(m => m.Id),

            // By what the list SHOWS as the sender: the name, or the address
            // when there is no name. Lower-cased so "amit" and "Amit" are
            // neighbours; ToLower() translates to lower(), where a
            // StringComparer would not translate at all.
            // An EMPTY name counts as no name, as it does on screen: "" would
            // otherwise sort every nameless sender to the top, under nothing.
            Sender => q.OrderBy(m => ((m.FromName == null || m.FromName == "" ? m.FromAddr : m.FromName) ?? "").ToLower())
                       .ThenByDescending(m => m.ReceivedAt).ThenBy(m => m.Id),

            Largest => q.OrderByDescending(m => m.SizeBytes)
                        .ThenByDescending(m => m.ReceivedAt).ThenBy(m => m.Id),

            _ => throw new ArgumentOutOfRangeException(nameof(key), key,
                     "MailListSort.Apply is for the non-default orders; TryParse first."),
        };
}
