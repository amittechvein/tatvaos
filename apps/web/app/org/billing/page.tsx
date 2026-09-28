'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { BillingProfileForm } from '@/components/billing/BillingProfileForm';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { fetchMyBilling, fmtDay, inr, saveMyProfile, type BillingSummary, type InvoiceRow } from '@/lib/billing';

// ============================================================================
//  The organisation's own billing page (billing part 1, 26 Sept 2026): its
//  plan and cycle, who its invoices are made out to, and every invoice with
//  what is still owed. Invoices are paid online only, through Razorpay, from
//  each invoice's own page (billing part 2).
// ============================================================================

export default function OrgBillingPage() {
  const { authedFetch } = useAuth();
  const [s, setS] = useState<BillingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMyBilling(authedFetch).then(setS).catch((e: Error) => setError(e.message));
  }, [authedFetch]);
  useEffect(() => { load(); }, [load]);

  const sub = s?.subscription;
  const price = sub
    ? sub.pricePerUserMonthly != null
      ? `${inr(sub.billingCycle === 'yearly' ? sub.pricePerUserYearly ?? sub.pricePerUserMonthly * 12 : sub.pricePerUserMonthly)} per user per ${sub.billingCycle === 'yearly' ? 'year' : 'month'}`
      : sub.priceMonthly != null
        ? `${inr(sub.billingCycle === 'yearly' ? sub.priceYearly ?? sub.priceMonthly * 12 : sub.priceMonthly)} per ${sub.billingCycle === 'yearly' ? 'year' : 'month'}`
        : 'Custom pricing'
    : null;
  const overdue = s?.invoices.filter((i) => i.status === 'issued' && i.overdue) ?? [];

  return (
    <AdminShell scope="organisation" title="Billing" subtitle="Your plan, billing details and invoices">
      {error && <Alert tone="danger">{error}</Alert>}
      {!s && !error && <Card><Empty title="Loading…" /></Card>}
      {s && (
        <div className="space-y-5">
          {overdue.length > 0 && (
            <Alert tone="warn" title="Payment overdue">
              {overdue.length === 1 ? `Invoice ${overdue[0]!.number} was due ${fmtDay(overdue[0]!.dueOn)}.`
                : `${overdue.length} invoices are past their due date.`} Open it and choose Pay now to pay online.
            </Alert>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Your plan">
              {!sub ? <p className="text-[13px] text-ink-muted">No plan yet. Techvein will set one up with you.</p> : (
                <dl className="divide-y divide-line text-[13px]">
                  <Row k="Plan" v={sub.plan} />
                  <Row k="Price" v={`${price} + 18% GST`} />
                  <Row k="Billed" v={sub.billingCycle === 'yearly' ? 'Yearly' : 'Monthly'} />
                  {sub.seats > 0 && <Row k="Users billed" v={String(sub.seats)} />}
                  <Row k="Next period starts" v={sub.renewsAt ? fmtDay(sub.renewsAt) : '—'} />
                  <Row k="Owed now" v={inr(s.outstanding)} />
                </dl>
              )}
            </Card>
            <Card title="Invoices are made out to">
              <BillingProfileForm initial={s.profile} onSave={async (p) => { await saveMyProfile(authedFetch, p); load(); }} />
            </Card>
          </div>

          <Card title="Invoices" padded={false}>
            {s.invoices.length === 0 ? <Empty title="No invoices yet" /> : (
              <Table head={['Number', 'Period', 'Issued', 'Due', 'Total', 'Status', '']}>
                {s.invoices.map((i) => (
                  <tr key={i.id} className={i.status === 'void' ? 'opacity-60' : ''}>
                    <Td><span className="font-mono">{i.number}</span></Td>
                    <Td>{i.periodStart ? `${fmtDay(i.periodStart)} – ${fmtDay(i.periodEnd)}` : '—'}</Td>
                    <Td>{fmtDay(i.issuedOn)}</Td>
                    <Td>{fmtDay(i.dueOn)}</Td>
                    <Td>{inr(i.total)}</Td>
                    <Td><Status row={i} /></Td>
                    <Td>
                      <div className="flex justify-end">
                        {i.status === 'issued'
                          ? <Button size="sm" variant="primary" href={`/org/billing/invoices/${i.id}`}>View and pay</Button>
                          : <Button size="sm" href={`/org/billing/invoices/${i.id}`}>View</Button>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </AdminShell>
  );
}

function Status({ row }: { row: InvoiceRow }) {
  if (row.status === 'paid') return <Badge tone="ok">Paid</Badge>;
  if (row.status === 'void') return <Badge tone="neutral">Cancelled</Badge>;
  return row.overdue ? <Badge tone="danger">Overdue</Badge> : <Badge tone="warn">Due {fmtDay(row.dueOn)}</Badge>;
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4 py-2"><dt className="text-ink-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>;
}
