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

    /// <summary>Everything but the last four digits. Enough to recognise your
    /// own number, useless for guessing anyone else's.</summary>
    public static string? Mask(string? phone) =>
        string.IsNullOrEmpty(phone) || phone.Length < 4
            ? phone
            : new string('•', phone.Length - 4) + phone[^4..];
}
