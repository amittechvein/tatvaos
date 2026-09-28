namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// One message, however many copies of it this mailbox holds.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS. A client of ShippingXpress, 28 September 2026: "dual
///  msgs ja rahe he" — two mails are going out. One was. He had answered his
///  own message, the reply was addressed to himself with three colleagues on
///  Cc, and so this mailbox held it twice: the copy filed in Sent when he
///  pressed Send, and the copy the mail server then delivered to his Inbox.
///  The conversation listed both, same sender, same minute, one marked Inbox.
///  From the outside that is indistinguishable from the message having been
///  sent twice, and he reasonably reported it as that.
///
///  Gmail stores one message and labels it twice. Here they are two rows, so
///  the conversation has to fold them when it is drawn.
///
///  THE KEY IS THE Message-ID HEADER AND NOTHING ELSE. Not sender plus time
///  plus subject: two genuine messages can share all three ("ok", "ok"), and
///  folding those would HIDE mail, which is worse than showing one twice.
///  A row with no Message-ID therefore never folds into anything — seed and
///  demo messages carry none, and "empty equals empty" would have collapsed
///  every one of them into a single row.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailThreadCopies
{
    /// <summary>The row the conversation draws, and every row it stands for (itself included).</summary>
    public sealed record Folded<T>(T Shown, IReadOnlyList<T> Copies);

    /// <summary>
    /// Message-Id values arrive bare or wrapped in angle brackets depending on
    /// who stored them; compared bare so one form cannot miss the other. Case
    /// is kept: the left half of a Message-ID is case-sensitive.
    /// </summary>
    private static string? Key(string? messageId)
    {
        if (string.IsNullOrWhiteSpace(messageId)) return null;
        var bare = messageId.Trim().Trim('<', '>').Trim();
        return bare.Length == 0 ? null : bare;
    }

    /// <summary>
    /// Folds copies of the same message into one entry, keeping the order the
    /// rows came in: an entry sits where its FIRST copy sat.
    /// </summary>
    /// <param name="isSentCopy">
    /// True for the copy filed in Sent. When a message has one, that is the
    /// copy shown: the strip labels each row with its folder so it can say
    /// which side of the exchange a message is on, and a message you sent
    /// should say Sent, not Inbox.
    /// </param>
    public static List<Folded<T>> Fold<T>(
        IEnumerable<T> rows, Func<T, string?> messageId, Func<T, bool> isSentCopy)
    {
        var order = new List<List<T>>();
        var byKey = new Dictionary<string, List<T>>(StringComparer.Ordinal);

        foreach (var row in rows)
        {
            var key = Key(messageId(row));
            if (key is not null && byKey.TryGetValue(key, out var known))
            {
                known.Add(row);
                continue;
            }

            var copies = new List<T> { row };
            order.Add(copies);
            if (key is not null) byKey[key] = copies;
        }

        return order
            .Select(copies =>
            {
                var sent = copies.FindIndex(c => isSentCopy(c));
                return new Folded<T>(copies[sent >= 0 ? sent : 0], copies);
            })
            .ToList();
    }
}
