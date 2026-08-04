'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { Organisation } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { Badge, Button, Card, Empty, Meter, Stat, Table, Td } from '@/components/ui/Kit';
import { BarChart, Donut, SplitBar } from '@/components/ui/Charts';
import { useAuth } from '@/lib/auth';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/organisations', label: 'Organisations' },
  { href: '/admin/plans', label: 'Plans' },
];

/**
 * The platform dashboard — what Techvein sees on signing in.
 *
 * Chosen to answer the four questions an operator actually has on a Monday:
 * how many customers are there, are any of them in trouble, is the platform
 * running out of room, and what changed recently. Vanity totals that never
 * cause an action were left out.
 */
export default function PlatformDashboard() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<Organisation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.getOrgs().then(setOrgs).finally(() => setLoading(false));
  }, []);

  const totals = useMemo(() => {
    const users = orgs.reduce((s, o) => s + o.userCount, 0);
    const used = orgs.reduce((s, o) => s + o.storageUsedBytes, 0);

    // Committed, not used. A pooled customer has bought their whole pool
    // whether or not they have filled it, so that is the number that matters
    // for capacity planning.
    const committed = orgs.reduce((s, o) => {
      if (o.storageModel === 'pooled') return s + (o.pooledStorageBytes ?? 0);
      return s + (o.perUserQuotaBytes ?? 0) * (o.maxUsers ?? o.userCount);
    }, 0);

    return {
      orgs: orgs.length,
      active: orgs.filter((o) => o.status === 'active').length,
      trial: orgs.filter((o) => o.status === 'trial').length,
      suspended: orgs.filter((o) => o.status === 'suspended').length,
      users,
      used,
      committed,
    };
  }, [orgs]);

  /** Customers by type — which segment the platform is actually landing. */
  const byType = useMemo(() => {
    const counts = new Map<string, number>();
    orgs.forEach((o) => counts.set(o.type, (counts.get(o.type) ?? 0) + 1));
    return [...counts.entries()].map(([label, value]) => ({ label, value }));
  }, [orgs]);

  /** Nearest to their storage limit first — the ones about to have a problem. */
  const atRisk = useMemo(() => {
    return orgs
      .map((o) => {
        const cap = o.storageModel === 'pooled'
          ? (o.pooledStorageBytes ?? 0)
          : (o.perUserQuotaBytes ?? 0) * (o.maxUsers ?? o.userCount);
        return { org: o, cap, pct: cap > 0 ? (o.storageUsedBytes / cap) * 100 : 0 };
      })
      .filter((r) => r.pct >= 60)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);
  }, [orgs]);

  const recent = useMemo(
    () => [...orgs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
    [orgs],
  );

  return (
    <AdminShell
      scope="platform"
      title="Dashboard"
      nav={NAV}
      actions={
        <Link href="/admin/organisations/new">
          <Button variant="primary">Onboard organisation</Button>
        </Link>
      }
    >
      {/* Greeting band */}
      <div className="mb-5 overflow-hidden rounded-card bg-brand-600 px-6 py-6 text-white sm:px-8">
        <h2 className="text-lg font-semibold sm:text-xl">
          Welcome back{user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}
        </h2>
        <p className="mt-1 max-w-2xl text-[13px] text-white/80">
          {totals.orgs === 0
            ? 'No organisations yet. Onboarding the first one takes about two minutes.'
            : `${totals.orgs} organisation${totals.orgs === 1 ? '' : 's'} on the platform, ${totals.users} people across them.`}
        </p>
      </div>

      {/* Stat row */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Organisations" caption="Customers on the platform"
          value={String(totals.orgs)}
          icon={<Glyph d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5" />}
        />
        <Stat
          label="People" caption="Across every organisation"
          value={totals.users.toLocaleString()}
          icon={<Glyph d="M16 19v-2a4 4 0 00-8 0v2M12 11a3 3 0 100-6 3 3 0 000 6" />}
        />
        <Stat
          label="Storage used" caption={`of ${formatBytes(totals.committed)} committed`}
          value={formatBytes(totals.used)}
          icon={<Glyph d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />}
        />
        <Stat
          label="Needs attention" caption="Suspended or past due"
          value={String(totals.suspended)}
          icon={<Glyph d="M12 9v4m0 4h.01M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Customers by segment */}
        <Card
          title="By segment"
          subtitle="Which markets the platform is landing"
          className="lg:col-span-2"
        >
          {byType.length === 0
            ? <Empty title="Nothing to chart yet" hint="Segments appear once organisations exist." />
            : <BarChart data={byType} />}
        </Card>

        {/* Capacity */}
        <Card title="Capacity" subtitle="Used against committed">
          <div className="flex flex-col items-center">
            <Donut value={totals.used} total={totals.committed} label="of committed" />
            <p className="mt-4 text-center text-[12px] leading-relaxed text-ink-muted">
              Committed counts what customers have <em>bought</em>, not what they
              have filled. A pooled customer occupies their whole pool from day one.
            </p>
          </div>
        </Card>

        {/* Status split */}
        <Card title="Account status" className="lg:col-span-1">
          <SplitBar
            parts={[
              { label: `Active (${totals.active})`, value: totals.active, colour: '#22c03c' },
              { label: `Trial (${totals.trial})`, value: totals.trial, colour: '#f7b731' },
              { label: `Suspended (${totals.suspended})`, value: totals.suspended, colour: '#ee335e' },
            ]}
          />
          <p className="mt-4 text-[12px] leading-relaxed text-ink-muted">
            A suspended organisation cannot authenticate and receives no mail — it
            is stopped, not deleted.
          </p>
        </Card>

        {/* Approaching their limit */}
        <Card
          title="Approaching their limit"
          subtitle="Above 60% of committed storage"
          className="lg:col-span-2"
          padded={false}
        >
          {atRisk.length === 0 ? (
            <Empty
              title="Nobody is close to full"
              hint="Organisations appear here once they pass 60%, well before anything stops working."
            />
          ) : (
            <Table head={['Organisation', 'Plan', 'Used', '']}>
              {atRisk.map(({ org, cap, pct }) => (
                <tr key={org.id} className="hover:bg-canvas">
                  <Td>
                    <div className="font-medium">{org.name}</div>
                    <div className="text-[12px] text-ink-muted">{org.primaryDomain}</div>
                  </Td>
                  <Td><span className="text-ink-muted">{org.planName}</span></Td>
                  <Td>
                    <div className="text-[12px]">
                      {formatBytes(org.storageUsedBytes)}
                      <span className="text-ink-faint"> / {formatBytes(cap)}</span>
                    </div>
                    <div className="mt-1.5 w-28"><Meter used={org.storageUsedBytes} total={cap} /></div>
                  </Td>
                  <Td>
                    <Badge tone={pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'info'}>
                      {Math.round(pct)}%
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* Recently onboarded */}
      <Card
        title="Recently onboarded"
        className="mt-4"
        padded={false}
        actions={
          <Link href="/admin/organisations">
            <Button variant="secondary">View all</Button>
          </Link>
        }
      >
        {loading ? (
          <Empty title="Loading…" />
        ) : recent.length === 0 ? (
          <Empty
            title="No organisations yet"
            hint="The first customer is the one that proves the onboarding flow works."
            action={
              <Link href="/admin/organisations/new">
                <Button variant="primary">Onboard the first organisation</Button>
              </Link>
            }
          />
        ) : (
          <Table head={['Organisation', 'Domain', 'People', 'Status', 'Joined']}>
            {recent.map((o) => (
              <tr key={o.id} className="hover:bg-canvas">
                <Td>
                  <Link href={`/admin/organisations/${o.id}`} className="font-medium text-brand-600 hover:underline">
                    {o.name}
                  </Link>
                  <div className="text-[12px] capitalize text-ink-muted">{o.type}</div>
                </Td>
                <Td><span className="text-ink-muted">{o.primaryDomain}</span></Td>
                <Td>{o.userCount}</Td>
                <Td><StatusBadge status={o.status} /></Td>
                <Td>
                  <span className="text-ink-muted">
                    {new Date(o.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </AdminShell>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
