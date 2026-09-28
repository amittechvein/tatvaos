'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { Badge, Button, Card, Empty, Meter, Stat, Table, Td } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import {
  fetchOrgAiUsage, fetchOrgMailboxes, fetchOrgOverview,
  type OrgAiUsage, type OrgMailboxPage, type OrgOverview,
} from '@/lib/adminData';
import { PlanTab } from './PlanTab';

// ============================================================================
//  One organisation, as the operator sees it (Amit, 26 Sept 2026): which
//  domains it registered and whether their DNS passes, every mail ID and its
//  details, its shared mailboxes and who can open them.
//
//  Addresses, names, sizes and dates only — never mail content. Every open of
//  this page and every new mail-ID search is written to the organisation's
//  own audit log; the note at the foot says so, because the operator should
//  know it too.
// ============================================================================

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'domains', label: 'Domains' },
  { key: 'mail', label: 'Mail IDs' },
  { key: 'shared', label: 'Shared mailboxes' },
  { key: 'plan', label: 'Plan & features' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const PERMISSION_LABEL: Record<string, string> = {
  read: 'Read', send_as: 'Send as', send_on_behalf: 'Send on behalf', full: 'Full access',
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function OrganisationDetail() {
  const { authedFetch } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<TabKey>('overview');
  const [data, setData] = useState<OrgOverview | null>(null);
  const [ai, setAi] = useState<OrgAiUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrgOverview(authedFetch, id).then(setData).catch((e: Error) => setError(e.message));
    // AI usage is a separate endpoint and a separate failure: a metering
    // problem must not blank the rest of the page.
    fetchOrgAiUsage(authedFetch, id).then(setAi).catch(() => setAi(null));
  }, [authedFetch, id]);

  return (
    <AdminShell
      scope="platform"
      title={data?.org.name ?? 'Organisation'}
      subtitle={data ? `Customer since ${fmtDate(data.org.createdAt)}` : undefined}
      actions={
        <Link href="/admin/organisations">
          <Button variant="secondary">All organisations</Button>
        </Link>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <Empty title="Loading…" />}

      {data && (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <StatusBadge status={data.org.status} />
            {data.org.status === 'trial' && data.org.trialEndsAt && (
              <span className="text-[13px] text-ink-muted">Trial ends {fmtDate(data.org.trialEndsAt)}</span>
            )}
          </div>

          <div role="tablist" className="mb-5 flex flex-wrap gap-1 border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-4 py-2 text-[13px]
                  ${tab === t.key
                    ? 'border-brand-500 font-semibold text-brand-700'
                    : 'border-transparent text-ink-muted hover:text-ink'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <Overview data={data} ai={ai} />}
          {tab === 'domains' && <Domains data={data} />}
          {tab === 'mail' && <MailIds orgId={id} />}
          {tab === 'shared' && <Shared data={data} />}
          {tab === 'plan' && <PlanTab orgId={id} />}

          <p className="mt-6 text-[12px] text-ink-muted">
            This page shows addresses, names, sizes and dates, never mail content. Opening it,
            and each new mail-ID search, is recorded in this organisation&rsquo;s own audit log.
          </p>
        </>
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------

function Overview({ data, ai }: { data: OrgOverview; ai: OrgAiUsage | null }) {
  const c = data.counts;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="People" value={String(c.users)}
              caption={`${c.activeUsers} active · ${c.suspendedUsers} suspended`} />
        <Stat label="Mail IDs" value={String(c.personalMailboxes + c.sharedMailboxes + c.groupMailboxes)}
              caption={`${c.personalMailboxes} personal · ${c.sharedMailboxes} shared · ${c.groupMailboxes} group`}
              tone="info" />
        <Stat label="Domains" value={String(c.domains)}
              caption={`${c.verifiedDomains} verified`} tone="success" />
        <Stat label="Mail storage used" value={formatBytes(c.mailUsedBytes)}
              caption={`${c.aliases} aliases · ${c.inactiveMailboxes} inactive mail IDs`} tone="warning" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Sign-in and security">
          <Rows rows={[
            ['Signed in within 30 days', `${c.signedInLast30Days} of ${c.users}`],
            ['Never signed in', String(c.neverSignedIn)],
            ['Administrators', String(c.admins)],
            ['Two-step sign-in on', `${c.twoStepOn} of ${c.users}`],
          ]} />
        </Card>
        <Card title="Integrations" subtitle="Counts only; keys are never shown here">
          <Rows rows={[
            ['Organisation API keys', String(c.orgApiKeys)],
            ['Mail send API keys', String(c.mailApiKeys)],
            ['Single sign-on apps', String(c.ssoApps)],
          ]} />
        </Card>
      </div>

      <Card title="AI this month">
        {!ai ? (
          <p className="text-[13px] text-ink-muted">AI usage could not be read.</p>
        ) : (
          <>
            <Rows rows={[
              ['Tokens used', ai.tokens.toLocaleString('en-IN')],
              ['Requests', `${ai.requests.toLocaleString('en-IN')} (${ai.refused} refused)`],
              ['Monthly ceiling', ai.ceilingTokens === null ? 'No limit' : ai.ceilingTokens.toLocaleString('en-IN')],
              ['Paused', ai.paused ? 'Yes' : 'No'],
            ]} />
            {ai.ceilingTokens ? (
              <div className="mt-3"><Meter used={ai.tokens} total={ai.ceilingTokens} /></div>
            ) : null}
            {ai.byFeature.length > 0 && (
              <div className="mt-4">
                <Table head={['Feature', 'Requests', 'Tokens']}>
                  {ai.byFeature.map((f) => (
                    <tr key={f.feature}>
                      <Td>{f.feature}</Td>
                      <Td>{f.requests.toLocaleString('en-IN')}</Td>
                      <Td>{f.tokens.toLocaleString('en-IN')}</Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-line text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-2">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <Badge tone={ok ? 'ok' : 'danger'}>{ok ? '✓' : '✗'} {label}</Badge>;
}

function Domains({ data }: { data: OrgOverview }) {
  if (data.domains.length === 0) return <Card><Empty title="No domains registered" /></Card>;
  return (
    <Card padded={false}>
      <Table head={['Domain', 'Status', 'DNS', 'Mail IDs', 'Last checked']}>
        {data.domains.map((d) => (
          <tr key={d.id}>
            <Td>
              <div className="font-semibold text-ink">{d.fqdn}</div>
              <div className="text-[12px] capitalize text-ink-muted">
                {d.isPlatform ? 'Platform address' : d.type}
                {d.verificationMethod ? ` · proven by ${d.verificationMethod}` : ''}
              </div>
            </Td>
            <Td>
              {d.ownershipVerifiedAt
                ? <Badge tone={d.isActive ? 'ok' : 'warn'}>{d.isActive ? 'Verified' : 'Verified, inactive'}</Badge>
                : <Badge tone="warn">Not verified</Badge>}
            </Td>
            <Td>
              {d.checks ? (
                <div className="flex flex-wrap gap-1">
                  <Check ok={d.checks.mx} label="MX" />
                  <Check ok={d.checks.spf} label="SPF" />
                  <Check ok={d.checks.dkim} label="DKIM" />
                  <Check ok={d.checks.dmarc} label="DMARC" />
                </div>
              ) : <span className="text-[12px] text-ink-muted">Managed by us</span>}
            </Td>
            <Td>{d.mailboxCount}</Td>
            <Td>
              <div className="text-[12px]">{fmtDate(d.lastCheckedAt)}</div>
              {d.lastCheckResult && (
                <div className="max-w-xs truncate text-[12px] text-ink-muted" title={d.lastCheckResult}>
                  {d.lastCheckResult}
                </div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const PAGE = 50;

function MailIds({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<OrgMailboxPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A search is sent when typing pauses, not on every key: each new search is
  // an audited read, and "a", "ad", "adm" are not three things the operator
  // meant to look at.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setOffset(0); }, 400);
    return () => clearTimeout(t);
  }, [typed]);

  const load = useCallback(() => {
    setError(null);
    fetchOrgMailboxes(authedFetch, orgId, { q, type, status, offset, limit: PAGE })
      .then(setPage)
      .catch((e: Error) => setError(e.message));
  }, [authedFetch, orgId, q, type, status, offset]);

  useEffect(() => { load(); }, [load]);

  const select = 'rounded-card border border-line bg-surface px-3 py-2 text-[13px]';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search address or name"
          className="w-full max-w-xs rounded-card border border-line bg-surface px-4 py-2 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-400"
        />
        <select aria-label="Type" className={select} value={type}
                onChange={(e) => { setType(e.target.value); setOffset(0); }}>
          <option value="">All types</option>
          <option value="user">Personal</option>
          <option value="shared">Shared</option>
          <option value="group">Group</option>
        </select>
        <select aria-label="Status" className={select} value={status}
                onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">Active and inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {page && (
          <span className="ml-auto text-[13px] text-ink-muted">
            {page.total} {page.total === 1 ? 'mail ID' : 'mail IDs'}
          </span>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <Card padded={false}>
        {!page ? <Empty title="Loading…" /> : page.items.length === 0 ? (
          <Empty title="No mail IDs match" />
        ) : (
          <Table head={['Mail ID', 'Type', 'Storage', 'Last sign-in', 'Created']}>
            {page.items.map((m) => (
              <tr key={m.id}>
                <Td>
                  <div className="font-semibold text-ink">{m.address}</div>
                  <div className="text-[12px] text-ink-muted">
                    {m.name ?? '—'}
                    {m.person?.role === 'org_admin' ? ' · administrator' : ''}
                  </div>
                  {m.aliases.length > 0 && (
                    <div className="text-[12px] text-ink-faint">Also: {m.aliases.join(', ')}</div>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone="neutral">{m.type === 'user' ? 'Personal' : m.type === 'shared' ? 'Shared' : 'Group'}</Badge>
                    {!m.isActive && <Badge tone="danger">Inactive</Badge>}
                    {m.retained && <Badge tone="warn">Person deleted, mail kept</Badge>}
                    {m.person && m.person.status !== 'active' && <Badge tone="warn"><span className="capitalize">{m.person.status}</span></Badge>}
                    {m.person?.mfaEnabled && <Badge tone="ok">Two-step</Badge>}
                  </div>
                </Td>
                <Td>
                  <div className="text-[12px]">
                    {formatBytes(m.usedBytes)}<span className="text-ink-faint"> / {formatBytes(m.quotaBytes)}</span>
                  </div>
                  <div className="mt-1.5 w-28"><Meter used={m.usedBytes} total={m.quotaBytes} /></div>
                </Td>
                <Td>{m.person ? (m.person.lastLoginAt ? fmtDate(m.person.lastLoginAt) : 'Never') : '—'}</Td>
                <Td>{fmtDate(m.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {page && page.total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-[13px]">
          <span className="text-ink-muted">
            {page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} of {page.total}
          </span>
          <Button variant="secondary" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
          <Button variant="secondary" disabled={offset + PAGE >= page.total}
                  onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Shared({ data }: { data: OrgOverview }) {
  if (data.sharedMailboxes.length === 0) return <Card><Empty title="No shared mailboxes" /></Card>;
  return (
    <Card padded={false}>
      <Table head={['Shared mailbox', 'Who can open it', 'Storage', 'Created']}>
        {data.sharedMailboxes.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="font-semibold text-ink">{s.address}</div>
              <div className="text-[12px] text-ink-muted">{s.displayName ?? '—'}</div>
              {!s.isActive && <div className="mt-1"><Badge tone="danger">Inactive</Badge></div>}
            </Td>
            <Td>
              {s.access.length === 0 ? (
                // A queue nobody can open is mail arriving in a room with no door.
                <Badge tone="warn">Nobody has access</Badge>
              ) : (
                <ul className="space-y-0.5 text-[12px]">
                  {s.access.map((a) => (
                    <li key={`${a.email}-${a.permission}`}>
                      <span className="font-medium text-ink">{a.name}</span>
                      <span className="text-ink-muted"> · {PERMISSION_LABEL[a.permission] ?? a.permission}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Td>
            <Td>
              <div className="text-[12px]">
                {formatBytes(s.usedBytes)}<span className="text-ink-faint"> / {formatBytes(s.quotaBytes)}</span>
              </div>
            </Td>
            <Td>{fmtDate(s.createdAt)}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
