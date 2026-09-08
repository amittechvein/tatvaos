using System.Net;
namespace TatvaOS.Api.Shared.Notify;
/// <summary>
/// The branded HTML email that carries a recovery-email VERIFICATION link.
/// Same construction rules as <see cref="ResetEmail"/> (nested tables, inline
/// styles, absolute image URLs). Confirming an address only proves the owner
/// can read it — it grants no access — so an unrequested one is harmless, and
/// the copy says so.
/// </summary>
public static class RecoveryVerifyEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Border = "#e6e9ee";
    private const string Canvas = "#f2f4f9";
    public static string Subject() => "Confirm your TatvaOS recovery email";
    public static string Html(string displayName, string baseUrl, string verifyUrl, int minutes)
    {
        var name = WebUtility.HtmlEncode(string.IsNullOrWhiteSpace(displayName) ? "there" : displayName.Split(' ')[0]);
        var url = WebUtility.HtmlEncode(verifyUrl);
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
  <title>Confirm your TatvaOS recovery email</title>
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
                Confirm your recovery email
              </h1>
              <p style=""margin:0;font-size:15px;line-height:1.6;color:#4d5875;"">
                Hi {name}, this address was added as a recovery email for your TatvaOS
                account. Confirm it below so it can help you get back in if you are ever
                locked out.
              </p>
            </td>
          </tr>
          <tr>
            <td align=""center"" style=""padding:28px 32px 8px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{url}"" style=""display:inline-block;padding:14px 34px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Confirm recovery email
                  </a>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style=""padding:18px 32px 34px;"">
              <p style=""margin:0;font-size:13px;line-height:1.6;color:#8d9eb5;"">
                The link is valid for {window}. If you did not add this address, you can
                safely ignore this email — nothing changes until the link is opened.
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
