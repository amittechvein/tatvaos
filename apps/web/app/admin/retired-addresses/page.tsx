'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Platform → Retired addresses (Mr. Singh, 26 Sept 2026). Every address that
//  stopped being used — organisations' and personal accounts' — held so that
//  nobody new is handed the previous owner's mail from disk.
//
//  This page is the ONLY way one is released: a person, a reason, and only
//  once the mail server has counted zero message files for it. The server
//  checks every condition again when you press Release; the button being
//  enabled here is a convenience, not the rule. Every release is audited.
//
//  Wording is DRAFT until Mr. Singh and Amit approve it.
// ============================================================================

interface Row {
  id: number; address: string; tenantId: string | null; source: string;
  retiredAt: string; notBefore: string | null;
  filesLeft: number | null; filesCheckedAt: string | null;
  releasedAt: string | null; releaseReason: string | null;
  releasable: boolean; blocker: string | null;
}

const SOURCES: Record<string, string> = {
  user_deleted: 'Person deleted',
  user_offboarded: 'Person offboarded',
  shared_mailbox_deactivated: 'Shared mailbox closed',
  domain_removed: 'Domain removed',
  personal_deleted: 'Personal account deleted',
  mailbox_deleted: 'Mailbox deleted',
  alias_deleted: 'Alias deleted',
  existing: 'Already inactive',
};

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
}

export default function RetiredAddressesPage() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'held' | 'released' | 'all'>('held');
  const [releasing, setReleasing] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ status, ...(q.trim() ? { q: q.trim() } : {}) });
    authedFetch(`/admin/retired-addresses?${qs}`).then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, [authedFetch, q, status]);
  useEffect(() => { load(); }, [load]);

  async function release() {
    if (!releasing) return;
    setErr(null);
    const res = await authedFetch(`/admin/retired-addresses/${releasing.id}/release`, {
      method: 'POST', body: JSON.stringify({ reason }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(typeof b.error === 'string' ? b.error : 'Could not release it.'); return; }
    setDone(`${releasing.address} was released. It can be used again.`);
    setReleasing(null); setReason(''); load();
  }

  return (
    <AdminShell scope="platform" title="Retired addresses"
                subtitle="Addresses that stopped being used, held so nobody new receives the old owner's mail.">
      {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}
      {done && <Alert tone="ok" onDismiss={() => setDone(null)}>{done}</Alert>}

      {releasing && (
        <Card title={`Release ${releasing.address}?`} className="mb-4">
          <p className="mb-3 text-sm">
            Anyone will be able to use this address again. The mail server has counted no mail left for it.
            Say why. The reason is kept with the release and in the audit log.
          </p>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mb-3"
                 placeholder="Why this address is being released" aria-label="Reason" />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={reason.trim().length === 0} onClick={release}>Release</Button>
            <Button onClick={() => { setReleasing(null); setReason(''); }}>Cancel</Button>
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input className="max-w-xs" placeholder="Search addresses" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <Select className="max-w-[10rem]" value={status} onChange={(e) => setStatus(e.target.value as 'held' | 'released' | 'all')} aria-label="Status">
            <option value="held">Held</option>
            <option value="released">Released</option>
            <option value="all">All</option>
          </Select>
        </div>
        {rows === null ? <Empty title="Loading…" /> : rows.length === 0 ? <Empty title="No addresses match" /> : (
          <Table head={['Address', 'Why', 'Retired', 'Mail left on disk', '']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono break-all">{r.address}</Td>
                <Td>{SOURCES[r.source] ?? r.source}</Td>
                <Td>{day(r.retiredAt)}{r.notBefore && !r.releasedAt ? <div className="text-xs text-ink-muted">Not before {day(r.notBefore)}</div> : null}</Td>
                <Td>
                  {r.filesCheckedAt === null ? <Badge tone="neutral">Not counted yet</Badge>
                    : r.filesLeft === 0 ? <Badge tone="ok">None</Badge>
                    : <Badge tone="warn">{r.filesLeft} file(s)</Badge>}
                </Td>
                <Td>
                  {r.releasedAt ? (
                    <div className="text-xs text-ink-muted">Released {day(r.releasedAt)}: {r.releaseReason}</div>
                  ) : r.releasable ? (
                    <Button size="sm" onClick={() => { setReleasing(r); setReason(''); setErr(null); }}>Release…</Button>
                  ) : (
                    <span className="text-xs text-ink-muted">{r.blocker}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </AdminShell>
  );
}
