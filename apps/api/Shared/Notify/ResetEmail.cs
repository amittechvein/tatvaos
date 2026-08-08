using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The branded HTML email that carries a password-reset link.
///
/// Same construction rules as <see cref="WelcomeEmail"/> — nested tables,
/// inline styles, absolute image URLs — because email clients render a decade
/// behind browsers and this has to look right in Gmail, Outlook and Apple Mail
/// with remote images blocked. See that file's header for the full reasoning.
///
/// The security-sensitive lines are deliberate: the link expires in an hour,
/// the mail names how long, and it tells a recipient who did NOT ask for this
/// that they can safely ignore it — the reset cannot proceed without the link,
/// so an unrequested one is harmless.
/// </summary>
public static class ResetEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject() => "Reset your TatvaOS password";

    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="resetUrl">The full one-time reset link, token included.</param>
    /// <param name="minutes">How long the link stays valid, for the copy.</param>
    public static string Html(string displayName, string baseUrl, string resetUrl, int minutes)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var url = WebUtility.HtmlEncode(resetUrl);
        var b = baseUrl.TrimEnd('/');
        var window = minutes >= 60 && minutes % 60 == 0
            ? $"{minutes / 60} hour{(minutes / 60 == 1 ? "" : "s")}"
            : $"{minutes} minutes";

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>Reset your TatvaOS password</title>
</head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr>
      <td align=""center"" style=""padding:32px 16px;"">
        <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
               style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">

          <!-- Header band -->
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

          <!-- Hero -->
          <tr>
            <td style=""padding:36px 32px 8px;"">
              <h1 style=""margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:800;color:{Ink};"">
                Reset your password
              </h1>
              <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
                Hi {name}, we received a request to reset the password on your TatvaOS
                account. Choose a new one using the button below.
              </p>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align=""center"" style=""padding:28px 32px 8px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{url}"" style=""display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Set a new password
                  </a>
                </td>
              </tr></table>
              <p style=""margin:14px 0 0;font-size:12px;color:{Muted};"">
                This link expires in {window} and can be used once.
              </p>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style=""padding:12px 32px 8px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:14px 18px;"">
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">If the button does not work</div>
                    <div style=""font-size:13px;color:#4d5875;margin-top:4px;word-break:break-all;"">
                      <a href=""{url}"" style=""color:{GreenDark};text-decoration:none;"">{url}</a>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style=""padding:24px 32px 28px;border-top:1px solid {Border};"">
              <p style=""margin:0;font-size:12px;line-height:1.6;color:{Muted};"">
                Sent by <strong style=""color:#4d5875;"">no_reply@tatvaos.com</strong>. This is an automated
                message — please do not reply. <strong style=""color:#4d5875;"">If you did not request this</strong>,
                you can safely ignore this email; your password will not change until the link above is used.
              </p>
            </td>
          </tr>
        </table>

        <p style=""margin:16px 0 0;font-size:11px;color:{Muted};font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
          © TatvaOS by Techvein
        </p>
      </td>
    </tr>
  </table>
</body>
</html>";
    }
}
