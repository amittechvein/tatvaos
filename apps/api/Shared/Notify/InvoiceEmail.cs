using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "Invoice TV/2026-27/0001 for ₹1,168.20 — pay online." Sent to the address
/// on the organisation's billing details when an invoice is issued (billing
/// part 2, 26 Sept 2026). Payment is online only, through Razorpay, from the
/// invoice's page in TatvaOS: the email links there, never straight to a
/// payment page, so the customer can see what they are paying for first.
/// Same nested-table shape as the other branded mail; the mailer adds the
/// plain-text part (HTML-only system mail went to spam — PR 258).
/// </summary>
public static class InvoiceEmail
{
    private const string Ink = "#0a0a0a";
    private const string Muted = "#6b7a90";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";
    private const string Brand = "#6c3ce9";

    public static string Subject(string number, string orgName) => $"Invoice {number} for {orgName}";

    public static string Html(string orgName, string legalName, string number, string total, string dueOn,
        string period, string invoiceUrl)
    {
        var org = WebUtility.HtmlEncode(orgName);
        var legal = WebUtility.HtmlEncode(legalName);
        var num = WebUtility.HtmlEncode(number);
        var tot = WebUtility.HtmlEncode(total);
        var due = WebUtility.HtmlEncode(dueOn);
        var per = WebUtility.HtmlEncode(period);
        var url = WebUtility.HtmlEncode(invoiceUrl);

        return $@"<!DOCTYPE html>
<html lang=""en""><head><meta charset=""utf-8""><meta name=""viewport"" content=""width=device-width, initial-scale=1"">
<meta name=""color-scheme"" content=""light""><title>Invoice {num}</title></head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr><td align=""center"" style=""padding:32px 16px;"">
      <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
             style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
        <tr><td style=""height:6px;background:{Brand};line-height:6px;font-size:0;"">&nbsp;</td></tr>
        <tr><td style=""padding:28px 32px 8px 32px;"">
          <p style=""margin:0 0 16px 0;font-size:16px;color:{Ink};"">Hello,</p>
          <p style=""margin:0 0 16px 0;font-size:15px;line-height:1.6;color:{Ink};"">
            Here is TatvaOS invoice <strong>{num}</strong> for {org}{(string.IsNullOrEmpty(per) ? "" : $", for {per}")}.</p>
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0"" style=""margin:0 0 20px 0;font-size:14px;color:{Ink};"">
            <tr><td style=""padding:4px 16px 4px 0;color:{Muted};"">Billed to</td><td style=""padding:4px 0;"">{legal}</td></tr>
            <tr><td style=""padding:4px 16px 4px 0;color:{Muted};"">Amount (incl. GST)</td><td style=""padding:4px 0;font-weight:600;"">{tot}</td></tr>
            <tr><td style=""padding:4px 16px 4px 0;color:{Muted};"">Due by</td><td style=""padding:4px 0;"">{due}</td></tr>
          </table>
          <p style=""margin:0 0 20px 0;font-size:14px;line-height:1.6;color:{Muted};"">
            Pay online by card, UPI or net banking: open the invoice and choose <strong>Pay now</strong>.
            You can also print it or save it as a PDF from there. An administrator of {org} needs to sign in.</p>
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr><td style=""border-radius:8px;background:{Ink};"">
            <a href=""{url}"" style=""display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;"">Open the invoice</a>
          </td></tr></table>
        </td></tr>
        <tr><td style=""padding:24px 32px 28px 32px;font-size:12px;color:{Muted};"">
          You are receiving this because this address is the billing contact for {org} on TatvaOS.
          TatvaOS will never ask you to pay into a bank account by email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>";
    }
}
