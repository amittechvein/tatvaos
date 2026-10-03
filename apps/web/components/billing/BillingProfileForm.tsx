'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { GST_STATES, type BillingProfile } from '@/lib/billing';

// ============================================================================
//  Who the invoices are made out to. Shared by the operator's Billing tab and
//  the organisation's own billing page. The state decides the tax (same state
//  as Techvein: CGST + SGST; anywhere else: IGST), and a GSTIN must start with
//  that state's code — checked here for a quick answer and again by the API
//  and the database, which are the ones that count.
// ============================================================================

const EMPTY: BillingProfile = { legalName: '', gstin: '', address: '', stateCode: '', pincode: '', email: '' };

export function BillingProfileForm({ initial, onSave }: {
  initial: BillingProfile | null;
  onSave: (p: BillingProfile) => Promise<void>;
}) {
  const [p, setP] = useState<BillingProfile>({ ...EMPTY, ...(initial ?? {}), gstin: initial?.gstin ?? '', pincode: initial?.pincode ?? '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const set = (k: keyof BillingProfile, v: string) => setP({ ...p, [k]: v });

  const gstin = (p.gstin ?? '').trim().toUpperCase();
  const gstinClash = gstin.length >= 2 && p.stateCode && !gstin.startsWith(p.stateCode);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await onSave({ ...p, gstin: gstin || null, pincode: (p.pincode ?? '').trim() || null });
      setMsg({ tone: 'ok', text: 'Saved. New invoices use these details; invoices already issued keep theirs.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  const label = 'mb-1.5 block text-[13px] font-medium text-ink';
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="bp-name" className={label}>Legal name (as on the GST registration)</label>
          <Input id="bp-name" value={p.legalName} onChange={(e) => set('legalName', e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="bp-address" className={label}>Billing address</label>
          <Input id="bp-address" value={p.address} onChange={(e) => set('address', e.target.value)} />
        </div>
        <div>
          <label htmlFor="bp-state" className={label}>State</label>
          <Select id="bp-state" value={p.stateCode} onChange={(e) => set('stateCode', e.target.value)}>
            <option value="">Choose…</option>
            {GST_STATES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="bp-pin" className={label}>PIN code</label>
          <Input id="bp-pin" inputMode="numeric" maxLength={6} value={p.pincode ?? ''} onChange={(e) => set('pincode', e.target.value)} />
        </div>
        <div>
          <label htmlFor="bp-gstin" className={label}>GSTIN (leave empty if not registered)</label>
          <Input id="bp-gstin" maxLength={15} value={p.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
          {gstinClash && (
            <div className="mt-1 text-xs text-danger">A GSTIN starts with its state code: this one says {gstin.slice(0, 2)}, the state chosen is {p.stateCode}.</div>
          )}
        </div>
        <div>
          <label htmlFor="bp-email" className={label}>Email for invoices</label>
          <Input id="bp-email" type="email" value={p.email} onChange={(e) => set('email', e.target.value)} />
        </div>
      </div>
      <Button variant="primary" onClick={save}
              disabled={busy || !p.legalName.trim() || !p.address.trim() || !p.stateCode || !p.email.includes('@') || Boolean(gstinClash)}>
        {busy ? 'Saving…' : 'Save billing details'}
      </Button>
    </div>
  );
}
