using System.Text.RegularExpressions;

namespace TatvaOS.Api.Shared;

/// <summary>
/// Does this look like an email address at all — in one place, beside
/// PhoneNumber, for the same reason that file gives.
///
/// This is a SHAPE check, not a deliverability check. It exists to catch a
/// spreadsheet cell containing a name, a phone number, or "n/a" before that
/// becomes somebody's recovery address. Whether the mailbox accepts mail is
/// answered by sending to it, which is what the verification step does.
///
/// MailSendApiEndpoints has a near-identical private copy. It is the Mail
/// lane's file, so it is left alone rather than edited from here; converging
/// the two is a one-line change whenever that lane next touches it.
/// </summary>
public static class EmailAddress
{
    public static bool LooksValid(string? raw) =>
        !string.IsNullOrWhiteSpace(raw)
        && raw.Trim().Length <= 254
        && Regex.IsMatch(raw.Trim(), @"^[^\s@]+@[^\s@]+\.[^\s@]+$", RegexOptions.IgnoreCase);
}
