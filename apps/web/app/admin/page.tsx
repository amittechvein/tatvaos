'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { Organisation } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatCard } from '@/components/admin/StatCard';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { StorageBar } from '@/components/admin/StorageBar';

const NAV = [
  { href: '/admin', label: 'Organisations' },
  { href: '/admin/plans', label: 'Plans' },
];

const TYPE_LABEL: Record<string, string> = {
  business: 'Business', school: 'School', hospital: 'Hospital',
  nonprofit: 'Non-profit', government: 'Government', other: 'Other',
};

export default function AdminOrganisations() {
  const [orgs, setOrgs] = useState<Organisation[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    adminApi.getOrgs().then(setOrgs);
  }, []);

  const filtered = orgs.filter((o) => {
    const q = query.trim().toLowerCase();
    const matchQ =
      !q || o.name.toLowerCase().includes(q) || o.primaryDomain.toLowerCase().includes(q);
    const matchS = statusFilter === 'all' || o.status === statusFilter;
    return matchQ && matchS;
  });

  const totals = {
    orgs: orgs.length,
    users: orgs.reduce((s, o) => s + o.userCount, 0),
    storage: orgs.reduce((s, o) => s + o.storageUsedBytes, 0),
    suspended: orgs.filter((o) => o.status === 'suspended').length,
  };

  return (
    <AdminShell
      scope="platform"
      title="Organisations"
      subtitle="Every customer on the platform"
      nav={NAV}
      actions={
        <Link
          href="/admin/organisations/new"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          Onboard organisation
        </Link>
      }
    >
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Organisations" value={totals.orgs} />
        <StatCard label="Total mailboxes" value={totals.users} />
        <StatCard label="Storage used" value={formatBytes(totals.storage)} />
        <StatCard
          label="Suspended"
          value={totals.suspended}
          tone={totals.suspended > 0 ? 'warn' : 'default'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or domain"
          className="w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
          <option value="suspended">Suspended</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Organisation</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Users</th>
                <th className="px-4 py-3 font-medium">Storage</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((o) => {
                const total =
                  o.storageModel === 'pooled'
                    ? (o.pooledStorageBytes ?? 0)
                    : (o.perUserQuotaBytes ?? 0) * o.userCount;
                return (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{o.name}</div>
                      <div className="text-xs text-gray-500">{o.primaryDomain}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{TYPE_LABEL[o.type]}</td>
                    <td className="px-4 py-3">
                      <div className="text-gray-900">{o.planName}</div>
                      <div className="text-xs text-gray-500">
                        {o.storageModel === 'pooled' ? 'Pooled storage' : 'Per-user quota'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {o.userCount}
                      {o.maxUsers !== null && (
                        <span className="text-gray-400"> / {o.maxUsers}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StorageBar used={o.storageUsedBytes} total={total} compact />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={o.status} />
                      {o.trialEndsAt && (
                        <div className="mt-0.5 text-xs text-gray-500">
                          ends {new Date(o.trialEndsAt).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/org?tenant=${o.id}`}
                        className="text-sm font-medium text-brand-700 hover:underline"
                      >
                        Manage
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                    No organisations match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
