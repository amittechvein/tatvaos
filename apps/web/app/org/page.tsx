'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { Organisation, UserCategory } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatCard } from '@/components/admin/StatCard';
import { StorageBar } from '@/components/admin/StorageBar';

const NAV = [
  { href: '/org', label: 'Overview' },
  { href: '/org/users', label: 'Users' },
  { href: '/org/categories', label: 'Categories' },
];

// Demo default. Real sessions carry the tenant; this is never client-supplied
// in production — the server derives it from the authenticated principal.
const DEMO_TENANT = '22222222-2222-2222-2222-222222222222';

export default function OrgOverview() {
  const [org, setOrg] = useState<Organisation | null>(null);
  const [cats, setCats] = useState<UserCategory[]>([]);

  useEffect(() => {
    adminApi.getOrg(DEMO_TENANT).then(setOrg);
    adminApi.getCategories(DEMO_TENANT).then(setCats);
  }, []);

  if (!org) {
    return (
      <AdminShell scope="organisation" title="Loading…" nav={NAV}>
        <div className="text-sm text-ink-faint">Loading…</div>
      </AdminShell>
    );
  }

  const totalStorage =
    org.storageModel === 'pooled'
      ? (org.pooledStorageBytes ?? 0)
      : (org.perUserQuotaBytes ?? 0) * org.userCount;

  return (
    <AdminShell
      scope="organisation"
      title={org.name}
      subtitle={`${org.primaryDomain} · ${org.planName} plan`}
      nav={NAV}
      actions={
        <Link
          href="/org/users"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Manage users
        </Link>
      }
    >
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Users"
          value={org.userCount}
          hint={org.maxUsers === null ? 'Unlimited' : `of ${org.maxUsers} allowed`}
          tone={org.maxUsers !== null && org.userCount / org.maxUsers > 0.9 ? 'warn' : 'default'}
        />
        <StatCard label="Categories" value={cats.length} />
        <StatCard label="Domains" value={org.domainCount} />
        <StatCard label="Storage used" value={formatBytes(org.storageUsedBytes)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="mb-1 text-sm font-semibold text-ink">Storage</h2>
          <p className="mb-4 text-xs text-ink-muted">
            {org.storageModel === 'pooled'
              ? 'Pooled — one allocation shared across every mailbox'
              : 'Per-user quota — each mailbox has its own fixed allowance'}
          </p>
          <StorageBar used={org.storageUsedBytes} total={totalStorage} />
          {org.storageModel === 'pooled' && (
            <p className="mt-3 text-xs text-ink-muted">
              When a pool fills, every mailbox stops receiving at once. Set a warning threshold well
              below the limit.
            </p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">Users by category</h2>
          <ul className="space-y-3">
            {cats.map((c) => (
              <li key={c.id} className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.colour }}
                />
                <span className="flex-1 text-sm text-ink">{c.name}</span>
                <span className="text-sm font-medium text-ink">{c.userCount}</span>
              </li>
            ))}
            {cats.length === 0 && (
              <li className="text-sm text-ink-faint">No categories defined yet</li>
            )}
          </ul>
        </section>
      </div>
    </AdminShell>
  );
}
