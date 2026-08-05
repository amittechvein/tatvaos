'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import { fetchOrganisations, type OrgRow } from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { Button, Card, Empty, Meter, Table, Td } from '@/components/ui/Kit';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/organisations', label: 'Organisations' },
  { href: '/admin/plans', label: 'Plans' },
];

const TYPE_LABEL: Record<string, string> = {
  business: 'Business', school: 'School', hospital: 'Hospital',
  nonprofit: 'Non-profit', government: 'Government', other: 'Other',
};

const STATUSES = ['all', 'active', 'trial', 'suspended', 'pending'] as const;

/** Every customer on the platform. The dashboard summarises; this is the list. */
export default function AdminOrganisations() {
  const { authedFetch } = useAuth();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrganisations(authedFetch)
      .then(setOrgs)
      .catch(() => setOrgs([]))
      .finally(() => setLoading(false));
  }, [authedFetch]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orgs.filter((o) => {
      const matchQ = !q
        || o.name.toLowerCase().includes(q)
        || o.primaryDomain.toLowerCase().includes(q)
        || o.adminEmail.toLowerCase().includes(q);
      return matchQ && (status === 'all' || o.status === status);
    });
  }, [orgs, query, status]);

  return (
    <AdminShell
      scope="platform"
      title="Organisations"
      subtitle="Every customer on the platform"
      nav={NAV}
      actions={
        <Link href="/admin/organisations/new">
          <Button variant="primary">Onboard organisation</Button>
        </Link>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-card border px-3 py-1.5 text-[13px] capitalize transition
              ${status === s
                ? 'border-brand-500 bg-brand-50 font-medium text-brand-700'
                : 'border-line text-ink-muted hover:border-ink-faint'}`}
          >
            {s}
            {s !== 'all' && (
              <span className="ml-1.5 text-ink-faint">
                {orgs.filter((o) => o.status === s).length}
              </span>
            )}
          </button>
        ))}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, domain or admin"
          className="ml-auto w-full max-w-xs rounded-card border border-line bg-surface px-3 py-2 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-400"
        />
      </div>

      <Card padded={false}>
        {loading ? (
          <Empty title="Loading…" />
        ) : filtered.length === 0 ? (
          <Empty
            title={orgs.length === 0 ? 'No organisations yet' : 'Nothing matches that filter'}
            hint={orgs.length === 0
              ? 'Onboarding creates the tenant, its primary domain and a starting set of user categories.'
              : undefined}
            action={orgs.length === 0 ? (
              <Link href="/admin/organisations/new">
                <Button variant="primary">Onboard the first organisation</Button>
              </Link>
            ) : undefined}
          />
        ) : (
          <Table head={['Organisation', 'Type', 'Plan', 'People', 'Storage', 'Status']}>
            {filtered.map((o) => {
              const cap = o.storageTotalBytes;

              return (
                <tr key={o.id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`/admin/organisations/${o.id}`} className="font-medium text-brand-600 hover:underline">
                      {o.name}
                    </Link>
                    <div className="text-[12px] text-ink-muted">{o.primaryDomain}</div>
                  </Td>
                  <Td><span className="text-ink-muted">{TYPE_LABEL[o.type] ?? o.type}</span></Td>
                  <Td>
                    <div style={{ textTransform: 'capitalize' }}>{o.storageModel.replace('_', ' ')}</div>
                    <div className="text-[12px] capitalize text-ink-faint">
                      {o.storageModel.replace('_', ' ')}
                    </div>
                  </Td>
                  <Td>
                    {o.userCount}
                    {o.maxUsers !== null && (
                      <span className="text-ink-faint"> / {o.maxUsers}</span>
                    )}
                  </Td>
                  <Td>
                    <div className="text-[12px]">
                      {formatBytes(o.storageUsedBytes)}
                      <span className="text-ink-faint"> / {formatBytes(cap)}</span>
                    </div>
                    <div className="mt-1.5 w-28"><Meter used={o.storageUsedBytes} total={cap} /></div>
                  </Td>
                  <Td><StatusBadge status={o.status} /></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="mt-3 text-[12px] text-ink-muted">
        Listing organisations reads each one under its own tenant context rather than
        with row-level security disabled. There is deliberately no &ldquo;see
        everything&rdquo; mode — a bug in one would be unbounded.
      </p>
    </AdminShell>
  );
}
