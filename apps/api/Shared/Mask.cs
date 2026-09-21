namespace TatvaOS.Api.Shared;

/// <summary>
/// "Enough for the owner to recognise, not enough for anyone else to reuse."
///
/// One implementation, because these strings go into three places that must
/// agree — audit rows, the mail that says "a recovery email was added", and
/// the people list's "invitation sent to r•••@gmail.com". Until 16 Sept 2026
/// this lived as two private methods inside AuthEndpoints; the invitation work
/// needed it from the admin endpoints as well, and a second copy is how the
/// audit log and the screen end up masking differently.
/// </summary>
public static class Mask
{
    /// <summary>r•••@gmail.com</summary>
    public static string Email(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return "";
        var at = email.IndexOf('@');
        return at <= 0 ? "•••" : email[0] + "•••" + email[at..];
    }

    /// <summary>+91•••••3210</summary>
    public static string Phone(string? phone)
    {
        if (string.IsNullOrWhiteSpace(phone)) return "";
        return phone.Length <= 4 ? "•••" : phone[..3] + "•••••" + phone[^4..];
    }

    /// <summary>
    /// For a LOG LINE: "…3210". Only the last four digits, whatever went in.
    ///
    /// Not <see cref="Phone"/>: that keeps the first three characters, which is
    /// right for "+91" on a screen the owner reads and wrong for the sender's
    /// own form of a number, "919876543210", where the first three are "919" -
    /// the country code and the FIRST DIGIT of the number. A log is read by us,
    /// not by the owner; four digits find an event and identify nobody.
    /// </summary>
    public static string PhoneForLog(string? phone)
    {
        var digits = new string((phone ?? "").Where(char.IsDigit).ToArray());
        return digits.Length < 4 ? "…" : "…" + digits[^4..];
    }

    /// <summary>
    /// Take a phone number OUT of text we did not write - a provider's error body,
    /// an exception message. Both providers echo the recipient back
    /// ("to":"919876543210", "Invalid mobile 9876543210"), and that text is
    /// logged and handed back to the caller as the reason a send failed.
    ///
    /// Removes the number in every spelling it can arrive in: all its digits,
    /// and its last ten (the national form) wherever they stand alone or behind
    /// a country code. Deliberately blunt: it replaces the digits, it does not
    /// try to understand the sentence around them.
    /// </summary>
    public static string ScrubPhone(string? text, string? phone)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        var digits = new string((phone ?? "").Where(char.IsDigit).ToArray());
        if (digits.Length < 7) return text;      // nothing long enough to be worth finding
        var masked = PhoneForLog(digits);
        var result = text.Replace(digits, masked, StringComparison.Ordinal);
        if (digits.Length > 10)
            result = result.Replace(digits[^10..], masked, StringComparison.Ordinal);
        return result;
    }
}
