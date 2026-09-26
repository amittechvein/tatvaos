using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Modules.Billing;

/// <summary>
/// Composes and issues GST invoices (billing part 1, 26 Sept 2026).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT MAKES AN INVOICE ISSUABLE. Techvein's seller details (Settings →
///  Billing) and the organisation's billing profile, both complete. Missing
///  either is a refusal naming what is missing — never an invoice with a
///  blank GSTIN, because an issued invoice cannot be edited.
///
///  ONE PLAN INVOICE PER PERIOD. Issuing the plan line for a period that
///  already has a live (not void) invoice is refused. Two clicks on "Issue"
///  must not bill a school twice. Voiding the first one frees the period.
///
///  The caller has already put the DbContext in this organisation's scope.
///  Every query also names the tenant.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class InvoiceIssuer(AppDbContext db, SettingsReader settings)
{
    public sealed record ExtraLine(string? Description, decimal Quantity, decimal UnitPrice);
    public sealed record IssueRequest(
        bool IncludePlan = true, List<ExtraLine>? ExtraLines = null, DateOnly? PeriodStart = null);

    public sealed record Seller(string LegalName, string Gstin, string Address, string StateCode, string Sac,
        string? PaymentInstructions);
    public sealed record Buyer(string Organisation, string LegalName, string? Gstin, string Address,
        string StateCode, string? Pincode, string Email);

    public sealed record Draft(
        Seller Seller, Buyer Buyer, InvoiceMath.Totals Totals, DateOnly IssuedOn, DateOnly DueOn,
        DateOnly? PeriodStart, DateOnly? PeriodEnd, string? Cycle, bool IncludesPlan);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>What is missing from Techvein's seller details; empty = ready.</summary>
    public async Task<(Seller? Seller, List<string> Missing, string Prefix, int TermsDays)> SellerAsync(CancellationToken ct)
    {
        var all = await settings.GetAsync(ct);
        string? Get(string k) => all.TryGetValue(k, out var v) && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;

        var missing = new List<string>();
        var name = Get(SettingKeys.SellerLegalName) ?? Add(missing, "seller legal name");
        var gstin = Get(SettingKeys.SellerGstin) ?? Add(missing, "seller GSTIN");
        var address = Get(SettingKeys.SellerAddress) ?? Add(missing, "seller address");
        var state = Get(SettingKeys.SellerStateCode) ?? Add(missing, "seller state code");
        var sac = Get(SettingKeys.SellerSac) ?? Add(missing, "SAC code");
        var prefix = Get(SettingKeys.InvoicePrefix) ?? Add(missing, "invoice prefix");

        if (gstin is not null && !BillingRules.IsGstin(gstin)) missing.Add("seller GSTIN is not a valid GSTIN");
        if (state is not null && !BillingRules.IsStateCode(state)) missing.Add("seller state code is not a GST state code");
        if (gstin is not null && state is not null && !gstin.StartsWith(state, StringComparison.Ordinal))
            missing.Add("seller GSTIN does not start with the seller state code");
        if (prefix is not null && !System.Text.RegularExpressions.Regex.IsMatch(prefix, "^[A-Z]{1,4}$"))
            missing.Add("invoice prefix must be 1-4 capital letters");

        var terms = int.TryParse(Get(SettingKeys.PaymentTermsDays), out var t) && t is >= 0 and <= 365 ? t : 15;
        var seller = missing.Count == 0
            // Payment is online only (Razorpay), so there are no bank details to print.
            ? new Seller(name!, gstin!, address!, state!, sac!, null)
            : null;
        return (seller, missing, prefix ?? "", terms);

        static string? Add(List<string> m, string what) { m.Add(what); return null; }
    }

    public async Task<(Draft? Draft, string? Error)> ComposeAsync(Guid tenantId, IssueRequest req, CancellationToken ct)
    {
        var (seller, missing, _, terms) = await SellerAsync(ct);
        if (seller is null)
            return (null, "Fill in Techvein's billing details in Settings → Billing first: " + string.Join(", ", missing) + ".");

        var org = await db.Tenants.AsNoTracking().FirstAsync(t => t.Id == tenantId, ct);
        var profile = await db.BillingProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.TenantId == tenantId, ct);
        if (profile is null)
            return (null, "This organisation has no billing details yet (legal name, address, state, email).");

        var buyer = new Buyer(org.Name, profile.LegalName, profile.Gstin, profile.Address,
            profile.StateCode, profile.Pincode, profile.Email);

        var today = InvoiceMath.TodayInIndia(DateTimeOffset.UtcNow);
        var lines = new List<InvoiceMath.LineIn>();
        DateOnly? periodStart = null, periodEnd = null;
        string? cycle = null;

        if (req.IncludePlan)
        {
            var sub = await db.Subscriptions.AsNoTracking()
                .Where(s => s.TenantId == tenantId && s.Status != "cancelled")
                .OrderByDescending(s => s.StartedAt)
                .FirstOrDefaultAsync(ct);
            if (sub is null) return (null, "This organisation has no plan to bill. Choose a plan first.");
            var plan = await db.Plans.AsNoTracking().FirstAsync(p => p.Id == sub.PlanId, ct);

            cycle = sub.BillingCycle;
            periodStart = req.PeriodStart
                ?? (sub.RenewsAt is DateTimeOffset r ? InvoiceMath.TodayInIndia(r) : today);
            periodEnd = InvoiceMath.PeriodEnd(periodStart.Value, cycle);
            var when = $"{periodStart:dd MMM yyyy} to {periodEnd:dd MMM yyyy}";

            if (plan.PricePerUserMonthly is decimal perUser)
            {
                var unit = cycle == "yearly" ? plan.PricePerUserYearly ?? perUser * 12 : perUser;
                var seats = sub.Seats > 0
                    ? sub.Seats
                    : await db.Users.AsNoTracking().CountAsync(u => u.TenantId == tenantId && u.Status == "active", ct);
                if (seats <= 0) return (null, "The plan is priced per user and this organisation has no seats or active users.");
                lines.Add(new($"{plan.Name} plan, {seats} users, {cycle} ({when})", seats, unit));
            }
            else if (plan.PriceMonthly is decimal flat)
            {
                var unit = cycle == "yearly" ? plan.PriceYearly ?? flat * 12 : flat;
                lines.Add(new($"{plan.Name} plan, {cycle} ({when})", 1, unit));
            }
            else
                return (null, "This plan has custom pricing. Untick the plan line and add the lines yourself.");

            var already = await db.Invoices.AsNoTracking().AnyAsync(i => i.TenantId == tenantId
                && i.Status != "void" && i.PeriodStart == periodStart, ct);
            if (already)
                return (null, $"The period starting {periodStart:dd MMM yyyy} is already invoiced. Void that invoice first to re-issue it.");
        }

        foreach (var x in req.ExtraLines ?? [])
        {
            var d = (x.Description ?? "").Trim();
            if (d.Length == 0 || d.Length > 300) return (null, "Every extra line needs a description (up to 300 characters).");
            if (x.Quantity <= 0 || x.UnitPrice < 0) return (null, "Quantity must be above 0 and the price 0 or more.");
            lines.Add(new(d, x.Quantity, x.UnitPrice));
        }
        if (lines.Count == 0) return (null, "Nothing to invoice: include the plan or add a line.");

        var totals = InvoiceMath.Compute(lines, seller.StateCode, buyer.StateCode);
        return (new Draft(seller, buyer, totals, today, today.AddDays(terms), periodStart, periodEnd, cycle, req.IncludePlan), null);
    }

    /// <summary>
    /// Writes the invoice with the next number for its financial year, in one
    /// transaction: a failed write does not use up a number. The sequence row
    /// is locked by the upsert, so two issues at once queue rather than clash.
    /// </summary>
    public async Task<Invoice> IssueAsync(Guid tenantId, Draft d, Guid actor, CancellationToken ct)
    {
        var (_, _, prefix, _) = await SellerAsync(ct);
        var fy = InvoiceMath.FinancialYear(d.IssuedOn);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.SyncTenantAsync(ct);

        var seq = await db.Database.SqlQuery<int>($"""
            INSERT INTO core.invoice_sequences (financial_year, last_seq) VALUES ({fy}, 1)
            ON CONFLICT (financial_year) DO UPDATE SET last_seq = core.invoice_sequences.last_seq + 1
            RETURNING last_seq AS "Value"
            """).ToListAsync(ct);

        var inv = new Invoice
        {
            TenantId = tenantId,
            Number = InvoiceMath.Number(prefix, fy, seq[0]),
            FinancialYear = fy,
            Seq = seq[0],
            IssuedOn = d.IssuedOn,
            DueOn = d.DueOn,
            PeriodStart = d.PeriodStart,
            PeriodEnd = d.PeriodEnd,
            BillingCycle = d.Cycle,
            Seller = JsonSerializer.Serialize(d.Seller, Json),
            Buyer = JsonSerializer.Serialize(d.Buyer, Json),
            PlaceOfSupply = d.Buyer.StateCode,
            Subtotal = d.Totals.Subtotal,
            Cgst = d.Totals.Cgst,
            Sgst = d.Totals.Sgst,
            Igst = d.Totals.Igst,
            Total = d.Totals.Total,
            CreatedBy = actor,
        };
        foreach (var l in d.Totals.Lines)
            inv.Lines.Add(new InvoiceLine
            {
                LineNo = l.LineNo, TenantId = tenantId, Description = l.Description, Sac = d.Seller.Sac,
                Quantity = l.Quantity, UnitPrice = l.UnitPrice, Amount = l.Amount,
            });
        db.Invoices.Add(inv);

        // The plan's next period starts the day after this one ends.
        if (d.IncludesPlan && d.PeriodEnd is DateOnly end)
        {
            var sub = await db.Subscriptions
                .Where(s => s.TenantId == tenantId && s.Status != "cancelled")
                .OrderByDescending(s => s.StartedAt).FirstAsync(ct);
            // Midnight India time on that day, stored in UTC — Npgsql refuses any
            // other offset for timestamptz, and the refusal is a 500 on issue.
            sub.RenewsAt = new DateTimeOffset(end.AddDays(1).ToDateTime(TimeOnly.MinValue), TimeSpan.FromHours(5.5))
                .ToUniversalTime();
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return inv;
    }
}

/// <summary>GSTIN and state-code shape checks, shared by the endpoints and the issuer.</summary>
public static class BillingRules
{
    // 01-38 are the states and union territories; 97 is "other territory".
    public static bool IsStateCode(string s) =>
        s.Length == 2 && int.TryParse(s, out var n) && ((n >= 1 && n <= 38) || n == 97);

    public static bool IsGstin(string s) =>
        System.Text.RegularExpressions.Regex.IsMatch(s, "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$");
}
