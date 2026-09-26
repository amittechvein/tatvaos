'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { BillingProfileForm } from '@/components/billing/BillingProfileForm';
import {
  fetchOrgBilling, fmtDay, inr, issueInvoice, markPaid, previewInvoice, saveOrgProfile, setCycle, voidInvoice,
  type BillingSummary, type ExtraLine, type InvoicePreview, type InvoiceRow,
} from '@/lib/billing';

// ============================================================================
//  One organisation's billing, for the operator (billing part 1, 26 Sept
//  2026): who it is billed to, monthly or yearly, its invoices, and the three
//  things done to an invoice — issue, record payment, void. Nothing here is
//  sent to the customer automatically yet; email and Razorpay's "Pay now" are
//  part 2.
// ============================================================================

export function BillingTab({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [data, setData] = useState<{ summary: BillingSummary; sellerMissing: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [voiding, setVoiding] = useState<InvoiceRow | null>(null);

  const load = useCallback(() => {
    fetchOrgBilling(authedFetch, orgId).then(setData).catch((e: Error) => setError(e.message));
  }, [authedFetch, orgId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert tone="danger">{error}</Alert> : <Card><Empty title="Loading…" /></Card>;
  const { summary: s, sellerMissing } = data;
  const sub = s.subscription;

  async function changeCycle(cycle: 'monthly' | 'yearly') {
    setError(null);
    try { await setCycle(authedFetch, orgId, cycle); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not change it.'); }
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {sellerMissing.length > 0 && (
        <Alert tone="warn" title="Invoices cannot be issued yet">
          Techvein&rsquo;s own details are incomplete: {sellerMissing.join(', ')}.{' '}
          <Link href="/admin/settings" className="font-semibold underline">Fill them in under Settings → Billing</Link>.
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Plan and cycle">
          {!sub ? <p className="text-[13px] text-ink-muted">No plan yet. Choose one in Manage.</p> : (
            <dl className="divide-y divide-line text-[13px]">
              <Row k="Plan" v={sub.plan} />
              <Row k="Seats billed" v={String(sub.seats || 'active users')} />
              <Row k="Next period starts" v={sub.renewsAt ? fmtDay(sub.renewsAt) : 'on the first invoice'} />
              <div className="flex items-center justify-between gap-4 py-2">
                <dt className="text-ink-muted">Billed</dt>
                <dd>
                  <Select aria-label="Billing cycle" value={sub.billingCycle}
                          onChange={(e) => changeCycle(e.target.value as 'monthly' | 'yearly')}>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </Select>
                </dd>
              </div>
              <Row k="Outstanding" v={inr(s.outstanding)} />
            </dl>
          )}
        </Card>
        <Card title="Billed to">
          <BillingProfileForm initial={s.profile} onSave={async (p) => { await saveOrgProfile(authedFetch, orgId, p); load(); }} />
        </Card>
      </div>

      <Card title="Invoices" padded={false}
            actions={<Button variant="primary" onClick={() => setIssuing(true)} disabled={sellerMissing.length > 0 || !s.profile}>Issue invoice</Button>}>
        {s.invoices.length === 0 ? <Empty title="No invoices yet" /> : (
          <Table head={['Number', 'Period', 'Issued', 'Due', 'Total', 'Status', '']}>
            {s.invoices.map((i) => (
              <tr key={i.id} className={i.status === 'void' ? 'opacity-60' : ''}>
                <Td><span className="font-mono">{i.number}</span></Td>
                <Td>{i.periodStart ? `${fmtDay(i.periodStart)} – ${fmtDay(i.periodEnd)}` : '—'}</Td>
                <Td>{fmtDay(i.issuedOn)}</Td>
                <Td>{fmtDay(i.dueOn)}</Td>
                <Td>{inr(i.total)}</Td>
                <Td><StatusBadge row={i} /></Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" href={`/admin/organisations/${orgId}/invoices/${i.id}`}>View</Button>
                    {i.status === 'issued' && <Button size="sm" onClick={() => setPaying(i)}>Mark paid</Button>}
                    {i.status === 'issued' && <Button size="sm" onClick={() => setVoiding(i)}>Void</Button>}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {issuing && <IssueDialog orgId={orgId} onClose={() => setIssuing(false)} onDone={() => { setIssuing(false); load(); }} />}
      {paying && <PaidDialog orgId={orgId} inv={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />}
      {voiding && <VoidDialog orgId={orgId} inv={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); load(); }} />}
    </div>
  );
}

export function StatusBadge({ row }: { row: InvoiceRow }) {
  if (row.status === 'paid') return <Badge tone="ok">Paid</Badge>;
  if (row.status === 'void') return <Badge tone="neutral">Void</Badge>;
  return row.overdue ? <Badge tone="danger">Overdue</Badge> : <Badge tone="warn">Unpaid</Badge>;
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4 py-2"><dt className="text-ink-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>;
}

// ---------------------------------------------------------------------------

function IssueDialog({ orgId, onClose, onDone }: { orgId: string; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAuth();
  const [includePlan, setIncludePlan] = useState(true);
  const [lines, setLines] = useState<{ description: string; quantity: string; unitPrice: string }[]>([]);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extra = (): ExtraLine[] => lines
    .filter((l) => l.description.trim())
    .map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity || 1), unitPrice: Number(l.unitPrice || 0) }));

  // Any change invalidates the figures shown: issuing must never happen on a
  // preview of something else.
  useEffect(() => { setPreview(null); }, [includePlan, lines]);

  async function doPreview() {
    setBusy(true); setError(null);
    try { setPreview(await previewInvoice(authedFetch, orgId, { includePlan, extraLines: extra() })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not work it out.'); }
    finally { setBusy(false); }
  }
  async function doIssue() {
    setBusy(true); setError(null);
    try { await issueInvoice(authedFetch, orgId, { includePlan, extraLines: extra() }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not issue it.'); setBusy(false); }
  }

  return (
    <Modal title="Issue invoice" size="lg" busy={busy} onClose={onClose}
           footer={<>
             <Button onClick={onClose} disabled={busy}>Cancel</Button>
             {preview
               ? <Button variant="primary" onClick={doIssue} disabled={busy}>{busy ? 'Issuing…' : `Issue for ${inr(preview.total)}`}</Button>
               : <Button variant="primary" onClick={doPreview} disabled={busy}>{busy ? 'Working it out…' : 'Preview'}</Button>}
           </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="space-y-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={includePlan} onChange={(e) => setIncludePlan(e.target.checked)} />
          The plan, for its next period
        </label>
        <div>
          <div className="mb-2 font-medium text-ink">Other lines (e.g. an AI credits top-up)</div>
          {lines.map((l, i) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_70px_110px_auto] gap-2">
              <Input aria-label="Description" placeholder="Description" value={l.description}
                     onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <Input aria-label="Quantity" type="number" min={1} value={l.quantity}
                     onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
              <Input aria-label="Price each, before GST" type="number" min={0} placeholder="₹ before GST" value={l.unitPrice}
                     onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
              <Button size="sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>Add a line</Button>
        </div>

        {preview && (
          <div className="rounded-lg border border-line p-3">
            {preview.lines.map((l) => (
              <div key={l.lineNo} className="flex justify-between gap-4 py-1">
                <span>{l.description} × {l.quantity}</span><span>{inr(l.amount)}</span>
              </div>
            ))}
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              <div className="flex justify-between"><span className="text-ink-muted">Before GST</span><span>{inr(preview.subtotal)}</span></div>
              {preview.igst > 0
                ? <div className="flex justify-between"><span className="text-ink-muted">IGST 18% (another state)</span><span>{inr(preview.igst)}</span></div>
                : <div className="flex justify-between"><span className="text-ink-muted">CGST 9% + SGST 9% (same state)</span><span>{inr(preview.cgst + preview.sgst)}</span></div>}
              <div className="flex justify-between font-semibold"><span>Total</span><span>{inr(preview.total)}</span></div>
              <div className="text-ink-muted">Due {fmtDay(preview.dueOn)}. Once issued it cannot be edited, only voided.</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PaidDialog({ orgId, inv, onClose, onDone }: { orgId: string; inv: InvoiceRow; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAuth();
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await markPaid(authedFetch, orgId, inv.id, { method, reference: reference || undefined, paidOn: paidOn || undefined }); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not record it.'); setBusy(false); }
  }
  return (
    <Modal title={`Record payment for ${inv.number}`} busy={busy} onClose={onClose}
           footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : `Paid ${inr(inv.total)}`}</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-muted">The whole amount, {inr(inv.total)}. Part payments are not recorded yet.</p>
        <Select aria-label="How it was paid" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option>
          <option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option>
        </Select>
        <Input aria-label="Reference" placeholder="UTR / cheque number (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
        <Input aria-label="Paid on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </div>
    </Modal>
  );
}

function VoidDialog({ orgId, inv, onClose, onDone }: { orgId: string; inv: InvoiceRow; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAuth();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await voidInvoice(authedFetch, orgId, inv.id, reason.trim()); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not void it.'); setBusy(false); }
  }
  return (
    <Modal title={`Void ${inv.number}`} busy={busy} onClose={onClose}
           footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={save} disabled={busy || !reason.trim()}>{busy ? 'Voiding…' : 'Void invoice'}</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-3 text-[13px] text-ink-muted">
        It stays on record with its number, marked void. Its period can then be invoiced again, under a new number.
      </p>
      <Input aria-label="Why" placeholder="Why (e.g. wrong billing cycle)" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
