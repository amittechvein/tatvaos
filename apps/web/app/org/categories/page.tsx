'use client';

import { useEffect, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { UserCategory } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';

const NAV = [
  { href: '/org', label: 'Overview' },
  { href: '/org/users', label: 'Users' },
  { href: '/org/categories', label: 'Categories' },
];

const DEMO_TENANT = '22222222-2222-2222-2222-222222222222';

export default function OrgCategories() {
  const [cats, setCats] = useState<UserCategory[]>([]);

  useEffect(() => {
    adminApi.getCategories(DEMO_TENANT).then(setCats);
  }, []);

  return (
    <AdminShell
      scope="organisation"
      title="User categories"
      subtitle="Groups that carry defaults for new users"
      nav={NAV}
      actions={
        <button
          type="button"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New category
        </button>
      }
    >
      <p className="mb-5 max-w-2xl text-sm text-ink-muted">
        A category sets the quota, role, group membership and sending policy applied to every user
        created in it. Creating fifty accounts with identical settings one at a time is the most
        tedious part of onboarding an organisation — this is what removes it.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {cats.map((c) => (
          <div key={c.id} className="rounded-xl border border-line bg-surface p-5">
            <div className="mb-3 flex items-start gap-3">
              <span
                className="mt-1 h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: c.colour }}
              />
              <div className="min-w-0 flex-1">
                <h2 className="font-medium text-ink">{c.name}</h2>
                {c.description && <p className="text-sm text-ink-muted">{c.description}</p>}
              </div>
              <span className="shrink-0 rounded-full bg-canvas px-2.5 py-0.5 text-xs font-medium text-ink">
                {c.userCount} users
              </span>
            </div>

            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Default quota</dt>
                <dd className="text-ink">
                  {c.defaultQuotaBytes ? formatBytes(c.defaultQuotaBytes) : 'Pooled'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Role</dt>
                <dd className="capitalize text-ink">{c.defaultRole.replace(/_/g, ' ')}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Send outside org</dt>
                <dd className={c.canSendExternal ? 'text-ink' : 'font-medium text-warn'}>
                  {c.canSendExternal ? 'Allowed' : 'Blocked'}
                </dd>
              </div>
              {c.autoGroups && c.autoGroups.length > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="shrink-0 text-ink-muted">Auto groups</dt>
                  <dd className="truncate text-right text-ink">{c.autoGroups.join(', ')}</dd>
                </div>
              )}
            </dl>

            {!c.canSendExternal && (
              <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                Members can only email inside the organisation. Common for students — and a useful
                abuse control.
              </p>
            )}
          </div>
        ))}
      </div>
    </AdminShell>
  );
}
