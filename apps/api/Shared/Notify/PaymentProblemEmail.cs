using System.Net;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// "A Razorpay payment needs attention" — to the platform operators, when a
/// payment arrives that TatvaOS did not record as paid: a different amount
/// from the invoice (REVIEW), money for a voided invoice (REFUND NEEDED), or
/// a payment for a link no invoice has (unmatched). Mr. Singh, 26 Sept 2026:
/// recording these only in core.razorpay_events meant nobody would look.
/// Plain and short; it says what to do, and the console lists it until
/// someone acknowledges it.
/// </summary>
public static class PaymentProblemEmail
{
    public static string Subject(string? invoiceNumber) =>
        $"A Razorpay payment needs attention{(invoiceNumber is null ? "" : $" ({invoiceNumber})")}";

    public static string Html(string outcome, string? invoiceNumber, string? paymentId, string amount, string consoleUrl)
    {
        var what = outcome.StartsWith("REVIEW", StringComparison.Ordinal)
            ? "A customer paid a different amount from the invoice, so it was NOT marked paid."
            : outcome.StartsWith("REFUND NEEDED", StringComparison.Ordinal)
                ? "A customer paid an invoice that had been voided. It stays void; the money should be refunded in Razorpay."
                : "Razorpay reported a payment that matches no TatvaOS invoice.";
        string E(string? s) => WebUtility.HtmlEncode(s ?? "—");
        return $@"<!DOCTYPE html><html lang=""en""><head><meta charset=""utf-8""><title>Payment needs attention</title></head>
<body style=""font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0a;"">
<p><strong>{WebUtility.HtmlEncode(what)}</strong></p>
<table cellpadding=""4"" cellspacing=""0"">
<tr><td style=""color:#6b7a90;"">Invoice</td><td>{E(invoiceNumber)}</td></tr>
<tr><td style=""color:#6b7a90;"">Amount received</td><td>{E(amount)}</td></tr>
<tr><td style=""color:#6b7a90;"">Razorpay payment</td><td>{E(paymentId)}</td></tr>
<tr><td style=""color:#6b7a90;"">Recorded as</td><td>{E(outcome)}</td></tr>
</table>
<p>Check the payment in the Razorpay dashboard, then acknowledge it under Payment problems on the
<a href=""{WebUtility.HtmlEncode(consoleUrl)}"">TatvaOS console</a>.</p>
</body></html>";
    }
}
