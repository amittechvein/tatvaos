using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Billing;

/// <summary>
/// Billing, part 1 (Amit, 26 Sept 2026): billing details, monthly or yearly,
/// GST invoices, recording payment, voiding. Razorpay is part 2; reminders,
/// the grace period and read-only are part 3.
///
/// The operator's routes run in platform scope for one organisation at a
/// time, like every other operator route; the organisation's own routes run
/// in its session. Invoices are never deleted and never edited once issued.
/// </summary>
public static class BillingEndpoints
{
    public sealed record ProfileRequest(string? LegalName, string? Gstin, string? Address, string? StateCode,
        string? Pincode, string? Email);
    public sealed record CycleRequest(string? Cycle);
    public sealed record MarkPaidRequest(decimal? Amount, string? Method, string? Reference, DateOnly? PaidOn);
    public sealed record VoidRequest(string? Reason);
    public sealed record UnpaidRow(Guid OrganisationId, string Organisation, Guid Id, string Number,
        DateOnly IssuedOn, DateOnly DueOn, decimal Total, bool Overdue);

    public static void MapBillingEndpoints(this IEndpointRouteBuilder app)
    {
        var op = app.MapGroup("/api/admin/organisations/{id:guid}")
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");
        op.MapGet("/billing", OperatorBillingAsync);
        op.MapPut("/billing/profile", OperatorProfileAsync);
        op.MapPut("/billing/cycle", CycleAsync);
        op.MapPost("/invoices/preview", PreviewAsync);
        op.MapPost("/invoices", IssueAsync);
        op.MapGet("/invoices/{invoiceId:guid}", OperatorInvoiceAsync);
        op.MapPost("/invoices/{invoiceId:guid}/paid", MarkPaidAsync);
        op.MapPost("/invoices/{invoiceId:guid}/void", VoidAsync);

        app.MapGet("/api/admin/invoices", AllInvoicesAsync)
            .RequireAuthorization("SuperAdmin").WithTags("Platform administration");

        var org = app.MapGroup("/api/org/billing")
            .RequireAuthorization("OrgAdmin").WithTags("Organisation administration");
        org.MapGet("/", OrgBillingAsync);
        org.MapPut("/profile", OrgProfileAsync);
        org.MapGet("/invoices/{invoiceId:guid}", OrgInvoiceAsync);
    }

