'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import {
  createFeatureOverride, fetchOrgPlan, setKeepsEverything, withdrawFeatureOverride,
  type FeatureState, type OrgPlan, type PlanWarning,
} from '@/lib/adminData';

// ============================================================================
//  What this organisation is entitled to, feature by feature, and why — plus
//  the exceptions the operator makes and the warnings (Amit, 26 Sept 2026).
//
//  Warn first: nothing on this tab stops a customer doing anything. An
//  exception here changes what the warnings say and what a later "stop at the
//  limit" would do, if that is ever decided.
// ============================================================================

const MODULE_NAME: Record<string, string> = {
  mail: 'Mail', connect: 'Connect', drive: 'Space', calendar: 'Calendar',
  family: 'Family', hire: 'Hire', people: 'People',
};

const LEVEL: Record<PlanWarning['level'], { tone: 'danger' | 'warn'; label: string }> = {
  over: { tone: 'danger', label: 'Over the limit' },
  near: { tone: 'warn', label: 'Near the limit' },
  not_in_plan: { tone: 'warn', label: 'Not in the plan' },
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function WarningList({ warnings }: { warnings: PlanWarning[] }) {
  return (
    <ul className="space-y-2">
      {warnings.map((w) => (
        <li key={`${w.code}-${w.level}`} className="flex flex-wrap items-start gap-2 text-[13px]">
          <Badge tone={LEVEL[w.level].tone}>{LEVEL[w.level].label}</Badge>
          <span className="text-ink">{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlanTab({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [data, setData] = useState<OrgPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FeatureState | null>(null);
  const [keepsDialog, setKeepsDialog] = useState(false);

  const load = useCallback(() => {
    fetchOrgPlan(authedFetch, orgId).then(setData).catch((e: Error) => setError(e.message));
  }, [authedFetch, orgId]);
  useEffect(() => { load(); }, [load]);

  async function withdraw(overrideId: string) {
    setError(null);
    try { await withdrawFeatureOverride(authedFetch, orgId, overrideId); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not withdraw.'); }
  }

  if (!data) return error ? <Alert tone="danger">{error}</Alert> : <Card><Empty title="Loading…" /></Card>;

  const ent = data.entitlements;
  // The launcher's order, not the codes' alphabet (which put Mail last).
  const ORDER = ['mail', 'connect', 'drive', 'calendar', 'family', 'hire', 'people'];
  const rank = (c: string | null) => (c === null ? 99 : ORDER.indexOf(c) === -1 ? 50 : ORDER.indexOf(c));
  const groups = [...new Set(ent.features.map((f) => f.productCode))].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card title={ent.planName ? `Plan: ${ent.planName}` : 'No plan'}
            subtitle={ent.planListsFeatures ? 'The plan lists its features' : 'The plan includes every feature of its modules'}
            actions={
              <Button variant="secondary" onClick={() => setKeepsDialog(true)}>
                {ent.keepsEverything ? 'Put on their plan' : 'Let them keep everything'}
              </Button>
            }>
        {ent.keepsEverything ? (
          <Alert tone="info">
            An existing customer: they keep every feature with no limits, whatever the plan says, and get
            no plan warnings. Holds you set below still apply.
          </Alert>
        ) : data.warnings.length === 0 ? (
          <p className="text-[13px] text-ink-muted">Nothing to warn about: what they use is in their plan.</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-ink-muted">
              Warnings only. Nothing has been stopped.
            </p>
            <WarningList warnings={data.warnings} />
          </>
        )}
      </Card>

      {groups.map((g) => (
        <Card key={g ?? 'platform'} padded={false}
              title={g === null ? 'Across all modules' : MODULE_NAME[g] ?? g}
              subtitle={g !== null && !ent.planProducts.includes(g) && !ent.keepsEverything ? 'Module not in the plan' : undefined}>
          <Table head={['Feature', 'Included', 'Why', '']}>
            {ent.features.filter((f) => f.productCode === g).map((f) => (
              <tr key={f.code}>
                <Td>
                  <div className="font-medium text-ink">{f.name}</div>
                  {f.description && <div className="text-[12px] text-ink-muted">{f.description}</div>}
                </Td>
                <Td>
                  {f.kind === 'limit'
                    ? <span className="font-medium">{f.limit === null ? 'No limit' : `${f.limit.toLocaleString('en-IN')} ${f.unit ?? ''}`}</span>
                    : <Badge tone={f.included ? 'ok' : 'neutral'}>{f.included ? 'Yes' : 'No'}</Badge>}
                </Td>
                <Td>
                  <span className="text-[12px] text-ink-muted">
                    {f.source}{f.overrideExpiresAt ? `, until ${fmtDate(f.overrideExpiresAt)}` : ''}
                  </span>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    {f.overrideId && (
                      <Button variant="secondary" size="sm" onClick={() => withdraw(f.overrideId!)}>Withdraw</Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => setEditing(f)}>Exception</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ))}

      <Card title="Exceptions — history" padded={false}>
        {data.overrides.length === 0 ? <Empty title="No exceptions made" /> : (
          <Table head={['Feature', 'What', 'Why', 'By', 'Made', 'Ends']}>
            {data.overrides.map((o) => (
              <tr key={o.id} className={o.withdrawnAt ? 'opacity-60' : ''}>
                <Td>{ent.features.find((f) => f.code === o.featureCode)?.name ?? o.featureCode}</Td>
                <Td>{o.mode === 'grant' ? 'Given' : o.mode === 'revoke' ? 'Held' : `Limit ${o.limitValue?.toLocaleString('en-IN')}`}</Td>
                <Td><span className="text-[12px]">{o.reason}</span></Td>
                <Td>{o.grantedBy ?? '—'}</Td>
                <Td>{fmtDate(o.createdAt)}</Td>
                <Td>{o.withdrawnAt ? `Withdrawn ${fmtDate(o.withdrawnAt)}` : o.expiresAt ? fmtDate(o.expiresAt) : 'No end date'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <OverrideDialog orgId={orgId} feature={editing}
                        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {keepsDialog && (
        <KeepsDialog orgId={orgId} keeps={ent.keepsEverything}
                     onClose={() => setKeepsDialog(false)} onSaved={() => { setKeepsDialog(false); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OverrideDialog({ orgId, feature, onClose, onSaved }: {
  orgId: string; feature: FeatureState; onClose: () => void; onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  const isLimit = feature.kind === 'limit';
  const [mode, setMode] = useState<'grant' | 'revoke'>(feature.included ? 'revoke' : 'grant');
  const [limit, setLimit] = useState(feature.limit === null ? '' : String(feature.limit));
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await createFeatureOverride(authedFetch, orgId, {
        featureCode: feature.code,
        mode: isLimit ? 'limit' : mode,
        limitValue: isLimit ? Number(limit) : null,
        // End of the chosen day, India time — "until 30 Oct" means through it.
        expiresAt: until ? new Date(`${until}T23:59:59+05:30`).toISOString() : null,
        reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const valid = reason.trim().length > 0 && (!isLimit || (limit.trim() !== '' && Number(limit) >= 0));

  return (
    <Modal title={`Exception: ${feature.name}`} busy={busy} onClose={onClose}
           footer={<>
             <Button onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={save} disabled={busy || !valid}>{busy ? 'Saving…' : 'Save'}</Button>
           </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="space-y-4 text-[13px]">
        {isLimit ? (
          <div>
            <label htmlFor="ov-limit" className="mb-1.5 block font-medium text-ink">Their limit</label>
            <Input id="ov-limit" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
        ) : (
          <div>
            <label htmlFor="ov-mode" className="mb-1.5 block font-medium text-ink">What</label>
            <Select id="ov-mode" value={mode} onChange={(e) => setMode(e.target.value as 'grant' | 'revoke')}>
              <option value="grant">Give it to them, outside their plan</option>
              <option value="revoke">Hold it: not included, even if their plan has it</option>
            </Select>
          </div>
        )}
        <div>
          <label htmlFor="ov-until" className="mb-1.5 block font-medium text-ink">Until (optional)</label>
          <Input id="ov-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ov-reason" className="mb-1.5 block font-medium text-ink">Why</label>
          <Input id="ov-reason" value={reason} placeholder="e.g. 30-day trial of Mail AI agreed on the call"
                 onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-ink-muted">
          This replaces any exception already set for this feature. Nothing is switched on or off for
          the customer; it changes what counts as included, and so what the warnings say.
        </p>
      </div>
    </Modal>
  );
}

function KeepsDialog({ orgId, keeps, onClose, onSaved }: {
  orgId: string; keeps: boolean; onClose: () => void; onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try { await setKeepsEverything(authedFetch, orgId, !keeps, reason.trim()); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={keeps ? 'Put them on their plan' : 'Let them keep everything'} busy={busy} onClose={onClose}
           footer={<>
             <Button onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={save} disabled={busy || !reason.trim()}>{busy ? 'Saving…' : 'Confirm'}</Button>
           </>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-4 text-[13px] text-ink">
        {keeps
          ? 'From now on their plan decides what is included, and you will see warnings where they use more. Nothing is switched off for them.'
          : 'They will have every feature with no limits, and no plan warnings, whatever their plan says.'}
      </p>
      <label htmlFor="keeps-reason" className="mb-1.5 block text-[13px] font-medium text-ink">Why</label>
      <Input id="keeps-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}
