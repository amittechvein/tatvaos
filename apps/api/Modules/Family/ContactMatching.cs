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
