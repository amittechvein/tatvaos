using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "Your storage is nearly full."
///
/// Same construction rules as the other branded mail — nested tables, inline
/// styles. See WelcomeEmail for why.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS EMAIL EXISTS TO BE ACTED ON, SO IT LEADS WITH THE CONSEQUENCE.
///
///  An admin who receives "storage at 82%" and nothing else files it. What
///  makes someone act is knowing what breaks and when — under pooled storage
///  the answer is that EVERY mailbox stops receiving at once, which is not
///  something people guess. So the number is the subject and the consequence
///  is the first line.
///
///  The critical version says plainly that new users are already blocked,
///  because by then it is true and the admin will otherwise discover it by
///  failing to create one.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class StorageWarningEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Amber = "#ff9f43";
    private const string Red = "#ff4c51";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject(string orgName, int percent, bool critical) =>
        critical
            ? $"Action needed: {orgName} storage is {percent}% full"
            : $"{orgName} storage is {percent}% full";

    /// <param name="pooled">Pooled storage fails for everyone at once; per-user does not.</param>
    public static string Html(
        string displayName, string orgName, string baseUrl,
        int percent, bool critical, bool pooled, string usedText, string totalText)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var org = WebUtility.HtmlEncode(orgName);
        var b = baseUrl.TrimEnd('/');
        var accent = critical ? Red : Amber;

        var consequence = critical
            ? (pooled
                ? "Once the pool is full, <strong>every mailbox in your organisation stops receiving mail at the same moment</strong> — not gradually, and not just the heaviest users. New people cannot be added until space is freed."
                : "New people cannot be added until space is freed, and mailboxes at their limit will stop receiving.")
            : (pooled
                ? "This is a shared pool, so when it fills, <strong>every mailbox stops receiving at once</strong> rather than one at a time. It is worth acting before that."
                : "Mailboxes that reach their individual limit will stop receiving mail.");

        return $@"<!DOCTYPE html>
<html lang=""en""><head><meta charset=""utf-8"">
<meta name=""viewport"" content=""width=device-width, initial-scale=1"">
<meta name=""color-scheme"" content=""light""><title>Storage {percent}% full</title></head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr><td align=""center"" style=""padding:32px 16px;"">
      <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
             style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">

        <tr><td style=""background:{Green};background-image:linear-gradient(120deg,{GreenDark} 0%,{Green} 100%);padding:28px 32px;"">
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
            <td style=""vertical-align:middle;"">
              <img src=""{b}/brand/core-logo.png"" width=""34"" height=""34"" alt=""""
                   style=""display:block;border:0;border-radius:8px;background:#ffffff;"">
            </td>
            <td style=""vertical-align:middle;padding-left:12px;"">
              <span style=""font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;"">TatvaOS</span>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style=""padding:36px 32px 8px;"">
          <h1 style=""margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:800;color:{Ink};"">
            {org} storage is {percent}% full
          </h1>
          <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
            Hi {name} — {consequence}
          </p>
        </td></tr>

        <!-- The bar. A number people can act on, shown as a shape they can read at a glance. -->
        <tr><td style=""padding:24px 32px 4px;"">
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                 style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
            <tr><td style=""padding:18px;"">
              <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">In use</div>
              <div style=""font-size:20px;font-weight:800;color:{Ink};margin:4px 0 12px;"">{usedText} of {totalText}</div>
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:#e6e9ee;border-radius:999px;"">
                <tr><td style=""height:10px;line-height:10px;font-size:0;"">
                  <table role=""presentation"" width=""{percent}%"" cellpadding=""0"" cellspacing=""0"" style=""background:{accent};border-radius:999px;"">
                    <tr><td style=""height:10px;line-height:10px;font-size:0;"">&nbsp;</td></tr>
                  </table>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

        <tr><td align=""center"" style=""padding:24px 32px 8px;"">
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
            <td style=""border-radius:10px;background:{Green};"">
              <a href=""{b}/org/storage"" style=""display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                Review storage
              </a>
            </td>
          </tr></table>
          <p style=""margin:14px 0 0;font-size:12px;color:{Muted};"">
            You can see which mailboxes are heaviest, and move space between products.
          </p>
        </td></tr>

        <tr><td style=""padding:24px 32px 28px;border-top:1px solid {Border};"">
          <p style=""margin:0;font-size:12px;line-height:1.6;color:{Muted};"">
            Sent by <strong style=""color:#4d5875;"">no_reply@tatvaos.com</strong> to the administrators of {org}.
            You receive this once each time storage crosses a threshold — not repeatedly.
          </p>
        </td></tr>
      </table>
      <p style=""margin:16px 0 0;font-size:11px;color:{Muted};font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
        © TatvaOS by Techvein
      </p>
    </td></tr>
  </table>
</body></html>";
    }
}
