using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Billing;

/// <summary>
/// Billing part 2: paying invoices online through Razorpay (Amit, 26 Sept
/// 2026: "payment mode only online via razorpay").
///
/// ─────────────────────────────────────────────────────────────────────────
///  "Pay now" creates ONE Razorpay Payment Link per invoice, for its exact
///  total, and sends the customer there. The invoice is marked paid by the
///  first of two proofs to arrive, each checked by signature:
///    * Razorpay's webhook, payment_link.paid (webhook secret)
///    * the customer's return to the invoice page (key secret)
///  Neither is trusted for the amount on its own say-so: the webhook's paid
///  amount must equal the invoice total to the paisa, and the link itself
///  cannot take a part payment.
///
///  A webhook that cannot be matched, or whose amount differs, is recorded in
///  core.razorpay_events with the reason and answered 200 — Razorpay retrying
///  an event we will never accept only fills its dashboard. A BAD SIGNATURE
///  is answered 400 and records nothing.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class PaymentEndpoints
{
    public sealed record ReturnRequest(
        string? RazorpayPaymentId, string? RazorpayPaymentLinkId, string? RazorpayPaymentLinkReferenceId,
        string? RazorpayPaymentLinkStatus, string? RazorpaySignature);

    public static void MapPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var org = app.MapGroup("/api/org/billing/invoices/{invoiceId:guid}")
            .RequireAuthorization("OrgAdmin").WithTags("Organisation administration");
        org.MapPost("/pay", PayAsync);
        org.MapPost("/confirm", ConfirmAsync);

        var op = app.MapGroup("/api/admin/organisations/{id:guid}/invoices/{invoiceId:guid}")
            .RequireOperator().WithTags("Platform administration");
        op.MapPost("/check-payment", CheckAsync);
        op.MapPost("/email", EmailAsync);

        app.MapPost("/api/billing/razorpay/webhook", WebhookAsync).AllowAnonymous().WithTags("Billing");

        var problems = app.MapGroup("/api/admin/billing/payment-problems")
            .RequireOperator().WithTags("Platform administration");
        problems.MapGet("/", ProblemsAsync);
        problems.MapPost("/{eventId}/acknowledge", AcknowledgeAsync);
    }

    private static long Paise(decimal rupees) => (long)decimal.Round(rupees * 100m, 0, MidpointRounding.AwayFromZero);

    internal static string ReturnBase(IConfiguration config) =>
        (config["Billing:ReturnBaseUrl"] ?? config["Jwt:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');

    // ------------------------------------------------------------------
    //  Pay now
    // ------------------------------------------------------------------
    private static async Task<IResult> PayAsync(
        Guid invoiceId, AppDbContext db, TenantContext tenant, RazorpayClient razorpay, IConfiguration config,
        ILoggerFactory logs, CancellationToken ct)
    {
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == tenant.TenantId, ct);
        if (inv is null) return Results.NotFound();
        if (inv.Status != "issued")
            return Results.BadRequest(new { error = inv.Status == "paid" ? "This invoice is already paid." : "This invoice was cancelled." });
        if (inv.RazorpayLinkUrl is string existing) return Results.Ok(new { url = existing });

        var buyer = JsonSerializer.Deserialize<InvoiceIssuer.Buyer>(inv.Buyer, InvoiceIssuer.Json)!;
        try
        {
            var link = await razorpay.CreateLinkAsync(
                Paise(inv.Total), inv.Number, $"TatvaOS invoice {inv.Number}", buyer.LegalName, buyer.Email,
                $"{ReturnBase(config)}/org/billing/invoices/{inv.Id}",
                new() { ["invoice_id"] = inv.Id.ToString(), ["tenant_id"] = inv.TenantId.ToString() }, ct);
            if (string.IsNullOrEmpty(link.Id) || string.IsNullOrEmpty(link.ShortUrl))
                return Results.Problem("Razorpay did not return a payment link.", statusCode: 502);

            // Two clicks at once must not leave two links: only the first is
            // kept, and the second click is sent to it.
            var set = await db.Invoices
                .Where(i => i.Id == inv.Id && i.RazorpayLinkId == null)
                .ExecuteUpdateAsync(u => u.SetProperty(i => i.RazorpayLinkId, link.Id)
                                          .SetProperty(i => i.RazorpayLinkUrl, link.ShortUrl), ct);
            if (set == 0)
            {
                var kept = await db.Invoices.AsNoTracking().Where(i => i.Id == inv.Id)
                    .Select(i => i.RazorpayLinkUrl).FirstAsync(ct);
                return Results.Ok(new { url = kept });
            }
            return Results.Ok(new { url = link.ShortUrl });
        }
        catch (RazorpayClient.RazorpayException ex)
        {
            logs.CreateLogger("Billing").LogWarning("Pay now for invoice {Invoice} failed: {Reason}", inv.Id, ex.Message);
            return Results.Problem(ex.Message, statusCode: 502);
        }
    }

    // ------------------------------------------------------------------
    //  The customer's return from Razorpay
    // ------------------------------------------------------------------
    private static async Task<IResult> ConfirmAsync(
        Guid invoiceId, ReturnRequest r, AppDbContext db, TenantContext tenant, RazorpayClient razorpay,
        AuditWriter audit, CancellationToken ct)
    {
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == tenant.TenantId, ct);
        if (inv is null) return Results.NotFound();
        if (inv.Status == "paid") return Results.Ok(new { inv.Status });

        if (inv.RazorpayLinkId is null || r.RazorpayPaymentLinkId != inv.RazorpayLinkId
            || r.RazorpayPaymentLinkReferenceId != inv.Number || r.RazorpayPaymentLinkStatus != "paid"
            || string.IsNullOrWhiteSpace(r.RazorpayPaymentId)
            || !await razorpay.ReturnSignatureOkAsync(r.RazorpayPaymentLinkId!, r.RazorpayPaymentLinkReferenceId!,
                    r.RazorpayPaymentLinkStatus!, r.RazorpayPaymentId!, r.RazorpaySignature, ct))
            return Results.BadRequest(new { error = "That payment could not be confirmed. If you paid, it will show here once Razorpay tells us." });

        if (inv.Status == "issued")
        {
            RecordPaid(inv, r.RazorpayPaymentId!);
            await db.SaveChangesAsync(ct);
            await audit.WriteAsync("invoice.paid", "core.invoice", inv.Id.ToString(),
                after: new { inv.Number, inv.PaidAmount, via = "razorpay return", payment = inv.RazorpayPaymentId }, ct: ct);
        }
        return Results.Ok(new { inv.Status });
    }

    internal static void RecordPaid(Invoice inv, string paymentId)
    {
        inv.Status = "paid";
        inv.PaidOn = InvoiceMath.TodayInIndia(DateTimeOffset.UtcNow);
        inv.PaidAmount = inv.Total;
        inv.PaymentMethod = "razorpay";
        inv.PaymentReference = paymentId;
        inv.RazorpayPaymentId = paymentId;
    }

    // ------------------------------------------------------------------
    //  Razorpay's webhook
    // ------------------------------------------------------------------
    private static async Task<IResult> WebhookAsync(
        HttpRequest request, AppDbContext db, TenantContext tenant, RazorpayClient razorpay, AuditWriter audit,
        SystemMailer mailer, IConfiguration config, ILoggerFactory logs, CancellationToken ct)
    {
        var log = logs.CreateLogger("Billing.Razorpay");

        // Anonymous and public, so the body is capped BEFORE it is read into
        // memory (Mr. Singh, 26 Sept). A Razorpay event is a few KB; 64 KB is
        // generous. Checked on the declared length and again while reading,
        // because a chunked body declares none.
        const int MaxBody = 64 * 1024;
        if (request.ContentLength is > MaxBody) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        using var ms = new MemoryStream();
        var buffer = new byte[8192];
        int n;
        while ((n = await request.Body.ReadAsync(buffer, ct)) > 0)
        {
            if (ms.Length + n > MaxBody) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            ms.Write(buffer, 0, n);
        }
        var raw = ms.ToArray();

        if (!await razorpay.WebhookSignatureOkAsync(raw, request.Headers["X-Razorpay-Signature"], ct))
        {
            log.LogWarning("Razorpay webhook refused: bad or missing signature ({Bytes} bytes)", raw.Length);
            return Results.BadRequest();
        }

        JsonElement root;
        try { root = JsonDocument.Parse(raw).RootElement; }
        catch (JsonException) { return Results.BadRequest(); }

        var type = root.TryGetProperty("event", out var ev) ? ev.GetString() ?? "" : "";
        var eventId = request.Headers["X-Razorpay-Event-Id"].ToString();
        if (string.IsNullOrWhiteSpace(eventId)) eventId = $"noid:{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(raw))[..32]}";

        string? linkId = null, paymentId = null;
        long amountPaid = -1;
        Guid? tenantId = null;
        string? invoiceNumber = null;

        async Task<IResult> Done(string outcome, Guid? invoiceId)
        {
            var inserted = await db.Database.ExecuteSqlAsync($"""
                INSERT INTO core.razorpay_events
                    (event_id, event_type, invoice_id, outcome, tenant_id, invoice_number, link_id, payment_id, amount_paise)
                VALUES ({eventId}, {type}, {invoiceId}, {outcome}, {tenantId}, {invoiceNumber}, {linkId}, {paymentId},
                        {(amountPaid >= 0 ? amountPaid : (long?)null)})
                ON CONFLICT (event_id) DO NOTHING
                """, ct);
            log.LogInformation("Razorpay {Type} {Event}: {Outcome}", type, eventId, outcome);
            // Anything that needs a person is emailed to the platform operators
            // and stays on the console until acknowledged (Mr. Singh: "a
            // customer who has paid and is not recorded is the worst kind of
            // silent failure").
            if (inserted == 1 && IsProblem(outcome))
                await AlertOperatorsAsync(db, mailer, config, eventId, outcome, invoiceNumber, paymentId, amountPaid, log, ct);
            return Results.Ok();
        }

        var seen = await db.Database.SqlQuery<int>($"""
            SELECT count(*)::int AS "Value" FROM core.razorpay_events WHERE event_id = {eventId}
            """).FirstAsync(ct);
        if (seen > 0) return Results.Ok();

        if (type != "payment_link.paid") return await Done("ignored: not payment_link.paid", null);

        try
        {
            var linkEntity = root.GetProperty("payload").GetProperty("payment_link").GetProperty("entity");
            linkId = linkEntity.GetProperty("id").GetString();
            amountPaid = linkEntity.GetProperty("amount_paid").GetInt64();
            paymentId = root.GetProperty("payload").GetProperty("payment").GetProperty("entity").GetProperty("id").GetString();
        }
        catch (Exception) { return await Done("ignored: payload without link, amount or payment", null); }

        // No tenant yet: the SECURITY DEFINER function says whose link this is.
        var owner = await db.Database.SqlQuery<LinkOwner>($"""
            SELECT tenant_id AS "TenantId", invoice_id AS "InvoiceId" FROM core.invoice_by_razorpay_link({linkId})
            """).ToListAsync(ct);
        if (owner.Count == 0) return await Done($"unmatched: no invoice has link {linkId}", null);

        tenantId = owner[0].TenantId;
        tenant.EnterAnonymousScope(owner[0].TenantId, "system");
        await db.SyncTenantAsync(ct);
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == owner[0].InvoiceId && i.TenantId == owner[0].TenantId, ct);
        if (inv is null) return await Done("unmatched: invoice not visible in its own organisation", owner[0].InvoiceId);
        invoiceNumber = inv.Number;
        if (inv.Status == "paid") return await Done("already paid", inv.Id);
        if (inv.Status == "void") return await Done("REFUND NEEDED: paid after the invoice was voided", inv.Id);
        if (amountPaid != Paise(inv.Total))
            return await Done($"REVIEW: paid {amountPaid} paise, invoice is {Paise(inv.Total)}", inv.Id);

        RecordPaid(inv, paymentId!);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("invoice.paid", "core.invoice", inv.Id.ToString(),
            after: new { inv.Number, inv.PaidAmount, via = "razorpay webhook", payment = paymentId }, ct: ct);
        return await Done("paid", inv.Id);
    }

    private sealed record LinkOwner(Guid TenantId, Guid InvoiceId);

    private static bool IsProblem(string outcome) =>
        outcome.StartsWith("REVIEW", StringComparison.Ordinal)
        || outcome.StartsWith("REFUND NEEDED", StringComparison.Ordinal)
        || outcome.StartsWith("unmatched", StringComparison.Ordinal);

    private static async Task AlertOperatorsAsync(
        AppDbContext db, SystemMailer mailer, IConfiguration config, string eventId, string outcome,
        string? invoiceNumber, string? paymentId, long amountPaise, ILogger log, CancellationToken ct)
    {
        // core.users has no RLS; the operators belong to Techvein's tenant,
        // not to the invoice's, so the tenant filter is set aside for this
        // one read of addresses.
        var operators = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Role == "super_admin" && u.Status == "active")
            .Select(u => u.Email).ToListAsync(ct);
        var amount = amountPaise >= 0 ? "₹" + (amountPaise / 100m).ToString("N2", System.Globalization.CultureInfo.GetCultureInfo("en-IN")) : "unknown";
        var sent = 0;
        foreach (var to in operators)
            // From alerts@tatvaos.com (Mr. Singh, 26 Sept): Amit's mail filter
            // keeps that sender out of Spam, and an alert about money is the
            // one that must not land there.
            if (await mailer.SendHtmlAsync(to, PaymentProblemEmail.Subject(invoiceNumber),
                    PaymentProblemEmail.Html(outcome, invoiceNumber, paymentId, amount, $"{ReturnBase(config)}/admin"),
                    from: "alerts@tatvaos.com", ct: ct))
                sent++;
        if (sent > 0)
            await db.Database.ExecuteSqlAsync($"UPDATE core.razorpay_events SET alerted_at = now() WHERE event_id = {eventId}", ct);
        else
            log.LogError("Razorpay payment problem {Event} ({Outcome}) could not be emailed to any of {Count} operator(s)",
                eventId, outcome, operators.Count);
    }

    public sealed record ProblemRow(string EventId, string Outcome, Guid? InvoiceId, string? InvoiceNumber,
        Guid? TenantId, string? PaymentId, long? AmountPaise, DateTimeOffset ReceivedAt, DateTimeOffset? AlertedAt);

    private static async Task<IResult> ProblemsAsync(AppDbContext db, CancellationToken ct)
    {
        var rows = await db.Database.SqlQuery<ProblemRow>($"""
            SELECT event_id AS "EventId", outcome AS "Outcome", invoice_id AS "InvoiceId",
                   invoice_number AS "InvoiceNumber", tenant_id AS "TenantId", payment_id AS "PaymentId",
                   amount_paise AS "AmountPaise", received_at AS "ReceivedAt", alerted_at AS "AlertedAt"
              FROM core.razorpay_events
             WHERE acknowledged_at IS NULL
               AND (outcome LIKE 'REVIEW%' OR outcome LIKE 'REFUND NEEDED%' OR outcome LIKE 'unmatched%')
             ORDER BY received_at
            """).ToListAsync(ct);
        var names = await db.Tenants.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        return Results.Ok(new
        {
            problems = rows.Select(r => new
            {
                r.EventId, r.Outcome, r.InvoiceId, r.InvoiceNumber, r.TenantId,
                organisation = r.TenantId is Guid t ? names.GetValueOrDefault(t) : null,
                r.PaymentId, amount = r.AmountPaise is long p ? p / 100m : (decimal?)null, r.ReceivedAt, r.AlertedAt,
            }),
        });
    }

    private static async Task<IResult> AcknowledgeAsync(
        string eventId, AppDbContext db, AuditWriter audit, HttpContext http, CancellationToken ct)
    {
        var who = TatvaOS.Api.Shared.Auth.SignedIn.UserId(http);
        var n = await db.Database.ExecuteSqlAsync($"""
            UPDATE core.razorpay_events SET acknowledged_at = now(), acknowledged_by = {who}
             WHERE event_id = {eventId} AND acknowledged_at IS NULL
            """, ct);
        if (n == 0) return Results.NotFound();
        await audit.WriteAsync("billing.payment_problem_acknowledged", "core.razorpay_event", eventId, ct: ct);
        return Results.Ok(new { acknowledged = true });
    }

    // ------------------------------------------------------------------
    //  Operator: ask Razorpay directly (a missed webhook), and resend the email
    // ------------------------------------------------------------------
    private static async Task<IResult> CheckAsync(
        Guid id, Guid invoiceId, AppDbContext db, TenantContext tenant, RazorpayClient razorpay, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == id, ct);
        if (inv is null) return Results.NotFound();
        if (inv.RazorpayLinkId is null) return Results.Ok(new { status = inv.Status, razorpay = "no payment link yet (the customer has not pressed Pay now)" });

        try
        {
            var link = await razorpay.GetLinkAsync(inv.RazorpayLinkId, ct);
            if (inv.Status == "issued" && link.Status == "paid" && link.AmountPaid == Paise(inv.Total) && link.PaymentId is string pid)
            {
                RecordPaid(inv, pid);
                await db.SaveChangesAsync(ct);
                await audit.WriteAsync("invoice.paid", "core.invoice", inv.Id.ToString(),
                    after: new { inv.Number, inv.PaidAmount, via = "operator check with razorpay", payment = pid }, ct: ct);
            }
            return Results.Ok(new { status = inv.Status, razorpay = link.Status, amountPaid = link.AmountPaid / 100m });
        }
        catch (RazorpayClient.RazorpayException ex)
        {
            return Results.Problem(ex.Message, statusCode: 502);
        }
    }

    private static async Task<IResult> EmailAsync(
        Guid id, Guid invoiceId, AppDbContext db, TenantContext tenant, SystemMailer mailer, IConfiguration config,
        AuditWriter audit, HttpContext http, CancellationToken ct)
    {
        if (!await Scope(db, tenant, id, http, ct)) return Results.NotFound();
        var inv = await db.Invoices.FirstOrDefaultAsync(i => i.Id == invoiceId && i.TenantId == id, ct);
        if (inv is null) return Results.NotFound();
        if (inv.Status == "void") return Results.BadRequest(new { error = "A void invoice is not sent." });
        var sent = await SendInvoiceEmailAsync(db, mailer, config, inv, ct);
        await audit.WriteAsync("invoice.emailed", "core.invoice", inv.Id.ToString(), after: new { inv.Number, sent }, ct: ct);
        return sent ? Results.Ok(new { sent }) : Results.Problem("The email could not be sent. Try again later.", statusCode: 502);
    }

    /// <summary>The invoice email, to the address on the invoice's buyer snapshot. Best-effort; records when it went.</summary>
    internal static async Task<bool> SendInvoiceEmailAsync(
        AppDbContext db, SystemMailer mailer, IConfiguration config, Invoice inv, CancellationToken ct)
    {
        var buyer = JsonSerializer.Deserialize<InvoiceIssuer.Buyer>(inv.Buyer, InvoiceIssuer.Json)!;
        var inIndia = CultureInfo.GetCultureInfo("en-IN");
        var period = inv.PeriodStart is DateOnly s && inv.PeriodEnd is DateOnly e
            ? $"{s.ToString("d MMM yyyy", inIndia)} to {e.ToString("d MMM yyyy", inIndia)}" : "";
        var ok = await mailer.SendHtmlAsync(buyer.Email,
            InvoiceEmail.Subject(inv.Number, buyer.Organisation),
            InvoiceEmail.Html(buyer.Organisation, buyer.LegalName, inv.Number, "₹" + inv.Total.ToString("N2", inIndia),
                inv.DueOn.ToString("d MMM yyyy", inIndia), period,
                $"{ReturnBase(config)}/org/billing/invoices/{inv.Id}"),
            ct: ct);
        if (ok)
        {
            inv.EmailedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        return ok;
    }

    private static async Task<bool> Scope(AppDbContext db, TenantContext tenant, Guid id, HttpContext http, CancellationToken ct)
    {
        if (!await db.Tenants.AsNoTracking().AnyAsync(t => t.Id == id, ct)) return false;
        tenant.EnterPlatformScope(id, TatvaOS.Api.Shared.Auth.SignedIn.UserIdOrEmpty(http));
        await db.SyncTenantAsync(ct);
        return true;
    }
}
