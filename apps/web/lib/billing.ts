// ============================================================================
//  Billing, part 1 (26 Sept 2026): GST invoices, billing details, monthly or
//  yearly. Shapes match apps/api/Modules/Billing/BillingEndpoints.cs.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** GST state codes: the first two digits of every GSTIN. */
export const GST_STATES: [string, string][] = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['25', 'Daman and Diu'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'],
  ['28', 'Andhra Pradesh (old)'], ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'],
  ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'],
];
export const stateName = (code: string | null | undefined) =>
  GST_STATES.find(([c]) => c === code)?.[1] ?? code ?? '—';

export const inr = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A day as India sees it. Plain dates ("2026-10-26") are shown as they are.
 * Timestamps are read in India time: renews_at is midnight IST, which is
 * 18:30 UTC the day BEFORE — slicing the ISO string showed "25 Oct" for a
 * period starting on the 26th (found in the browser, 26 Sept 2026).
 */
export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' } as const;
  return iso.length <= 10
    ? new Date(`${iso}T00:00:00+05:30`).toLocaleDateString('en-IN', opts)
    : new Date(iso).toLocaleDateString('en-IN', opts);
};

export interface BillingProfile {
  legalName: string; gstin: string | null; address: string; stateCode: string; pincode: string | null; email: string;
}

export interface InvoiceRow {
  id: string; number: string; status: 'issued' | 'paid' | 'void'; issuedOn: string; dueOn: string;
  periodStart: string | null; periodEnd: string | null; subtotal: number; tax: number; total: number;
  paidOn: string | null; paymentMethod: string | null; overdue: boolean; emailedAt: string | null;
}

export interface BillingSummary {
  profile: BillingProfile | null;
  subscription: {
    status: string; seats: number; renewsAt: string | null; billingCycle: 'monthly' | 'yearly'; plan: string;
    pricePerUserMonthly: number | null; priceMonthly: number | null;
    pricePerUserYearly: number | null; priceYearly: number | null;
  } | null;
  invoices: InvoiceRow[];
  outstanding: number;
}

export interface InvoiceDoc {
  id: string; number: string; status: 'issued' | 'paid' | 'void'; issuedOn: string; dueOn: string;
  periodStart: string | null; periodEnd: string | null; billingCycle: string | null; currency: string;
  seller: { legalName: string; gstin: string; address: string; stateCode: string; sac: string; paymentInstructions: string | null };
  buyer: { organisation: string; legalName: string; gstin: string | null; address: string; stateCode: string; pincode: string | null; email: string };
  placeOfSupply: string; subtotal: number; cgst: number; sgst: number; igst: number; total: number;
  paidOn: string | null; paidAmount: number | null; paymentMethod: string | null; paymentReference: string | null;
  voidedAt: string | null; voidReason: string | null; emailedAt: string | null;
  lines: { lineNo: number; description: string; sac: string; quantity: number; unitPrice: number; amount: number }[];
}

export interface ExtraLine { description: string; quantity: number; unitPrice: number }

export interface InvoicePreview {
  subtotal: number; cgst: number; sgst: number; igst: number; total: number;
  dueOn: string; periodStart: string | null; periodEnd: string | null;
  lines: { lineNo: number; description: string; quantity: number; unitPrice: number; amount: number }[];
}

async function fail(res: Response, fallback: string): Promise<never> {
  let msg = fallback;
  try {
    const b = await res.json();
    if (b && typeof b.error === 'string') msg = b.error;
  } catch { /* keep the fallback */ }
  throw new Error(msg);
}

// ---- operator -------------------------------------------------------------
/** "test" / "live" from the Razorpay key id; null = no keys. */
export type RazorpayMode = 'test' | 'live' | 'unknown' | null;

