'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Platform → Reserved names (build plan §3.2, §9). Addresses nobody may take
//  at /join. "Contains" blocks any address with the word in it (tatva,
//  hdfc); "exact" only that address (admin). A person trying one is told only
//  that it isn't available. Removing a name never takes an existing address
//  away from anyone.
// ============================================================================

interface Name { name: string; match: 'exact' | 'contains'; category: string; createdAt: string }

export default function ReservedNamesPage() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<Name[] | null>(null);
  const [name, setName] = useState('');
  const [match, setMatch] = useState<'exact' | 'contains'>('exact');
  const [category, setCategory] = useState('lookalike');
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    authedFetch('/admin/reserved-usernames').then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, [authedFetch]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setErr(null);
    const res = await authedFetch('/admin/reserved-usernames', { method: 'POST', body: JSON.stringify({ name, match, category }) });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(typeof b.error === 'string' ? b.error : 'Could not add it.'); return; }
    setName(''); load();
  }
  async function remove(n: string) {
    setErr(null);
    const res = await authedFetch(`/admin/reserved-usernames/${encodeURIComponent(n)}`, { method: 'DELETE' });
    if (!res.ok) { setErr('Could not remove it.'); return; }
    load();
  }

  const shown = (rows ?? []).filter((r) => r.name.includes(filter.trim().toLowerCase()));

  return (
    <AdminShell scope="platform" title="Reserved names" subtitle="Personal addresses nobody can sign up for.">
      {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}
      <Card title="Add a name">
        <div className="flex flex-wrap items-end gap-2">
          <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. sbi, paytm" aria-label="Name" />
          <Select className="max-w-[11rem]" value={match} onChange={(e) => setMatch(e.target.value as 'exact' | 'contains')} aria-label="Match">
            <option value="exact">Exactly this</option>
            <option value="contains">Anything containing it</option>
          </Select>
          <Select className="max-w-[11rem]" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Kind">
            <option value="system">System or role</option>
            <option value="product">Our names</option>
            <option value="lookalike">Look-alike</option>
            <option value="other">Other</option>
          </Select>
          <Button variant="primary" disabled={name.trim().length < 2} onClick={add}>Reserve</Button>
        </div>
      </Card>
      <Card padded={false} className="mt-4">
        <div className="border-b border-line p-3">
          <Input className="max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
        </div>
        {rows === null ? <Empty title="Loading…" /> : shown.length === 0 ? <Empty title="Nothing reserved matches" /> : (
          <Table head={['Name', 'Match', 'Kind', '']}>
            {shown.map((r) => (
              <tr key={r.name}>
                <Td className="font-mono">{r.name}</Td>
                <Td>{r.match === 'contains' ? <Badge tone="warn">Contains</Badge> : <Badge tone="neutral">Exact</Badge>}</Td>
                <Td className="capitalize">{r.category}</Td>
                <Td><Button size="sm" onClick={() => remove(r.name)}>Remove</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </AdminShell>
  );
}
