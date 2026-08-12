using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "We noticed a new sign-in to your account."
///
/// Same construction rules as <see cref="WelcomeEmail"/> and
/// <see cref="ResetEmail"/> — nested tables, inline styles, absolute image
/// URLs — because email clients render a decade behind browsers. See
/// WelcomeEmail's header for the full reasoning.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS EMAIL IS READ IN TWO COMPLETELY DIFFERENT MOODS.
///
///  Nearly every recipient is the person who just signed in, on their new
///  laptop, and wants to confirm "yes, that was me" in two seconds and move
///  on. A rare few are looking at a sign-in they did NOT perform, and for
///  them this is the worst email of their week.
///
///  So the design leads with the FACTS (device, when, where from) rather than
///  an alarm: the common reader recognises themselves immediately and stops.
///  The action for the rare reader is present, unmissable and specific — go
///  change your password — but it does not shout at the 99% who are fine.
///  An alert styled as an emergency for a non-emergency is how people learn
///  to delete these unread.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class SignInAlertEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject(string device) =>
        $"New sign-in to your TatvaOS account — {device}";

    /// <param name="baseUrl">The console origin, e.g. https://core.tatvaos.com.</param>
    /// <param name="device">Human-readable device, e.g. "Chrome on Windows".</param>
    /// <param name="ipAddress">The address the sign-in came from, or null.</param>
    /// <param name="whenUtc">Sign-in time in UTC; rendered in IST for the reader.</param>
    public static string Html(
        string displayName, string baseUrl, string device, string? ipAddress, DateTimeOffset whenUtc)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var dev = WebUtility.HtmlEncode(device);
        var ip = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(ipAddress) ? "Not recorded" : ipAddress);
        var b = baseUrl.TrimEnd('/');

        // Rendered in IST, and SAID to be IST. A timestamp with no zone is the
        // one detail that makes someone unsure whether the sign-in was theirs —
        // the exact doubt this email exists to remove. Users are Indian orgs,
        // so IST is the zone that needs no mental arithmetic.
        var ist = whenUtc.ToOffset(TimeSpan.FromHours(5.5));
        var when = WebUtility.HtmlEncode($"{ist:dddd, d MMMM yyyy 'at' h:mm tt} IST");

        var changePassword = $"{b}/account/password";
        var sessions = $"{b}/account/security";

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>New sign-in to your TatvaOS account</title>
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
                New sign-in to your account
              </h1>
              <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
                Hi {name}, your TatvaOS account was just signed into from a device we
                have not seen before. If this was you, there is nothing to do.
              </p>
            </td>
          </tr>

          <!-- The facts -->
          <tr>
            <td style=""padding:20px 32px 4px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:16px 18px;"">
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">Device</div>
                    <div style=""font-size:15px;font-weight:700;color:{Ink};margin-top:2px;"">{dev}</div>
                  </td>
                </tr>
                <tr><td style=""padding:0 18px;""><div style=""height:1px;background:{Border};""></div></td></tr>
                <tr>
                  <td style=""padding:16px 18px;"">
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">When</div>
                    <div style=""font-size:15px;font-weight:700;color:{Ink};margin-top:2px;"">{when}</div>
                  </td>
                </tr>
                <tr><td style=""padding:0 18px;""><div style=""height:1px;background:{Border};""></div></td></tr>
                <tr>
                  <td style=""padding:16px 18px;"">
                    <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">IP address</div>
                    <div style=""font-size:15px;font-weight:700;color:{Ink};margin-top:2px;"">{ip}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- The action, for the rare reader who needs it -->
          <tr>
            <td style=""padding:22px 32px 4px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""border:1px solid {Border};border-radius:10px;"">
                <tr>
                  <td style=""padding:18px;"">
                    <div style=""font-size:15px;font-weight:700;color:{Ink};"">If this was not you</div>
                    <p style=""margin:6px 0 14px;font-size:14px;line-height:1.6;color:#4d5875;"">
                      Change your password now. That signs out every other device immediately,
                      including whoever just signed in.
                    </p>
                    <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                      <td style=""border-radius:10px;background:{Green};"">
                        <a href=""{changePassword}"" style=""display:inline-block;padding:13px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                          Change my password
                        </a>
                      </td>
                    </tr></table>
                    <p style=""margin:12px 0 0;font-size:13px;color:{Muted};"">
                      You can also review every active session at
                      <a href=""{sessions}"" style=""color:{GreenDark};text-decoration:none;"">your security settings</a>,
                      and tell your organisation's administrator.
                    </p>
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
                security message — please do not reply. We send it whenever your account is used
                on a device it has not been used on before.
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
