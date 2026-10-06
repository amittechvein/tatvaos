'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Stat, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Modal, Field } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { fetchPlans, type PlanRow } from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/myStorage';

// ============================================================================
//  Platform → Personal accounts (build plan §9, part F).
//
//  The list (plan, storage, signup date, last sign-in, trial, status),
//  searchable by address and filtered by Free / paid / suspended / being
//  deleted; the numbers; and the actions — change plan, suspend, resume,
//  delete — each with a reason, each in the audit log under the operator's
//  name (the API writes it). NO PHONE NUMBERS: the API never sends one.
// ============================================================================

interface Row {
  userId: string; email: string; displayName: string;
  createdAt: string; lastLoginAt: string | null;
  plan: string; quotaBytes: number | null; usedBytes: number;
  trial: 'none' | 'running' | 'used'; trialEndsAt: string | null;
  status: 'active' | 'suspended' | 'deleting';
  suspendedReason: string | null; deleteAfter: string | null; deletionReason: string | null;
  sending: string;
}
interface Stats {
  accounts: number;
  signupsByDay: { day: string; count: number }[];
  trialsStarted: number; trialsConverted: number;
  trialAiTokensByDay: { day: string; tokens: number }[];
  suspended: number; deleting: number; purgeLeftovers: number;
  sendingPauses: number | null;
}

const FILTERS = [
  ['all', 'All'], ['free', 'Free'], ['paid', 'Basic and Premium'],
  ['suspended', 'Suspended'], ['deleting', 'Being deleted'],
] as const;

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');

export default function PersonalAccountsPage() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [acting, setActing] = useState<Row | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ q, filter });
    const [r, s] = await Promise.all([
      authedFetch(`/admin/personal-accounts?${qs}`).then((x) => x.json()),
      authedFetch('/admin/personal-accounts/stats').then((x) => x.json()),
    ]);
    setRows(r.rows ?? []);
    setStats(s);
  }, [authedFetch, q, filter]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { fetchPlans(authedFetch).then((p) => setPlans(p.filter((x) => x.audience === 'personal'))).catch(() => setPlans([])); }, [authedFetch]);

  const signups14 = stats?.signupsByDay.reduce((n, d) => n + d.count, 0) ?? 0;
  const trialTokens = stats?.trialAiTokensByDay.reduce((n, d) => n + d.tokens, 0) ?? 0;

  return (
    <AdminShell scope="platform" title="Personal accounts" subtitle="Free personal addresses. No phone numbers are shown here, by design.">
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="mb-4 grid grid-cols-2 gap-3 min-[900px]:grid-cols-5">
        <Stat label="Accounts" value={stats ? String(stats.accounts) : '—'} />
        <Stat label="Signups, last 14 days" value={stats ? String(signups14) : '—'} />
        <Stat label="AI trials started / on Premium" value={stats ? `${stats.trialsStarted} / ${stats.trialsConverted}` : '—'} />
        <Stat label="Trial AI tokens, 14 days" value={stats ? trialTokens.toLocaleString('en-IN') : '—'} />
        <Stat label="Suspended / being deleted" value={stats ? `${stats.suspended} / ${stats.deleting}` : '—'} />
      </div>
      {stats && stats.purgeLeftovers > 0 && (
        <Alert tone="warn" title={`${stats.purgeLeftovers} file(s) from deleted accounts could not be removed yet`}>
          They are retried every hour. Their addresses stay held until they are gone.
        </Alert>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input className="max-w-xs" placeholder="Search by address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by address" />
          <Select className="max-w-[14rem]" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
            {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
        {rows === null ? <Empty title="Loading…" /> : rows.length === 0 ? <Empty title="No personal accounts match" /> : (
          <Table head={['Address', 'Plan', 'Storage', 'Signed up', 'Last sign-in', 'AI trial', 'Status', '']}>
            {rows.map((r) => (
              <tr key={r.userId}>
                <Td><div className="font-medium">{r.email}</div><div className="text-xs text-ink-muted">{r.displayName}</div></Td>
                <Td>{r.plan}</Td>
                <Td>{formatBytes(r.usedBytes)} of {r.quotaBytes ? formatBytes(r.quotaBytes) : '—'}</Td>
                <Td>{day(r.createdAt)}</Td>
                <Td>{day(r.lastLoginAt)}</Td>
                <Td>{r.trial === 'running' ? `Until ${day(r.trialEndsAt)}` : r.trial === 'used' ? 'Used' : '—'}</Td>
                <Td>
                  {r.status === 'active' && <Badge tone="ok">Active</Badge>}
                  {r.status === 'suspended' && <Badge tone="warn">Suspended</Badge>}
                  {r.status === 'deleting' && <Badge tone="danger">Deleting {day(r.deleteAfter)}</Badge>}
                </Td>
                <Td><Button size="sm" onClick={() => setActing(r)}>Manage</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {acting && (
        <ManageModal row={acting} plans={plans} onClose={() => setActing(null)}
                     onDone={(msg) => { setActing(null); setNotice(msg); void load(); }} />
      )}
    </AdminShell>
  );
}

function ManageModal({ row, plans, onClose, onDone }: {
  row: Row; plans: PlanRow[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [reason, setReason] = useState('');
  const [planId, setPlanId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(path: string, method: string, body: unknown, done: string) {
    setBusy(true); setErr(null);
    try {
      const res = await authedFetch(path, { method, body: JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof b.error === 'string' ? b.error : 'That did not work.');
      onDone(done);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const base = `/admin/personal-accounts/${row.userId}`;
  return (
    <Modal title={row.email} subtitle={`${row.plan} · ${row.status}`} onClose={onClose} busy={busy}>
      {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}
      <Field label="Reason" hint="Required for every action. It goes in the audit log with your name.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Testing, goodwill, abuse report…" />
      </Field>

      <div className="mb-5 flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <Field label="Plan">
            <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Choose…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
        <Button disabled={busy || !planId || !reason.trim()}
                onClick={() => post(`${base}/plan`, 'PUT', { planId, reason }, `${row.email}: plan changed.`)}>
          Change plan
        </Button>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {row.status !== 'suspended' ? (
          <Button disabled={busy || !reason.trim()}
                  onClick={() => post(`${base}/suspend`, 'POST', { reason }, `${row.email} suspended: can sign in and download, cannot send.`)}>
            Suspend
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => post(`${base}/resume`, 'POST', {}, `${row.email} resumed.`)}>Resume</Button>
        )}
        {row.suspendedReason && <span className="self-center text-sm text-ink-muted">Suspended for: {row.suspendedReason}</span>}
      </div>

      {row.status !== 'deleting' && (
        <Alert tone="danger" title="Delete this account">
          <p className="mb-2">Everything in it is deleted at the next hourly pass, with no grace period. The address is held for 90 days.</p>
          <Input className="mb-2" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                 placeholder={`Type ${row.email} to confirm`} aria-label="Type the address to confirm" />
          <Button variant="danger" disabled={busy || !reason.trim() || confirm.trim().toLowerCase() !== row.email.toLowerCase()}
                  onClick={() => post(`${base}/delete`, 'POST', { reason, confirmAddress: confirm }, `${row.email} will be deleted at the next pass.`)}>
            Delete account
          </Button>
        </Alert>
      )}
    </Modal>
  );
}
