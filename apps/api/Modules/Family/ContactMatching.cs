using System.Text;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// Turning what someone typed into what we compare.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS IS THE DUPLICATE-PREVENTION RULE, AND IT IS THE WHOLE OF IT.
///
///  Auto-save runs on every delivered message. Without normalisation, a
///  sender who writes from a.smith@gmail.com on Monday and asmith+work@
///  gmail.com on Tuesday becomes two contacts, and by the end of a quarter
///  the address book is unusable.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Deliberately conservative. Only the folding rules that are TRUE for the
/// provider are applied:
///
///   gmail.com / googlemail.com   dots are ignored, +tag is ignored,
///                                googlemail is an alias of gmail
///   everything else              case folded, +tag stripped
///
/// Dots are NOT stripped for other providers. Plenty of mail systems treat
/// first.last@ and firstlast@ as different people, and merging two real
/// contacts is worse than keeping two rows for one.
/// </summary>
public static class ContactMatching
{
    /// <summary>
    /// The comparison key for an address. Never displayed — the address as
    /// typed is what the UI shows.
    /// </summary>
    public static string NormaliseEmail(string email)
    {
        var trimmed = (email ?? string.Empty).Trim().ToLowerInvariant();

        var at = trimmed.LastIndexOf('@');
        if (at <= 0 || at == trimmed.Length - 1) return trimmed;  // not an address; compare as-is

        var local = trimmed[..at];
        var domain = trimmed[(at + 1)..];

        // +tag is a routing hint to the recipient's own server, never part of
        // the identity of the person sending.
        var plus = local.IndexOf('+');
        if (plus >= 0) local = local[..plus];

        if (domain is "gmail.com" or "googlemail.com")
        {
            local = local.Replace(".", string.Empty);
            domain = "gmail.com";
        }

        return local.Length == 0 ? trimmed : $"{local}@{domain}";
    }

    /// <summary>
    /// Digits only, so "+91 98765 43210", "098765 43210" and "9876543210"
    /// compare equal. A leading + is dropped with everything else: country
    /// codes are inconsistently entered and matching on the tail is what
    /// people actually mean.
    /// </summary>
    public static string NormalisePhone(string phone)
    {
        var sb = new StringBuilder((phone ?? string.Empty).Length);
        foreach (var c in phone ?? string.Empty)
            if (char.IsDigit(c)) sb.Append(c);
        return sb.ToString();
    }

    /// <summary>
    /// Is this address a machine that cannot be replied to?
    ///
    /// ─────────────────────────────────────────────────────────────────────
    ///  THIS IS WHAT KEEPS AUTO-SAVE WORTH HAVING.
    ///
    ///  Auto-save is on by default. Without this, every newsletter, receipt,
    ///  delivery notification and password reset becomes a contact. Within a
    ///  month a real address book is mostly robots, and the way people react
    ///  to that is to turn auto-save off — which costs the feature entirely.
    ///  Filtering is cheaper than losing the feature.
    /// ─────────────────────────────────────────────────────────────────────
    ///
    /// DELIBERATELY CONSERVATIVE, for the same reason NormaliseEmail only
    /// folds dots for Gmail: a false positive silently loses a real person and
    /// nobody ever finds out, while a false negative leaves one robot in the
    /// list that someone deletes in two seconds.
    ///
    /// So support@, info@, sales@, accounts@, hello@ and billing@ are NOT
    /// filtered. They look impersonal and they are real correspondents —
    /// filing a supplier's accounts desk is what an address book is for. Only
    /// addresses that by convention cannot receive a reply are excluded.
    ///
    /// What this cannot see: List-Unsubscribe, Auto-Submitted and
    /// Precedence: bulk, which are the authoritative signals. They live in
    /// headers, and auto-save runs after commit with only the mail.messages
    /// row, which does not carry them. An is_bulk column set at ingest — where
    /// MimeKit has already parsed the headers — is the proper fix.
    /// </summary>
    public static bool IsNoReply(string email)
    {
        var normalised = NormaliseEmail(email);
        var at = normalised.LastIndexOf('@');
        if (at <= 0) return false;

        var local = normalised[..at];

        // mailer-daemon and postmaster are RFC-mandated; the rest are the
        // near-universal spellings of "this mailbox is not read".
        string[] exact = [
            "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply",
            "do_not_reply", "nepasrepondre",
            "mailer-daemon", "mailerdaemon", "postmaster", "daemon",
            "bounce", "bounces", "returns",
            "notification", "notifications", "notify",
            "automated", "automailer", "autoresponder", "auto-confirm",
        ];
        if (exact.Contains(local)) return true;

        // VERP and per-message bounce addresses: bounce-1234-user=example.com@,
        // notifications-abc123@. Prefix rather than substring — "announcebounce@"
        // is not a bounce address, and a substring match would swallow real names.
        string[] prefixes = [
            "noreply", "no-reply", "donotreply", "do-not-reply",
            "bounce", "bounces", "mailer-daemon", "notifications-", "notification-",
        ];
        foreach (var pre in prefixes)
            if (local.StartsWith(pre, StringComparison.Ordinal) &&
                local.Length > pre.Length &&
                (local[pre.Length] is '-' or '+' or '_' or '.' or (>= '0' and <= '9')))
                return true;

        // Some senders put the intent after a plus, which NormaliseEmail has
        // already stripped — so check the raw address too.
        var raw = (email ?? string.Empty).ToLowerInvariant();
        return raw.Contains("+bounce") || raw.Contains("+noreply");
    }

    /// <summary>
    /// A readable name for an address that arrived with none.
    ///
    /// "accounts.payable@supplier.com" becomes "Accounts Payable", which is
    /// what a person would have typed. Falls back to the address itself when
    /// the local part carries no structure worth showing.
    /// </summary>
    public static string DisplayNameFromEmail(string? headerName, string email)
    {
        // A From header's display name is always better than anything derived.
        if (!string.IsNullOrWhiteSpace(headerName)) return headerName.Trim();

        var at = email.IndexOf('@');
        if (at <= 0) return email;

        var local = email[..at];
        var words = local.Split(['.', '_', '-'], StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return email;

        var sb = new StringBuilder();
        foreach (var w in words)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(char.ToUpperInvariant(w[0]));
            if (w.Length > 1) sb.Append(w[1..]);
        }
        return sb.ToString();
    }
}
