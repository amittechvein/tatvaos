using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The branded HTML welcome email a new person receives in their fresh
/// TatvaOS inbox the moment their account is created.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY TABLE-BASED, INLINE-STYLED HTML.
///
///  Email clients are a decade behind browsers: Outlook renders with Word,
///  Gmail strips &lt;style&gt; blocks and most modern CSS. The only layout that
///  survives everywhere is nested tables with inline styles and explicit
///  widths — which is why this looks nothing like the React console but
///  renders identically in Gmail, Outlook, and Apple Mail.
///
///  Images are absolute https URLs to the web app's /brand assets (the same
///  logos the sidebar uses). Every client blocks remote images by default, so
///  the design has to read even with images off — hence the coloured header
///  band and text, not a logo-only masthead.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class WelcomeEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject(string orgName) =>
        $"Welcome to TatvaOS — your {orgName} account is ready";

    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="mailAddress">The person's new mailbox address.</param>
    public static string Html(
        string displayName, string orgName, string baseUrl, string mailAddress)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var org = WebUtility.HtmlEncode(orgName);
        var addr = WebUtility.HtmlEncode(mailAddress);
        var b = baseUrl.TrimEnd('/');
        var signIn = $"{b}/login";
        var mailUrl = "https://mail.tatvaos.com";

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>Welcome to TatvaOS</title>
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
                Welcome, {name}.
              </h1>
              <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
                Your account for <strong style=""color:{Ink};"">{org}</strong> is ready. TatvaOS is where your
                organisation runs — one sign-in reaches every product you have been given.
              </p>
            </td>
          </tr>

          <!-- Your address -->
          <tr>
            <td style=""padding:20px 32px 8px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:14px 18px;"">
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">Your address</div>
                    <div style=""font-size:16px;font-weight:700;color:{Ink};margin-top:2px;"">{addr}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Products -->
          <tr>
            <td style=""padding:20px 32px 4px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"">
                <tr>
                  <td width=""50%"" style=""padding:6px 8px 6px 0;vertical-align:top;"">
                    <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""border:1px solid {Border};border-radius:10px;"">
                      <tr><td style=""padding:16px;"">
                        <img src=""{b}/brand/core-logo.png"" width=""28"" height=""28"" alt=""Core"" style=""display:block;border:0;border-radius:6px;"">
                        <div style=""font-size:15px;font-weight:700;color:{Ink};margin-top:10px;"">TatvaOS Core</div>
                        <div style=""font-size:13px;line-height:1.5;color:{Muted};margin-top:2px;"">People, domains and storage for your organisation.</div>
                      </td></tr>
                    </table>
                  </td>
                  <td width=""50%"" style=""padding:6px 0 6px 8px;vertical-align:top;"">
                    <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""border:1px solid {Border};border-radius:10px;"">
                      <tr><td style=""padding:16px;"">
                        <img src=""{b}/brand/mail-logo.png"" width=""28"" height=""28"" alt=""Mail"" style=""display:block;border:0;border-radius:6px;"">
                        <div style=""font-size:15px;font-weight:700;color:{Ink};margin-top:10px;"">TatvaOS Mail</div>
                        <div style=""font-size:13px;line-height:1.5;color:{Muted};margin-top:2px;"">Your new inbox at <a href=""{mailUrl}"" style=""color:{GreenDark};text-decoration:none;"">mail.tatvaos.com</a>.</div>
                      </td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align=""center"" style=""padding:24px 32px 8px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{signIn}"" style=""display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Sign in to get started
                  </a>
                </td>
              </tr></table>
              <p style=""margin:14px 0 0;font-size:12px;color:{Muted};"">
                Your administrator has your temporary password — you will be asked to set your own on first sign-in.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style=""padding:24px 32px 28px;border-top:1px solid {Border};"">
              <p style=""margin:0;font-size:12px;line-height:1.6;color:{Muted};"">
                Sent by <strong style=""color:#4d5875;"">no_reply@tatvaos.com</strong> for {org}. This is an automated
                message — please do not reply. If you were not expecting this, you can ignore it.
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
