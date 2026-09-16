'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import { fetchOrganisations, type OrgRow } from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { Card, Empty, Meter, Stat, Table, Td } from '@/components/ui/Kit';

// Platform storage: what every organisation has bought against what they use.
export default function AdminStoragePage() {
  const { authedFetch } = useAuth();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrganisations(authedFetch).then(setOrgs).catch(() => setOrgs([])).finally(() => setLoading(false));
  }, [authedFetch]);

  const totals = useMemo(() => {
    const committed = orgs.reduce((s, o) => s + o.storageTotalBytes, 0);
    const used = orgs.reduce((s, o) => s + o.storageUsedBytes, 0);
    const pct = committed > 0 ? Math.round((used / committed) * 100) : 0;
    return { committed, used, pct, count: orgs.length };
  }, [orgs]);

  // Fullest first — the ones an operator should watch.
  const byUsage = useMemo(
    () => [...orgs].sort((a, b) => {
      const pa = a.storageTotalBytes > 0 ? a.storageUsedBytes / a.storageTotalBytes : 0;
      const pb = b.storageTotalBytes > 0 ? b.storageUsedBytes / b.storageTotalBytes : 0;
      return pb - pa;
    }),
    [orgs],
  );

  return (
    <AdminShell scope="platform" title="Storage" subtitle="Committed against used, across every organisation">
      {/* Three stats: one column on a phone, two from tablet, three on a wide
          screen — the counts overrides.css re-declares, never an arbitrary
          template, which YZEN's own .grid would flatten. */}
      <div className="!mb-[1.5rem] grid !gap-[1.5rem] md:grid-cols-2 xl:grid-cols-3">
        <div>
          <Stat tone="primary" label="Committed" value={formatBytes(totals.committed)}
                caption="bought across all orgs"
                icon={<i className="ri-database-2-line !text-[1.125rem]" />} />
        </div>
        <div>
          <Stat tone="info" label="Used" value={formatBytes(totals.used)}
                caption={`${totals.pct}% of committed`}
                icon={<i className="ri-hard-drive-2-line !text-[1.125rem]" />} />
        </div>
        <div>
          <Stat tone="success" label="Organisations" value={String(totals.count)}
                caption="with a storage pool"
                icon={<i className="ri-building-line !text-[1.125rem]" />} />
        </div>
      </div>

      <Card title="Storage by organisation" subtitle="Fullest first" padded={false}>
        {loading ? (
          <Empty title="Loading…" />
        ) : byUsage.length === 0 ? (
          <Empty title="No organisations yet" hint="Storage appears here once organisations are onboarded." />
        ) : (
          <Table head={['Organisation', 'Plan', 'Used', 'Fill', '']}>
            {byUsage.map((o) => {
              const cap = o.storageTotalBytes;
              const pct = cap > 0 ? Math.round((o.storageUsedBytes / cap) * 100) : 0;
              const hasDomain = o.primaryDomain && o.primaryDomain !== '—';
              return (
                <tr key={o.id}>
                  <Td>
                    <div className="!font-semibold">{o.name}</div>
                    {hasDomain && <div className="!text-[0.75rem] !text-ink-muted">{o.primaryDomain}</div>}
                  </Td>
                  <Td><span className="!text-ink-muted">{o.planName ?? '—'}</span></Td>
                  <Td>
                    <span>{formatBytes(o.storageUsedBytes)}</span>
                    <span className="!text-ink-muted"> / {formatBytes(cap)}</span>
                  </Td>
                  <Td>
                    <div style={{ width: 120 }}>
                      <Meter used={o.storageUsedBytes} total={cap} />
                      <span className="!text-[0.6875rem] !text-ink-muted">{pct}%</span>
                    </div>
                  </Td>
                  <Td className="text-end">
                    <Link href="/admin/organisations"
                          className="inline-flex items-center rounded-lg border border-line bg-surface !px-[0.8rem] !py-[0.25rem] !text-[0.8rem] font-semibold text-ink no-underline hover:bg-canvas">
                      Open
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </AdminShell>
  );
}
