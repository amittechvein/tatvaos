namespace TatvaOS.Api.Modules.Billing;

/// <summary>
/// The arithmetic of a GST invoice, kept pure so it can be checked on its own.
///
/// Prices are PLUS 18% GST (Amit, 26 Sept 2026). The buyer's state decides
/// the split: the same state as the seller is CGST 9% + SGST 9%, any other
/// state is IGST 18%. Tax is worked out once on the invoice subtotal, not per
/// line, and rounded half away from zero to the paisa — per-line rounding
/// drifts by a paisa on a long invoice and the total stops adding up.
/// </summary>
public static class InvoiceMath
{
    public const decimal GstRate = 0.18m;

    public sealed record LineIn(string Description, decimal Quantity, decimal UnitPrice);
    public sealed record LineOut(int LineNo, string Description, decimal Quantity, decimal UnitPrice, decimal Amount);
    public sealed record Totals(List<LineOut> Lines, decimal Subtotal, decimal Cgst, decimal Sgst, decimal Igst, decimal Total);

    public static decimal Round(decimal v) => Math.Round(v, 2, MidpointRounding.AwayFromZero);

    public static Totals Compute(IReadOnlyList<LineIn> lines, string sellerState, string buyerState)
    {
        var outLines = lines.Select((l, i) => new LineOut(i + 1, l.Description, l.Quantity, Round(l.UnitPrice),
            Round(l.Quantity * Round(l.UnitPrice)))).ToList();
        var subtotal = outLines.Sum(l => l.Amount);

        decimal cgst = 0, sgst = 0, igst = 0;
        if (sellerState == buyerState)
        {
            // Each half rounded on its own, so CGST and SGST are always equal.
            cgst = Round(subtotal * GstRate / 2);
            sgst = cgst;
        }
        else igst = Round(subtotal * GstRate);

        return new Totals(outLines, subtotal, cgst, sgst, igst, subtotal + cgst + sgst + igst);
    }

    /// <summary>India's financial year for a date: April to March, written "2026-27".</summary>
    public static string FinancialYear(DateOnly d)
    {
        var start = d.Month >= 4 ? d.Year : d.Year - 1;
        return $"{start}-{(start + 1) % 100:00}";
    }

    /// <summary>GST's limit on an invoice number (also a CHECK on core.invoices).</summary>
    public const int MaxNumberLength = 16;

    /// <summary>PREFIX/2026-27/0001: 16 characters with a 3-letter prefix; more than 9,999 in a year would be 17.</summary>
    public static string Number(string prefix, string fy, int seq) => $"{prefix}/{fy}/{seq:0000}";

    public static DateOnly PeriodEnd(DateOnly start, string cycle) =>
        (cycle == "yearly" ? start.AddYears(1) : start.AddMonths(1)).AddDays(-1);

    /// <summary>Today in India. Invoices are dated in India, whatever the server's clock says.</summary>
    public static DateOnly TodayInIndia(DateTimeOffset now) =>
        DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
}
