using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "Your organisation has used 80 % (or all) of this month's TatvaOS AI."
///
/// Sent by MeteredAiGateway to the organisation's owners and administrators,
/// once per level per month. Leads with the consequence, as the storage
/// warning does: at 80 % nothing has stopped yet; at 100 % AI has stopped for
/// the organisation until the 1st, and everything else is unaffected.
/// Nested tables and inline styles, like the other branded mail; the mailer
/// adds the plain-text part.
/// </summary>
public static class AiUsageWarningEmail
{
    private const string Amber = "#ff9f43";
    private const string Red = "#ff4c51";
    private const string Ink = "#0a0a0a";
    private const string Muted = "#6b7a90";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    public static string Subject(string orgName, short level) =>
        level >= 100
            ? $"TatvaOS AI has stopped for {orgName} until the 1st"
            : $"{orgName} has used 80% of this month's TatvaOS AI";

    public static string Html(string displayName, string orgName, string baseUrl, short level, int percent)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var org = WebUtility.HtmlEncode(orgName);
        var b = baseUrl.TrimEnd('/');
        var stopped = level >= 100;
        var accent = stopped ? Red : Amber;
        var lead = stopped
            ? $"{org} has used all of this month's TatvaOS AI allowance, so AI features have <strong>stopped for your organisation until the 1st</strong>. Everything else — mail, meetings, documents — works as normal."
            : $"{org} has used <strong>{percent}%</strong> of this month's TatvaOS AI allowance. Nothing has stopped. If use continues at this rate, AI features will pause for your organisation until the 1st.";

        return $@"<!DOCTYPE html>
<html lang=""en""><head><meta charset=""utf-8""><meta name=""viewport"" content=""width=device-width, initial-scale=1"">
<meta name=""color-scheme"" content=""light""><title>TatvaOS AI usage</title></head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr><td align=""center"" style=""padding:32px 16px;"">
      <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
             style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
        <tr><td style=""height:6px;background:{accent};line-height:6px;font-size:0;"">&nbsp;</td></tr>
        <tr><td style=""padding:28px 32px 8px 32px;"">
          <p style=""margin:0 0 16px 0;font-size:16px;color:{Ink};"">Hello {name},</p>
          <p style=""margin:0 0 16px 0;font-size:15px;line-height:1.6;color:{Ink};"">{lead}</p>
          <p style=""margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{Muted};"">
            You can see this month's use on the TatvaOS AI page of your organisation's settings.
            The allowance renews on the 1st of each month (India time).</p>
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr><td style=""border-radius:8px;background:{Ink};"">
            <a href=""{b}/org/ai"" style=""display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;"">Open the TatvaOS AI page</a>
          </td></tr></table>
        </td></tr>
        <tr><td style=""padding:24px 32px 28px 32px;font-size:12px;color:{Muted};"">
          You are receiving this because you administer {org} on TatvaOS.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>";
    }
}
