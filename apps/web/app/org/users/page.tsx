'use client';

import { useEffect, useMemo, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { Organisation, OrgUser, UserCategory } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatusBadge } from '@/components/admin/StatusBadge';

const NAV = [
  { href: '/org', label: 'Overview' },
  { href: '/org/users', label: 'Users' },
  { href: '/org/categories', label: 'Categories' },
];

const DEMO_TENANT = '22222222-2222-2222-2222-222222222222';
const GB = 1024 ** 3;

export default function OrgUsers() {
  const [org, setOrg] = useState<Organisation | null>(null);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [cats, setCats] = useState<UserCategory[]>([]);
  const [activeCat, setActiveCat] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    adminApi.getOrg(DEMO_TENANT).then(setOrg);
    adminApi.getUsers(DEMO_TENANT).then(setUsers);
    adminApi.getCategories(DEMO_TENANT).then(setCats);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      const matchCat = activeCat === 'all' || u.categoryId === activeCat;
      const matchQ =
        !q || u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
      return matchCat && matchQ;
    });
  }, [users, activeCat, query]);

  const atLimit = org?.maxUsers !== null && org !== null && users.length >= (org.maxUsers ?? 0);

  return (
    <AdminShell
      scope="organisation"
      title="Users"
      subtitle={org ? `${org.name} · ${users.length} people` : undefined}
      nav={NAV}
      actions={
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={atLimit}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          title={atLimit ? 'User limit reached for this plan' : undefined}
        >
          Create user
        </button>
      }
    >
      {atLimit && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          User limit reached ({org?.maxUsers}). Upgrade the plan or remove a user to add more.
        </div>
      )}

      {/* Category filter — the primary way admins navigate a large organisation */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip
          label="All"
          count={users.length}
          active={activeCat === 'all'}
          onClick={() => setActiveCat('all')}
        />
        {cats.map((c) => (
          <FilterChip
            key={c.id}
            label={c.name}
            count={users.filter((u) => u.categoryId === c.id).length}
            colour={c.colour}
            active={activeCat === c.id}
            onClick={() => setActiveCat(c.id)}
          />
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or address"
          className="ml-auto w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Storage</th>
                <th className="px-4 py-3 font-medium">MFA</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((u) => {
                const cat = cats.find((c) => c.id === u.categoryId);
                // Guard the divide. A person with no mailbox has a zero quota,
                // and NaN% renders as a blank bar that looks like a loading
                // state rather than "this user has no mail account".
                const pct = u.quotaBytes > 0
                  ? Math.round((u.usedBytes / u.quotaBytes) * 100)
                  : 0;
                return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{u.displayName}</div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {cat && (
                        <span className="inline-flex items-center gap-1.5 text-gray-700">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: cat.colour }}
                          />
                          {cat.name}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-gray-600">
                      {u.role.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3">
                      {u.mailboxAddress ? (
                        <>
                          <div className="text-gray-700">
                            {formatBytes(u.usedBytes)}
                            <span className="text-gray-400"> / {formatBytes(u.quotaBytes)}</span>
                          </div>
                          <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-gray-200">
                            <div
                              className={`h-full ${pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">No mailbox</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.mfaEnabled ? (
                        <span className="text-green-700">On</span>
                      ) : (
                        <span className="text-gray-400">Off</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.status} />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    No users match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        An organisation admin can create users and reset passwords. They cannot read a user&apos;s
        mail — administrative power over an account never implies access to its contents.
      </p>

      {creating && org && (
        <CreateUserDialog
          org={org}
          categories={cats}
          onClose={() => setCreating(false)}
          onCreate={(u) => {
            setUsers((prev) => [u, ...prev]);
            setCreating(false);
          }}
        />
      )}
    </AdminShell>
  );
}

function FilterChip({
  label,
  count,
  colour,
  active,
  onClick,
}: {
  label: string;
  count: number;
  colour?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
        active
          ? 'border-brand-600 bg-brand-50 font-medium text-brand-800'
          : 'border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      {colour && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colour }} />}
      {label}
      <span className="text-xs text-gray-400">{count}</span>
    </button>
  );
}

/**
 * Creating users one at a time with identical settings is the most tedious
 * part of onboarding an organisation. Picking a category fills in the quota,
 * role, groups and sending policy — that is the whole point of categories.
 */
function CreateUserDialog({
  org,
  categories,
  onClose,
  onCreate,
}: {
  org: Organisation;
  categories: UserCategory[];
  onClose: () => void;
  onCreate: (u: OrgUser) => void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [displayName, setDisplayName] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [quotaGb, setQuotaGb] = useState(
    categories[0]?.defaultQuotaBytes ? Math.round(categories[0].defaultQuotaBytes / GB) : 5,
  );
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');

  const cat = categories.find((c) => c.id === categoryId);

  function pickCategory(id: string) {
    setCategoryId(id);
    const c = categories.find((x) => x.id === id);
    if (c?.defaultQuotaBytes) setQuotaGb(Math.round(c.defaultQuotaBytes / GB));
  }

  function submit() {
    if (!cat) return;
    const address = `${localPart}@${org.primaryDomain}`;
    const products = cat.defaultProducts ?? ['mail'];
    const hasMailbox = products.includes('mail');

    onCreate({
      id: `u-${Date.now()}`,
      email: address,
      displayName,
      mailboxAddress: hasMailbox ? address : null,
      categoryId: cat.id,
      categoryName: cat.name,
      role: cat.defaultRole,
      status: 'pending',
      products,
      quotaBytes: hasMailbox ? quotaGb * GB : 0,
      usedBytes: 0,
      mfaEnabled: false,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  const bulkCount = bulkText.split('\n').filter((l) => l.trim()).length;
  const valid = bulk ? bulkCount > 0 : displayName.trim() && localPart.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h2 className="text-base font-semibold">Create user</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-5 p-5">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-gray-900">Category</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickCategory(c.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    categoryId === c.id
                      ? 'border-brand-600 bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: c.colour }}
                    />
                    {c.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-500">
                    {c.defaultQuotaBytes ? `${formatBytes(c.defaultQuotaBytes)} · ` : ''}
                    {c.defaultRole.replace(/_/g, ' ')}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {cat && (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="mb-1 font-medium text-gray-800">Applied from this category</div>
              <div>Role: {cat.defaultRole.replace(/_/g, ' ')}</div>
              <div>External sending: {cat.canSendExternal ? 'allowed' : 'blocked'}</div>
              {cat.autoGroups && cat.autoGroups.length > 0 && (
                <div>Auto-added to: {cat.autoGroups.join(', ')}</div>
              )}
            </div>
          )}

          <div className="flex gap-2 border-b border-gray-200">
            <button
              type="button"
              onClick={() => setBulk(false)}
              className={`border-b-2 px-3 py-2 text-sm ${!bulk ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-500'}`}
            >
              Single user
            </button>
            <button
              type="button"
              onClick={() => setBulk(true)}
              className={`border-b-2 px-3 py-2 text-sm ${bulk ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-gray-500'}`}
            >
              Bulk
            </button>
          </div>

          {!bulk ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-900">Full name</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Anjali Desai"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-900">
                  Email address
                </span>
                <div className="flex items-center rounded-lg border border-gray-300 focus-within:border-brand-500">
                  <input
                    value={localPart}
                    onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
                    placeholder="a.desai"
                    className="w-full rounded-l-lg border-0 px-3 py-2 text-sm outline-none"
                  />
                  <span className="shrink-0 border-l border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                    @{org.primaryDomain}
                  </span>
                </div>
              </label>
            </>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-900">
                One per line — name, local part
              </span>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={7}
                placeholder={'Anjali Desai, a.desai\nVikram Menon, v.menon'}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
              />
              <span className="mt-1 block text-xs text-gray-500">
                {bulkCount} user{bulkCount === 1 ? '' : 's'} · all get the {cat?.name} defaults. CSV
                import arrives in Phase 3.
              </span>
            </label>
          )}

          {org.storageModel === 'per_user' ? (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-900">
                Storage quota (GB)
              </span>
              <input
                type="number"
                min={1}
                value={quotaGb}
                onChange={(e) => setQuotaGb(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              <span className="mt-1 block text-xs text-gray-500">
                Pre-filled from the category. Override for this user if needed.
              </span>
            </label>
          ) : (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              This organisation uses <strong>pooled storage</strong>, so there is no per-user quota
              to set. Mailboxes draw from the shared allocation.
            </div>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-gray-200 px-5 py-4">
          <button
            type="button"
            onClick={submit}
            disabled={!valid}
            className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {bulk ? `Create ${bulkCount} users` : 'Create user'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <span className="ml-auto text-xs text-gray-400">Wired to the API in Phase 1</span>
        </footer>
      </div>
    </div>
  );
}