    // ------------------------------------------------------------------
    //  Reads
    // ------------------------------------------------------------------
    private static async Task<object> SummaryAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var profile = await db.BillingProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.TenantId == tenantId, ct);
        var sub = await db.Subscriptions.AsNoTracking()
            .Where(s => s.TenantId == tenantId && s.Status != "cancelled")
            .OrderByDescending(s => s.StartedAt)
            .Select(s => new
            {
                s.Status, s.Seats, s.RenewsAt, s.BillingCycle,
                plan = s.Plan!.Name, s.Plan.PricePerUserMonthly, s.Plan.PriceMonthly,
                s.Plan.PricePerUserYearly, s.Plan.PriceYearly,
            })
            .FirstOrDefaultAsync(ct);
        var invoices = await db.Invoices.AsNoTracking()
            .Where(i => i.TenantId == tenantId)
            .OrderByDescending(i => i.IssuedOn).ThenByDescending(i => i.Seq)
            .Select(i => new
            {
                i.Id, i.Number, i.Status, i.IssuedOn, i.DueOn, i.PeriodStart, i.PeriodEnd,
                i.Subtotal, i.Cgst, i.Sgst, i.Igst, i.Total, i.PaidOn, i.PaymentMethod, i.EmailedAt,
            })
            .ToListAsync(ct);
        var today = InvoiceMath.TodayInIndia(DateTimeOffset.UtcNow);
        return new
        {
            profile = profile is null ? null : new
            {
                profile.LegalName, profile.Gstin, profile.Address, profile.StateCode, profile.Pincode, profile.Email,
            },
            subscription = sub,
            invoices = invoices.Select(i => new
            {
                i.Id, i.Number, i.Status, i.IssuedOn, i.DueOn, i.PeriodStart, i.PeriodEnd,
                i.Subtotal, tax = i.Cgst + i.Sgst + i.Igst, i.Total, i.PaidOn, i.PaymentMethod, i.EmailedAt,
                overdue = i.Status == "issued" && i.DueOn < today,
            }),
            outstanding = invoices.Where(i => i.Status == "issued").Sum(i => i.Total),
        };
    }

    private static object InvoiceDto(Invoice i) => new
    {
        i.Id, i.Number, i.Status, i.IssuedOn, i.DueOn, i.PeriodStart, i.PeriodEnd, i.BillingCycle, i.Currency,
        seller = JsonSerializer.Deserialize<JsonElement>(i.Seller),
        buyer = JsonSerializer.Deserialize<JsonElement>(i.Buyer),
        i.PlaceOfSupply, i.Subtotal, i.Cgst, i.Sgst, i.Igst, i.Total,
        i.PaidOn, i.PaidAmount, i.PaymentMethod, i.PaymentReference, i.VoidedAt, i.VoidReason, i.EmailedAt,
        lines = i.Lines.OrderBy(l => l.LineNo)
            .Select(l => new { l.LineNo, l.Description, l.Sac, l.Quantity, l.UnitPrice, l.Amount }),
    };

    private static async Task<IResult> OperatorBillingAsync(
        Guid id, AppDbContext db, TenantContext tenant, InvoiceIssuer issuer, RazorpayClient razorpay,
        HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var (_, missing, _, _) = await issuer.SellerAsync(ct);
        // Online payment needs the Razorpay keys; say so here rather than on
        // the customer's first "Pay now".
        var mode = await razorpay.ModeAsync(ct);
        return Results.Ok(new { summary = await SummaryAsync(db, id, ct), sellerMissing = missing, razorpayMode = mode });
    }

    private static async Task<IResult> OrgBillingAsync(AppDbContext db, TenantContext tenant, CancellationToken ct) =>
        Results.Ok(await SummaryAsync(db, tenant.TenantId, ct));

    private static async Task<IResult> OperatorInvoiceAsync(
        Guid id, Guid invoiceId, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var inv = await db.Invoices.AsNoTracking().Include(i => i.Lines)
            .FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == id, ct);
        return inv is null ? Results.NotFound() : Results.Ok(InvoiceDto(inv));
    }

    private static async Task<IResult> OrgInvoiceAsync(
        Guid invoiceId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var inv = await db.Invoices.AsNoTracking().Include(i => i.Lines)
            .FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == tenant.TenantId, ct);
        return inv is null ? Results.NotFound() : Results.Ok(InvoiceDto(inv));
    }

    /// <summary>Every unpaid invoice on the platform, oldest due first — one organisation at a time.</summary>
    private static async Task<IResult> AllInvoicesAsync(
        AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var orgs = await db.Tenants.AsNoTracking().Select(t => new { t.Id, t.Name }).ToListAsync(ct);
        var today = InvoiceMath.TodayInIndia(DateTimeOffset.UtcNow);
        var rows = new List<UnpaidRow>();
        decimal outstanding = 0, overdue = 0;
        foreach (var o in orgs)
        {
            tenant.EnterPlatformScope(o.Id, CurrentUserId(http));
            await db.SyncTenantAsync(ct);
            var unpaid = await db.Invoices.AsNoTracking()
                .Where(i => i.TenantId == o.Id && i.Status == "issued")
                .Select(i => new { i.Id, i.Number, i.IssuedOn, i.DueOn, i.Total })
                .ToListAsync(ct);
            foreach (var i in unpaid)
            {
                outstanding += i.Total;
                if (i.DueOn < today) overdue += i.Total;
                rows.Add(new UnpaidRow(o.Id, o.Name, i.Id, i.Number, i.IssuedOn, i.DueOn, i.Total, i.DueOn < today));
            }
        }
        return Results.Ok(new
        {
            outstanding, overdue,
            invoices = rows.OrderBy(r => r.DueOn),
        });
    }

    // ------------------------------------------------------------------
    //  Billing details and cycle
    // ------------------------------------------------------------------
    private static string? Validate(ProfileRequest r)
    {
        if (string.IsNullOrWhiteSpace(r.LegalName)) return "The legal name is required.";
        if (string.IsNullOrWhiteSpace(r.Address)) return "The billing address is required.";
        var state = (r.StateCode ?? "").Trim();
        if (!BillingRules.IsStateCode(state)) return "Choose the state (its two-digit GST code).";
        var gstin = (r.Gstin ?? "").Trim().ToUpperInvariant();
        if (gstin.Length > 0)
        {
            if (!BillingRules.IsGstin(gstin)) return "That GSTIN is not valid (15 characters, e.g. 10ABCDE1234F1Z5).";
            if (!gstin.StartsWith(state, StringComparison.Ordinal))
                return $"A GSTIN starts with its state code: this one says {gstin[..2]}, the state chosen is {state}.";
        }
        var pin = (r.Pincode ?? "").Trim();
        if (pin.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(pin, "^[1-9][0-9]{5}$"))
            return "The PIN code is six digits.";
        if (string.IsNullOrWhiteSpace(r.Email) || !r.Email.Contains('@')) return "An email address for invoices is required.";
        return null;
    }

    private static async Task<IResult> SaveProfileAsync(
        Guid tenantId, ProfileRequest r, AppDbContext db, AuditWriter audit, Guid actor, CancellationToken ct)
    {
        if (Validate(r) is string err) return Results.BadRequest(new { error = err });
        var p = await db.BillingProfiles.FirstOrDefaultAsync(x => x.TenantId == tenantId, ct);
        var before = p is null ? null : new { p.LegalName, p.Gstin, p.Address, p.StateCode, p.Pincode, p.Email };
        if (p is null)
        {
            p = new BillingProfile { TenantId = tenantId, LegalName = "", Address = "", StateCode = "", Email = "" };
            db.BillingProfiles.Add(p);
        }
        p.LegalName = r.LegalName!.Trim();
        p.Gstin = string.IsNullOrWhiteSpace(r.Gstin) ? null : r.Gstin.Trim().ToUpperInvariant();
        p.Address = r.Address!.Trim();
        p.StateCode = r.StateCode!.Trim();
        p.Pincode = string.IsNullOrWhiteSpace(r.Pincode) ? null : r.Pincode.Trim();
        p.Email = r.Email!.Trim();
        p.UpdatedAt = DateTimeOffset.UtcNow;
        p.UpdatedBy = actor;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("billing.profile_updated", "core.billing_profile", tenantId.ToString(),
            before, new { p.LegalName, p.Gstin, p.Address, p.StateCode, p.Pincode, p.Email }, ct);
        return Results.Ok(new { p.LegalName, p.Gstin, p.Address, p.StateCode, p.Pincode, p.Email });
    }

    private static async Task<IResult> OperatorProfileAsync(
        Guid id, ProfileRequest r, AppDbContext db, TenantContext tenant, AuditWriter audit, HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        return await SaveProfileAsync(id, r, db, audit, CurrentUserId(http), ct);
    }

    private static Task<IResult> OrgProfileAsync(
        ProfileRequest r, AppDbContext db, TenantContext tenant, AuditWriter audit, HttpContext http, CancellationToken ct) =>
        SaveProfileAsync(tenant.TenantId, r, db, audit, CurrentUserId(http), ct);

    private static async Task<IResult> CycleAsync(
        Guid id, CycleRequest r, AppDbContext db, TenantContext tenant, AuditWriter audit, HttpContext http, CancellationToken ct)
    {
        if (r.Cycle is not ("monthly" or "yearly")) return Results.BadRequest(new { error = "Monthly or yearly." });
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var sub = await db.Subscriptions.Where(s => s.TenantId == id && s.Status != "cancelled")
            .OrderByDescending(s => s.StartedAt).FirstOrDefaultAsync(ct);
        if (sub is null) return Results.BadRequest(new { error = "Choose a plan first." });
        var before = sub.BillingCycle;
        sub.BillingCycle = r.Cycle;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("billing.cycle_changed", "core.subscription", sub.Id.ToString(),
            new { cycle = before }, new { cycle = sub.BillingCycle }, ct);
        return Results.Ok(new { cycle = sub.BillingCycle });
    }

    // ------------------------------------------------------------------
    //  Invoices
    // ------------------------------------------------------------------
    private static async Task<IResult> PreviewAsync(
        Guid id, InvoiceIssuer.IssueRequest req, AppDbContext db, TenantContext tenant, InvoiceIssuer issuer,
        HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var (draft, error) = await issuer.ComposeAsync(id, req, ct);
        return draft is null ? Results.BadRequest(new { error }) : Results.Ok(DraftDto(draft));
    }

    private static async Task<IResult> IssueAsync(
        Guid id, InvoiceIssuer.IssueRequest req, AppDbContext db, TenantContext tenant, InvoiceIssuer issuer,
        AuditWriter audit, TatvaOS.Api.Shared.Notify.SystemMailer mailer, IConfiguration config,
        HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var (draft, error) = await issuer.ComposeAsync(id, req, ct);
        if (draft is null) return Results.BadRequest(new { error });

        Invoice inv;
        try { inv = await issuer.IssueAsync(id, draft, CurrentUserId(http), ct); }
        catch (InvoiceNumberTooLongException ex) { return Results.BadRequest(new { error = ex.Message }); }
        // Emailed to the billing contact at once (billing part 2). A failed
        // send does not undo the invoice; the Billing tab shows it was not
        // sent and offers to send it again.
        var emailed = await PaymentEndpoints.SendInvoiceEmailAsync(db, mailer, config, inv, ct);
        await audit.WriteAsync("invoice.issued", "core.invoice", inv.Id.ToString(),
            after: new { inv.Number, inv.Total, inv.PeriodStart, inv.PeriodEnd, lines = inv.Lines.Count, emailed }, ct: ct);
        return Results.Created($"/api/admin/organisations/{id}/invoices/{inv.Id}", InvoiceDto(inv));
    }

    private static object DraftDto(InvoiceIssuer.Draft d) => new
    {
        d.Seller, d.Buyer, d.IssuedOn, d.DueOn, d.PeriodStart, d.PeriodEnd, d.Cycle,
        placeOfSupply = d.Buyer.StateCode,
        lines = d.Totals.Lines, d.Totals.Subtotal, d.Totals.Cgst, d.Totals.Sgst, d.Totals.Igst, d.Totals.Total,
    };

    private static async Task<IResult> MarkPaidAsync(
        Guid id, Guid invoiceId, MarkPaidRequest r, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        if (r.Method is not ("bank_transfer" or "upi" or "cheque" or "cash" or "other"))
            return Results.BadRequest(new { error = "How was it paid: bank transfer, UPI, cheque, cash or other." });
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == id, ct);
        if (inv is null) return Results.NotFound();
        if (inv.Status != "issued")
            return Results.BadRequest(new { error = inv.Status == "paid" ? "Already marked paid." : "A void invoice cannot be paid." });

        // Part payment is not supported: an invoice is settled whole. A
        // different amount is refused rather than recorded as "paid".
        var amount = r.Amount ?? inv.Total;
        if (amount != inv.Total)
            return Results.BadRequest(new { error = $"The invoice is for ₹{inv.Total:N2}. Part payments are not recorded yet." });
        var today = InvoiceMath.TodayInIndia(DateTimeOffset.UtcNow);
        var paidOn = r.PaidOn ?? today;
        if (paidOn > today || paidOn < inv.IssuedOn.AddDays(-30))
            return Results.BadRequest(new { error = "The payment date must be today or earlier, and not long before the invoice." });

        inv.Status = "paid";
        inv.PaidOn = paidOn;
        inv.PaidAmount = amount;
        inv.PaymentMethod = r.Method;
        inv.PaymentReference = string.IsNullOrWhiteSpace(r.Reference) ? null : r.Reference.Trim();
        inv.RecordedBy = CurrentUserId(http);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("invoice.paid", "core.invoice", inv.Id.ToString(),
            after: new { inv.Number, inv.PaidAmount, inv.PaidOn, inv.PaymentMethod, inv.PaymentReference }, ct: ct);
        return Results.Ok(new { inv.Id, inv.Status, inv.PaidOn });
    }

    private static async Task<IResult> VoidAsync(
        Guid id, Guid invoiceId, VoidRequest r, AppDbContext db, TenantContext tenant, AuditWriter audit,
        RazorpayClient razorpay, ILoggerFactory logs, HttpContext http, CancellationToken ct)
    {
        var reason = (r.Reason ?? "").Trim();
        if (reason.Length == 0) return Results.BadRequest(new { error = "Say why it is void. It stays on record with its number." });
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == id, ct);
        if (inv is null) return Results.NotFound();
        if (inv.Status != "issued")
            return Results.BadRequest(new { error = inv.Status == "paid" ? "A paid invoice is not voided; that needs a credit note." : "Already void." });

        inv.Status = "void";
        inv.VoidedAt = DateTimeOffset.UtcNow;
        inv.VoidReason = reason;
        await db.SaveChangesAsync(ct);
        // Cancel its Razorpay link too, so an old invoice email cannot still
        // pay it (Mr. Singh, 26 Sept). If Razorpay cannot be reached the void
        // stands, and a payment that arrives anyway is recorded REFUND NEEDED
        // and alerted; the operator is told here.
        bool? linkCancelled = null;
        if (inv.RazorpayLinkId is string linkId)
        {
            try { await razorpay.CancelLinkAsync(linkId, ct); linkCancelled = true; }
            catch (Exception ex) when (ex is RazorpayClient.RazorpayException or HttpRequestException)
            {
                linkCancelled = false;
                logs.CreateLogger("Billing").LogWarning("Invoice {Invoice} voided but its Razorpay link was not cancelled: {Reason}",
                    inv.Id, ex.Message);
            }
        }
        await audit.WriteAsync("invoice.voided", "core.invoice", inv.Id.ToString(),
            after: new { inv.Number, inv.Total, reason, linkCancelled }, ct: ct);
        return Results.Ok(new
        {
            inv.Id, inv.Status, linkCancelled,
            warning = linkCancelled == false
                ? "Voided, but its Razorpay payment link could not be cancelled. If the customer pays it, you will be alerted to refund."
                : null,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<bool> Scope(AppDbContext db, TenantContext tenant, Guid id, HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return false;
        tenant.EnterPlatformScope(id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);
        return true;
    }

    private static Guid CurrentUserId(HttpContext http) =>
        TatvaOS.Api.Shared.Auth.SignedIn.UserIdOrEmpty(http);
}
