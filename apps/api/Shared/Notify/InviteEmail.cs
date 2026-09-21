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

    public static string Subject(string orgName, bool signInLink = false) =>
        signInLink
            ? $"A link to choose a new password for {orgName} on TatvaOS"
            : $"Set your password for {orgName} on TatvaOS";

    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="address">The person's new sign-in address.</param>
    /// <param name="inviteUrl">The one-time link, token in the fragment.</param>
    /// <param name="hours">How long the link stays valid, for the copy.</param>
    public static string Html(
        string displayName, string orgName, string baseUrl, string address, string inviteUrl, int hours,
        bool signInLink = false)
    {
        // The same mail, two openings. Somebody who has used this account for a
        // year must not be told "Welcome" and "has created your account": it reads
        // as phishing, and a careful person would be right to ignore it.
        // Amit, 21 Sept 2026, on the first real sign-in link in his inbox:
        // "in starting give welcome note". A welcome in BOTH, worded for who is
        // reading: a new person is welcomed to TatvaOS, somebody who already
        // uses it is welcomed back. The reason the mail came follows at once,
        // because a welcome with no reason reads as marketing, or as phishing.
        var headline = signInLink ? "Welcome back" : "Welcome to TatvaOS";
        var welcome = signInLink
            ? "Good to see you again. TatvaOS keeps your organisation's mail, meetings, calendar and files together under one sign-in."
            : "TatvaOS is your organisation's mail, meetings, calendar and files, together under one sign-in. We are glad to have you.";
        var opening = signInLink
            ? "Your administrator at <strong style=\"color:#0a0a0a;\">" + WebUtility.HtmlEncode(orgName) + "</strong> sent you this link so you can choose a new password and get back in. "
              + "Your current password keeps working until you use it. If you did not expect this, ignore it and tell your administrator."
            : "<strong style=\"color:#0a0a0a;\">" + WebUtility.HtmlEncode(orgName) + "</strong> has created your TatvaOS account. "
              + "Choose your own password to start using it — nobody else has one for you.";
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var org = WebUtility.HtmlEncode(orgName);
        var addr = WebUtility.HtmlEncode(address);
        var url = WebUtility.HtmlEncode(inviteUrl);
        var b = baseUrl.TrimEnd('/');
        var window = hours % 24 == 0 && hours >= 24
            ? $"{hours / 24} day{(hours / 24 == 1 ? "" : "s")}"
            : $"{hours} hours";

        var apps = AppTile(b, "mail", "Mail", "Your work email")
                 + AppTile(b, "connect", "Connect", "Video meetings")
                 + AppTile(b, "calendar", "Calendar", "Your schedule")
                 + AppTile(b, "space", "Space", "Files and sharing");

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
                {headline}, {name}.
              </h1>
              <p style=""margin:0 0 12px;font-size:15px;line-height:1.6;color:#4d5875;"">
                {welcome}
              </p>
              <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
                {opening}
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

          <!-- The apps. Amit, 21 Sept 2026, asked for the branding of all
               TatvaOS applications below the button: Mail, Connect, Calendar, Space.
               Logos are the ORIGINAL opaque marks under /brand, kept for email
               exactly because mail clients draw no transparency against a
               dark mode they control (see ui brand notes). Four columns in one
               table row: every client, including Outlook, renders that; a
               flex or grid layout would collapse in half of them. Names are
               TEXT, not images, so they survive images being blocked. -->
          <tr>
            <td style=""padding:28px 32px 4px;"">
              <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};text-align:center;"">One sign-in, every app</div>
            </td>
          </tr>
          <tr>
            <td style=""padding:12px 20px 8px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"">
                <tr>
                  {apps}
                </tr>
              </table>
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

    /// <summary>One app in the row below the button: its logo, its name, one line.
    /// A quarter of the row each; the logo has a fixed size so a slow or blocked
    /// image does not reflow the mail, and alt text names the app.</summary>
    private static string AppTile(string baseUrl, string slug, string name, string line) =>
        $@"<td width=""25%"" align=""center"" valign=""top"" style=""width:25%;padding:8px 4px;"">
                    <img src=""{baseUrl}/brand/{slug}-logo.png"" width=""44"" height=""44"" alt=""{name}""
                         style=""display:block;margin:0 auto;border:0;border-radius:10px;"">
                    <div style=""margin-top:8px;font-size:14px;font-weight:700;color:{Ink};"">{name}</div>
                    <div style=""margin-top:2px;font-size:12px;line-height:1.4;color:{Muted};"">{line}</div>
                  </td>";
}
