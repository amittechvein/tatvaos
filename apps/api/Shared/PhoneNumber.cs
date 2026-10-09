using System.Text.RegularExpressions;

namespace TatvaOS.Api.Shared;

/// <summary>
/// Phone normalisation and masking, in ONE place.
///
/// These six lines used to live inside SignupEndpoints, and the OTP login was
/// about to grow a second copy. Two normalisers is how "+91 98765 43210" signs
/// up under one spelling and then cannot sign in under the other — the number
/// is the join key between the two flows, so they must agree to the character.
/// </summary>
public static class PhoneNumber
{
    /// <summary>Strips spaces, dashes and brackets; null if the remainder is
    /// not a plausible international number.</summary>
    public static string? Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var p = Regex.Replace(raw, @"[\s\-()]", "");
        return Regex.IsMatch(p, @"^\+?[0-9]{8,15}$") ? p : null;
    }

    /// <summary>
    /// The ONE spelling a number is stored and compared in: "+" and digits,
    /// with a country code. A bare 10-digit Indian mobile (6-9...), "0" + 10
    /// digits, or "91" + 10 digits all become +91XXXXXXXXXX; a number that
    /// already carries its "+" is kept (after Normalise). Null if it is none
    /// of those. The same rule as core.phone_canonical() in
    /// 20261009-z-phone-canonical.sql, which brings stored rows to it.
    ///
    /// Issue #327 (27 Sept 2026, fixed 9 Oct): sign-in matched the number AS
    /// TYPED against the number AS STORED, so "+919876543210" on the row and
    /// "98765 43210" at the door never met - admins store numbers however
    /// they type them. The join key of every phone flow has to agree to the
    /// character, on BOTH sides.
    /// </summary>
    public static string? Canonical(string? raw)
    {
        var n = Normalise(raw);
        if (n is null) return null;
        if (n.StartsWith('+')) return n.Length >= 9 ? n : null;
        if (n.Length == 10 && n[0] is >= '6' and <= '9') return "+91" + n;
        if (n.Length == 11 && n[0] == '0' && n[1] is >= '6' and <= '9') return "+91" + n[1..];
        if (n.Length == 12 && n.StartsWith("91") && n[2] is >= '6' and <= '9') return "+" + n;
        return null;
    }

    /// <summary>
    /// What every write and every lookup uses: Canonical where the number is
    /// one, otherwise the plain Normalise result (an 8-digit landline, a bare
    /// non-Indian number) exactly as before - so nothing that was accepted is
    /// now refused, and such a number still matches itself. Both sides of a
    /// comparison go through this; that is the whole fix.
    /// </summary>
    public static string? Stored(string? raw) => Canonical(raw) ?? Normalise(raw);

    /// <summary>Everything but the last four digits. Enough to recognise your
    /// own number, useless for guessing anyone else's.</summary>
    public static string? Mask(string? phone) =>
        string.IsNullOrEmpty(phone) || phone.Length < 4
            ? phone
            : new string('•', phone.Length - 4) + phone[^4..];
}
