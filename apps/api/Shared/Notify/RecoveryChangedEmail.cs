using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "The way back into your account just changed."
///
/// Sent whenever a recovery email or recovery number is added, changed or
/// removed. Same construction rules as <see cref="SignInAlertEmail"/> and
/// <see cref="ResetEmail"/> — nested tables, inline styles, absolute image
/// URLs — because email clients render a decade behind browsers.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS — the account-takeover path, open 4–15 September 2026.
///
///  Until this email and the password gate beside it, anyone with a few
///  minutes at an unlocked, signed-in laptop could add THEIR OWN recovery
///  email, confirm it from their own inbox, reset the password, and own the
///  account — and the owner was never told. The CTO's review of 9 September
///  named it and asked for three things: require the current password, mail
///  the owner on every change, and write an audit row. This is the second.
///
///  It goes to the account's own address AND to the previous verified
///  recovery address, because someone at the owner's unlocked laptop can
///  usually read the owner's inbox too. The old recovery address is the one
///  place they cannot delete the warning from.
///
///  Addresses and numbers are always MASKED here. The full value is already
///  known to the owner, and an email is not the place to repeat it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class RecoveryChangedEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Body = "#4d5875";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject() => "Your TatvaOS recovery details were changed";

    /// <param name="displayName">The account owner's name.</param>
    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="what">One sentence saying what changed. Must already be masked.</param>
    /// <param name="whenUtc">When it changed; rendered in IST for the reader.</param>
    public static string Html(string displayName, string baseUrl, string what, DateTimeOffset whenUtc)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var change = WebUtility.HtmlEncode(what);
        var b = baseUrl.TrimEnd('/');
        // A fixed +05:30 rather than a time-zone lookup: India has no daylight
        // saving, and a missing tz database in a slim container must not be the
        // reason a security notice fails to render.
        var ist = whenUtc.ToOffset(TimeSpan.FromMinutes(330));
        var when = WebUtility.HtmlEncode(ist.ToString("d MMM yyyy, HH:mm", System.Globalization.CultureInfo.InvariantCulture) + " IST");
        var account = WebUtility.HtmlEncode($"{b}/account");
        var change_password = WebUtility.HtmlEncode($"{b}/change-password");

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>Your TatvaOS recovery details were changed</title>
</head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr>
      <td align=""center"" style=""padding:32px 16px;"">
        <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
               style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
          <tr>
            <td style=""background:{Green};background-image:linear-gradient(120deg,{GreenDark} 0%,{Green} 100%);padding:28px 32px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""vertical-align:middle;"">
                  <img src=""{b}/brand/core-logo.png"" width=""34"" height=""34"" alt=""""
                       style=""display:block;border:0;border-radius:8px;background:#ffffff;"">
                </td>
                <td style=""vertical-align:middle;padding-left:12px;"">
                  <span style=""font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;"">TatvaOS</span>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style=""padding:36px 32px 8px;"">
              <h1 style=""margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:800;color:{Ink};"">
                Your recovery details changed
              </h1>
              <p style=""margin:0 0 14px;font-size:15px;line-height:1.6;color:{Body};"">
                Hi {name}, {change}
              </p>
              <p style=""margin:0;font-size:14px;line-height:1.6;color:{Body};"">
                When: <strong style=""color:{Ink};"">{when}</strong>
              </p>
            </td>
          </tr>
          <tr>
            <td style=""padding:18px 32px 8px;"">
              <p style=""margin:0;font-size:15px;line-height:1.6;color:{Body};"">
                <strong style=""color:{Ink};"">If this was you,</strong> there is nothing to do.
              </p>
            </td>
          </tr>
          <tr>
            <td style=""padding:10px 32px 30px;"">
              <p style=""margin:0 0 16px;font-size:15px;line-height:1.6;color:{Body};"">
                <strong style=""color:{Ink};"">If it was not you,</strong> someone may be using your
                account. Change your password now, then check your recovery settings.
              </p>
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{change_password}""
                     style=""display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Change my password
                  </a>
                </td>
                <td style=""padding-left:12px;"">
                  <a href=""{account}"" style=""font-size:14px;color:{GreenDark};text-decoration:underline;"">
                    Review recovery settings
                  </a>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style=""padding:16px 32px 26px;border-top:1px solid {Border};"">
              <p style=""margin:0;font-size:12px;line-height:1.6;color:#8d9eb5;"">
                TatvaOS sends this whenever the ways back into your account change.
                It cannot be turned off.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>";
    }
}
