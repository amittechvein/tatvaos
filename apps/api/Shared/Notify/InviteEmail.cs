using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The invitation a new person receives at their RECOVERY address: their
/// organisation, their new TatvaOS address, and one button that lets them set
/// their own password. Decision 0005.
///
/// It goes to the recovery address and not to the new mailbox, because the
/// new mailbox is exactly the thing they cannot open yet. For invited people
/// it REPLACES the welcome email — there is no temporary password for a
/// welcome to allude to.
///
/// NO PASSWORD, EVER, in this message. The whole point of the design is that
/// nothing an admin or a mail server can read is a working credential. The
/// link is single-use and dies after the window named below, and a recipient
/// who was not expecting it can ignore it: nothing about the account can be
/// used until someone opens the link and chooses a password.
///
/// Same construction rules as <see cref="WelcomeEmail"/> — nested tables,
/// inline styles, absolute image URLs. See that file's header for why.
/// </summary>
public static class InviteEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject(string orgName) =>
        $"Set your password for {orgName} on TatvaOS";

    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="address">The person's new sign-in address.</param>
    /// <param name="inviteUrl">The one-time link, token in the fragment.</param>
    /// <param name="hours">How long the link stays valid, for the copy.</param>
    public static string Html(
        string displayName, string orgName, string baseUrl, string address, string inviteUrl, int hours)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var org = WebUtility.HtmlEncode(orgName);
        var addr = WebUtility.HtmlEncode(address);
        var url = WebUtility.HtmlEncode(inviteUrl);
        var b = baseUrl.TrimEnd('/');
        var window = hours % 24 == 0 && hours >= 24
            ? $"{hours / 24} day{(hours / 24 == 1 ? "" : "s")}"
            : $"{hours} hours";

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>Set your password for {org}</title>
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
                <strong style=""color:{Ink};"">{org}</strong> has created your TatvaOS account.
                Choose your own password to start using it — nobody else has one for you.
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
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">You will sign in as</div>
                    <div style=""font-size:16px;font-weight:700;color:{Ink};margin-top:2px;"">{addr}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align=""center"" style=""padding:28px 32px 8px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{url}"" style=""display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Set your password
                  </a>
                </td>
              </tr></table>
              <p style=""margin:14px 0 0;font-size:12px;color:{Muted};"">
                This link works once and expires in {window}. After that, ask your administrator to send a new one.
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
                Sent by <strong style=""color:#4d5875;"">no_reply@tatvaos.com</strong> for {org}, to the recovery
                address your administrator gave. This is an automated message — please do not reply.
                <strong style=""color:#4d5875;"">If you were not expecting this</strong>, you can ignore it:
                the account cannot be used until this link is opened and a password chosen.
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
