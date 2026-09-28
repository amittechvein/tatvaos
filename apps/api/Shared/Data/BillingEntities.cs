using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

/// <summary>Who an organisation's invoices are made out to (core.billing_profiles).</summary>
public class BillingProfile
{
    public Guid TenantId { get; set; }
    [MaxLength(200)] public required string LegalName { get; set; }
    [MaxLength(15)] public string? Gstin { get; set; }
    [MaxLength(500)] public required string Address { get; set; }
    /// <summary>Two-digit GST state code. Decides CGST+SGST versus IGST.</summary>
    [MaxLength(2)] public required string StateCode { get; set; }
    [MaxLength(6)] public string? Pincode { get; set; }
    [MaxLength(320)] public required string Email { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? UpdatedBy { get; set; }
}

/// <summary>
/// A GST tax invoice (core.invoices). Everything a customer was told is copied
/// on at issue and never edited; only payment and void are recorded later.
/// </summary>
public class Invoice
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public required string Number { get; set; }
    public required string FinancialYear { get; set; }
    public int Seq { get; set; }
    /// <summary>issued | paid | void</summary>
    public string Status { get; set; } = "issued";
    public DateOnly IssuedOn { get; set; }
    public DateOnly DueOn { get; set; }
    public DateOnly? PeriodStart { get; set; }
    public DateOnly? PeriodEnd { get; set; }
    public string? BillingCycle { get; set; }
    public string Currency { get; set; } = "INR";
    /// <summary>jsonb snapshot of the seller at issue.</summary>
    public required string Seller { get; set; }
    /// <summary>jsonb snapshot of the buyer at issue.</summary>
    public required string Buyer { get; set; }
    public required string PlaceOfSupply { get; set; }
    public decimal Subtotal { get; set; }
    public decimal Cgst { get; set; }
    public decimal Sgst { get; set; }
    public decimal Igst { get; set; }
    public decimal Total { get; set; }
    public DateOnly? PaidOn { get; set; }
    public decimal? PaidAmount { get; set; }
    public string? PaymentMethod { get; set; }
    public string? PaymentReference { get; set; }
    public Guid? RecordedBy { get; set; }
    public DateTimeOffset? VoidedAt { get; set; }
    public string? VoidReason { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<InvoiceLine> Lines { get; set; } = [];
}

public class InvoiceLine
{
    public Guid InvoiceId { get; set; }
    public int LineNo { get; set; }
    public Guid TenantId { get; set; }
    public required string Description { get; set; }
    public required string Sac { get; set; }
    public decimal Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal Amount { get; set; }
}
