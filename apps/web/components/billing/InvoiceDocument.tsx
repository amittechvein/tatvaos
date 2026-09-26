'use client';

import { fmtDay, inr, stateName, type InvoiceDoc } from '@/lib/billing';

// ============================================================================
//  One GST tax invoice, as the customer receives it. Printed from the
//  browser (Print, then Save as PDF); the print stylesheet hides the console
//  around it. Everything shown is the snapshot taken at issue, never today's
//  settings — an invoice already sent must not change on screen either.
// ============================================================================

const METHOD: Record<string, string> = {
  bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', razorpay: 'Online (Razorpay)', other: 'Other',
};

export function InvoiceDocument({ inv }: { inv: InvoiceDoc }) {
  const intra = inv.igst === 0 && (inv.cgst > 0 || inv.sgst > 0 || inv.seller.stateCode === inv.buyer.stateCode);
  return (
    <article className="invoice-doc mx-auto max-w-3xl rounded-card border border-line bg-white p-4 sm:p-8 text-[13px] text-neutral-900 shadow-card print:border-0 print:p-0 print:shadow-none">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-neutral-300 pb-4">
        <div>
          <div className="text-lg font-bold">{inv.seller.legalName}</div>
          <div className="whitespace-pre-line text-neutral-600">{inv.seller.address}</div>
          <div className="mt-1">GSTIN <span className="font-mono">{inv.seller.gstin}</span> · State {inv.seller.stateCode} ({stateName(inv.seller.stateCode)})</div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold uppercase tracking-wide">Tax invoice</div>
          <div className="mt-1 font-mono text-base">{inv.number}</div>
          <div className="text-neutral-600">Issued {fmtDay(inv.issuedOn)} · Due {fmtDay(inv.dueOn)}</div>
          {inv.status === 'paid' && <div className="mt-1 font-semibold text-green-700">PAID {fmtDay(inv.paidOn)}</div>}
          {inv.status === 'void' && <div className="mt-1 font-semibold text-red-700">VOID: {inv.voidReason}</div>}
        </div>
      </header>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Billed to</div>
          <div className="font-semibold">{inv.buyer.legalName}</div>
          <div className="whitespace-pre-line text-neutral-600">{inv.buyer.address}{inv.buyer.pincode ? ` ${inv.buyer.pincode}` : ''}</div>
          <div>{inv.buyer.gstin ? <>GSTIN <span className="font-mono">{inv.buyer.gstin}</span></> : 'Unregistered (no GSTIN)'}</div>
          <div className="text-neutral-600">{inv.buyer.email}</div>
        </div>
        <div className="sm:text-right">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Place of supply</div>
          <div>{inv.placeOfSupply} ({stateName(inv.placeOfSupply)})</div>
          {inv.periodStart && (
            <div className="mt-2 text-neutral-600">
              Service period {fmtDay(inv.periodStart)} to {fmtDay(inv.periodEnd)}
              {inv.billingCycle ? ` (${inv.billingCycle})` : ''}
            </div>
          )}
          <div className="mt-2 text-neutral-600">For TatvaOS account: {inv.buyer.organisation}</div>
        </div>
      </section>

      {/* Scrolls on its own at phone width rather than widening the page. */}
      <div className="mb-4 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-[11px] uppercase tracking-wide text-neutral-500">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-2">Description</th>
            <th className="py-2 pr-2">SAC</th>
            <th className="py-2 pr-2 text-right">Qty</th>
            <th className="py-2 pr-2 text-right">Rate</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-neutral-200 align-top">
              <td className="py-2 pr-2">{l.lineNo}</td>
              <td className="py-2 pr-2">{l.description}</td>
              <td className="py-2 pr-2 font-mono">{l.sac}</td>
              <td className="py-2 pr-2 text-right">{Number(l.quantity).toLocaleString('en-IN')}</td>
              <td className="py-2 pr-2 text-right">{inr(l.unitPrice)}</td>
              <td className="py-2 text-right">{inr(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="ml-auto w-full max-w-xs space-y-1">
        <Row k="Taxable value" v={inr(inv.subtotal)} />
        {intra ? (
          <>
            <Row k="CGST @ 9%" v={inr(inv.cgst)} />
            <Row k="SGST @ 9%" v={inr(inv.sgst)} />
          </>
        ) : (
          <Row k="IGST @ 18%" v={inr(inv.igst)} />
        )}
        <div className="flex justify-between border-t border-neutral-400 pt-2 text-base font-bold">
          <span>Total</span><span>{inr(inv.total)}</span>
        </div>
      </div>

      {inv.status === 'paid' ? (
        <p className="mt-6 text-neutral-700">
          Received {inr(inv.paidAmount)} on {fmtDay(inv.paidOn)} by {METHOD[inv.paymentMethod ?? ''] ?? inv.paymentMethod}
          {inv.paymentReference ? ` (reference ${inv.paymentReference})` : ''}. Thank you.
        </p>
      ) : inv.status === 'issued' && inv.seller.paymentInstructions ? (
        <div className="mt-6">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">How to pay</div>
          <div className="whitespace-pre-line">{inv.seller.paymentInstructions}</div>
          <div className="mt-1 text-neutral-600">Please quote {inv.number} with your payment.</div>
        </div>
      ) : null}

      <p className="mt-8 text-[11px] text-neutral-500">
        Whether tax is payable on reverse charge: No. This is a computer-generated invoice.
      </p>
    </article>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-neutral-600">{k}</span><span>{v}</span></div>;
}
