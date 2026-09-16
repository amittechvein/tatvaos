'use client';

// ============================================================================
//  TatvaOS Core — the organisation console
// ============================================================================
//
//  This is the customer's equivalent of admin.google.com, and it belongs to
//  Core rather than to Mail. Everything on this screen — people, departments,
//  domains, storage, billing — outlives any single product. When Drive and
//  Payroll ship they appear here without this page changing shape, which is
//  the whole reason identity and storage were put in Core in the first place.
//
//  It reads live data. The previous version rendered a mock school with 284
//  fictional students, which on staging read as either a broken product or
//  somebody else's data — and both readings are worse than an empty state.
// ============================================================================

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Meter, Stat } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

const GB = 1024 ** 3;

interface DeptNode {
  id: string; name: string; colour: string;
  userCount: number; descendantUserCount: number;
  children: DeptNode[];
}

interface Overview {
  tree: DeptNode[];
  unassignedUsers: number;
  storage: {
    storageModel: string;
    totalBytes: number; usedBytes: number; availableBytes: number;
    userCount: number; maxUsers: number | null;
  };
}

interface DomainRow {
  id: string; fqdn: string; isPlatform: boolean;
  ownershipVerified: boolean;
  /** Non-null once our MX records are actually live in DNS. */
  mxVerifiedAt: string | null;
}

function fmt(b: number): string {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)} TB`;
  if (b >= GB) return `${Math.round(b / GB)} GB`;
  return `${Math.round(b / 1024 ** 2)} MB`;
}

export default function CoreOverview() {
  const { authedFetch, user } = useAuth();

  const [data, setData] = useState<Overview | null>(null);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [d, dom] = await Promise.all([
      authedFetch('/org/departments'),
      authedFetch('/org/domains'),
    ]);
    if (d.ok) setData(await d.json());
    if (dom.ok) setDomains(await dom.json());
    setLoading(false);
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <AdminShell scope="organisation" title="TatvaOS Core">
        <div className="grid place-items-center py-12">
          <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
        </div>
      </AdminShell>
    );
  }

  const s = data?.storage;
  const verified = domains.filter((d) => d.ownershipVerified);
  const mailReady = domains.filter((d) => d.mxVerifiedAt !== null);

  // Flatten for the breakdown — a top-level-only list hides the people who are
  // actually in sub-departments, which is where most of an org ends up.
  const flat: DeptNode[] = [];
  const walk = (n: DeptNode[]) => n.forEach((d) => { flat.push(d); walk(d.children); });
  walk(data?.tree ?? []);

  // Ordered by what blocks what. Verifying a domain before anyone is invited
  // is the difference between a working mailbox and one that silently drops
  // every incoming message.
  const steps = [
    { done: verified.length > 0, label: 'Verify a domain you own', href: '/org/domains' },
    { done: flat.length > 0, label: 'Create your departments', href: '/org/departments' },
    { done: (s?.userCount ?? 0) > 1, label: 'Add your people', href: '/org/users' },
    { done: mailReady.length > 0, label: 'Point mail at TatvaOS (MX records)', href: '/org/domains' },
  ];
  const remaining = steps.filter((x) => !x.done);

  return (
    <AdminShell
      scope="organisation"
      title="TatvaOS Core"
      subtitle={`Signed in as ${user?.email ?? ''}`}
      actions={<Button variant="primary" href="/org/users">Add a person</Button>}
    >
      {remaining.length > 0 && (
        <Card className="mb-6">
          <h6 className="mb-1 font-semibold">Finish setting up</h6>
          <p className="mb-4 text-[0.8125rem] text-ink-muted">
            {remaining.length} step{remaining.length === 1 ? '' : 's'} left before
            your organisation is fully live.
          </p>

          <div className="grid gap-2">
            {steps.map((st) => {
              const row = (
                <>
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                    st.done ? 'bg-ok' : 'border-[1.5px] border-line'
                  }`}>
                    {st.done && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff"
                           strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className={st.done ? 'text-ink-faint line-through' : 'text-ink'}>
                    {st.label}
                  </span>
                </>
              );
              const cls = 'flex items-center gap-4 rounded-lg p-2.5 text-sm no-underline';
              // A finished step is not a link: there is nothing left to do there,
              // and making it clickable invites a pointless trip.
              return st.done
                ? <div key={st.label} className={cls}>{row}</div>
                : (
                  <Link key={st.label} href={st.href}
                        className={`${cls} bg-brand-50 transition hover:bg-brand-100`}>
                    {row}
                  </Link>
                );
            })}
          </div>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="People" value={String(s?.userCount ?? 0)}
              caption={s?.maxUsers == null ? 'Unlimited' : `of ${s.maxUsers} allowed`} />
        <Stat label="Departments" value={String(flat.length)} />
        <Stat label="Domains" value={String(domains.length)}
              caption={`${verified.length} verified`} />
        <Stat label="Storage used" value={fmt(s?.usedBytes ?? 0)}
              caption={`of ${fmt(s?.totalBytes ?? 0)}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Storage"
              subtitle={s?.storageModel === 'pooled'
                ? 'Pooled — one allocation shared across every mailbox'
                : 'Per user — each mailbox has its own fixed allowance'}>
          <Meter used={s?.usedBytes ?? 0} total={s?.totalBytes ?? 1} />
          <p className="mt-4 text-[0.75rem] text-ink-muted">
            {fmt(s?.availableBytes ?? 0)} still available.
            {s?.storageModel === 'pooled' &&
              ' When a pool fills, every mailbox stops receiving at once — not just the heaviest one.'}
          </p>
        </Card>

        <Card title="People by department"
              actions={<Button variant="ghost" href="/org/departments">Manage</Button>}>
          {flat.length === 0 ? (
            <p className="text-[0.8125rem] text-ink-muted mb-0">
              No departments yet. They carry storage and permissions down to
              everyone inside, so creating them first saves setting the same
              thing on every person.
            </p>
          ) : (
            <div className="grid gap-4">
              {flat.map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <span className="shrink-0 rounded-full" style={{ width: 10, height: 10, background: d.colour }} />
                  <span className="flex-auto text-[0.8125rem]">{d.name}</span>
                  <span className="font-semibold text-[0.8125rem]">{d.userCount}</span>
                </div>
              ))}
              {(data?.unassignedUsers ?? 0) > 0 && (
                <div className="flex items-center gap-2 border-t border-line pt-2">
                  <span className="shrink-0 rounded-full" style={{ width: 10, height: 10, background: 'rgb(var(--ink-faint))' }} />
                  <span className="flex-auto text-[0.8125rem] text-ink-muted">No department</span>
                  <span className="font-semibold text-[0.8125rem]">{data?.unassignedUsers}</span>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {verified.length > 0 && mailReady.length === 0 && (
        <Alert tone="info" className="mt-6">
          Your domain is verified, but mail is still delivered wherever it was
          before. Add the MX records under <Link href="/org/domains">Domains</Link> when
          you are ready to move it — nothing you do here interrupts your current
          email until those change.
        </Alert>
      )}
    </AdminShell>
  );
}