export async function fetchOrgBilling(f: AuthedFetch, orgId: string): Promise<{ summary: BillingSummary; sellerMissing: string[]; razorpayMode: RazorpayMode }> {
  const res = await f(`/admin/organisations/${orgId}/billing`);
  if (!res.ok) return fail(res, 'Could not load billing.');
  return res.json();
}
export async function saveOrgProfile(f: AuthedFetch, orgId: string, p: BillingProfile): Promise<void> {
  const res = await f(`/admin/organisations/${orgId}/billing/profile`, { method: 'PUT', body: JSON.stringify(p) });
  if (!res.ok) return fail(res, 'Could not save the billing details.');
}
export async function setCycle(f: AuthedFetch, orgId: string, cycle: 'monthly' | 'yearly'): Promise<void> {
  const res = await f(`/admin/organisations/${orgId}/billing/cycle`, { method: 'PUT', body: JSON.stringify({ cycle }) });
  if (!res.ok) return fail(res, 'Could not change the billing cycle.');
}
export async function previewInvoice(f: AuthedFetch, orgId: string, body: { includePlan: boolean; extraLines: ExtraLine[] }): Promise<InvoicePreview> {
  const res = await f(`/admin/organisations/${orgId}/invoices/preview`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) return fail(res, 'Could not work out the invoice.');
  return res.json();
}
export async function issueInvoice(f: AuthedFetch, orgId: string, body: { includePlan: boolean; extraLines: ExtraLine[] }): Promise<InvoiceDoc> {
  const res = await f(`/admin/organisations/${orgId}/invoices`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) return fail(res, 'Could not issue the invoice.');
  return res.json();
}
export async function fetchOperatorInvoice(f: AuthedFetch, orgId: string, invoiceId: string): Promise<InvoiceDoc> {
  const res = await f(`/admin/organisations/${orgId}/invoices/${invoiceId}`);
  if (!res.ok) return fail(res, 'Could not load the invoice.');
  return res.json();
}
export async function markPaid(f: AuthedFetch, orgId: string, invoiceId: string,
  body: { method: string; reference?: string; paidOn?: string }): Promise<void> {
  const res = await f(`/admin/organisations/${orgId}/invoices/${invoiceId}/paid`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) return fail(res, 'Could not record the payment.');
}
/** Voids the invoice; returns a warning when its Razorpay link could not be cancelled. */
export async function voidInvoice(f: AuthedFetch, orgId: string, invoiceId: string, reason: string): Promise<string | null> {
  const res = await f(`/admin/organisations/${orgId}/invoices/${invoiceId}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
  if (!res.ok) return fail(res, 'Could not void the invoice.');
  const body = await res.json();
  return typeof body.warning === 'string' ? body.warning : null;
}

export interface UnpaidSummary {
  outstanding: number; overdue: number;
  invoices: { organisationId: string; organisation: string; id: string; number: string; issuedOn: string; dueOn: string; total: number; overdue: boolean }[];
}
export async function fetchUnpaid(f: AuthedFetch): Promise<UnpaidSummary> {
  const res = await f('/admin/invoices');
  if (!res.ok) return fail(res, 'Could not load unpaid invoices.');
  return res.json();
}

// ---- the organisation itself ----------------------------------------------
export async function fetchMyBilling(f: AuthedFetch): Promise<BillingSummary> {
  const res = await f('/org/billing');
  if (!res.ok) return fail(res, 'Could not load billing.');
  return res.json();
}
export async function saveMyProfile(f: AuthedFetch, p: BillingProfile): Promise<void> {
  const res = await f('/org/billing/profile', { method: 'PUT', body: JSON.stringify(p) });
  if (!res.ok) return fail(res, 'Could not save the billing details.');
}
export async function fetchMyInvoice(f: AuthedFetch, invoiceId: string): Promise<InvoiceDoc> {
  const res = await f(`/org/billing/invoices/${invoiceId}`);
  if (!res.ok) return fail(res, 'Could not load the invoice.');
  return res.json();
}

// ---- paying online (billing part 2: Razorpay only) ------------------------
/** Pay now: the Razorpay page for this invoice (one link per invoice). */
export async function payInvoice(f: AuthedFetch, invoiceId: string): Promise<string> {
  const res = await f(`/org/billing/invoices/${invoiceId}/pay`, { method: 'POST' });
  if (!res.ok) {
    let msg = 'Online payment is not available right now. Please try again shortly.';
    try { const b = await res.json(); msg = b.error ?? b.detail ?? msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return (await res.json()).url as string;
}

/** The customer's return from Razorpay: the query string Razorpay adds, checked by the API. */
export async function confirmPayment(f: AuthedFetch, invoiceId: string, q: URLSearchParams): Promise<void> {
  const res = await f(`/org/billing/invoices/${invoiceId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      razorpayPaymentId: q.get('razorpay_payment_id'),
      razorpayPaymentLinkId: q.get('razorpay_payment_link_id'),
      razorpayPaymentLinkReferenceId: q.get('razorpay_payment_link_reference_id'),
      razorpayPaymentLinkStatus: q.get('razorpay_payment_link_status'),
      razorpaySignature: q.get('razorpay_signature'),
    }),
  });
  if (!res.ok) return fail(res, 'That payment could not be confirmed yet.');
}

export async function checkPayment(f: AuthedFetch, orgId: string, invoiceId: string): Promise<{ status: string; razorpay: string }> {
  const res = await f(`/admin/organisations/${orgId}/invoices/${invoiceId}/check-payment`, { method: 'POST' });
  if (!res.ok) {
    let msg = 'Could not reach Razorpay.';
    try { const b = await res.json(); msg = b.error ?? b.detail ?? msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json();
}

export async function emailInvoice(f: AuthedFetch, orgId: string, invoiceId: string): Promise<void> {
  const res = await f(`/admin/organisations/${orgId}/invoices/${invoiceId}/email`, { method: 'POST' });
  if (!res.ok) {
    let msg = 'The email could not be sent.';
    try { const b = await res.json(); msg = b.error ?? b.detail ?? msg; } catch { /* keep */ }
    throw new Error(msg);
  }
}

// ---- payment problems (Mr. Singh, 26 Sept: never only in a table) ---------
export interface PaymentProblem {
  eventId: string; outcome: string; invoiceId: string | null; invoiceNumber: string | null;
  tenantId: string | null; organisation: string | null; paymentId: string | null;
  amount: number | null; receivedAt: string; alertedAt: string | null;
}
export async function fetchPaymentProblems(f: AuthedFetch): Promise<PaymentProblem[]> {
  const res = await f('/admin/billing/payment-problems');
  if (!res.ok) return fail(res, 'Could not load payment problems.');
  return (await res.json()).problems;
}
export async function acknowledgeProblem(f: AuthedFetch, eventId: string): Promise<void> {
  const res = await f(`/admin/billing/payment-problems/${encodeURIComponent(eventId)}/acknowledge`, { method: 'POST' });
  if (!res.ok) return fail(res, 'Could not acknowledge it.');
}
