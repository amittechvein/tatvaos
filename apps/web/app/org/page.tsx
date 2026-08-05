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
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Meter, Stat } from '@/components/ui/Kit';
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
        <Box sx={{ display: 'grid', placeItems: 'center', py: 10 }}><CircularProgress /></Box>
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
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            Finish setting up
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {remaining.length} step{remaining.length === 1 ? '' : 's'} left before
            your organisation is fully live.
          </Typography>

          <Box sx={{ display: 'grid', gap: 1 }}>
            {steps.map((st) => (
              <Box key={st.label} component={st.done ? 'div' : Link}
                   {...(st.done ? {} : { href: st.href })}
                   sx={{
                     display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25,
                     borderRadius: 1.5, textDecoration: 'none', color: 'inherit',
                     bgcolor: (t) => st.done ? 'transparent' : alpha(t.palette.primary.main, 0.05),
                     '&:hover': st.done ? {} : { bgcolor: (t) => alpha(t.palette.primary.main, 0.1) },
                   }}>
                <Box sx={{
                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                  display: 'grid', placeItems: 'center',
                  bgcolor: st.done ? 'success.main' : 'transparent',
                  border: st.done ? 'none' : '1.5px solid',
                  borderColor: 'divider',
                }}>
                  {st.done && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff"
                         strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </Box>
                <Typography variant="body2"
                            sx={{ color: st.done ? 'text.disabled' : 'text.primary',
                                  textDecoration: st.done ? 'line-through' : 'none' }}>
                  {st.label}
                </Typography>
              </Box>
            ))}
          </Box>
        </Card>
      )}

      <Box sx={{ display: 'grid', gap: 2, mb: 3,
                 gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' } }}>
        <Stat label="People" value={String(s?.userCount ?? 0)}
              caption={s?.maxUsers == null ? 'Unlimited' : `of ${s.maxUsers} allowed`} />
        <Stat label="Departments" value={String(flat.length)} />
        <Stat label="Domains" value={String(domains.length)}
              caption={`${verified.length} verified`} />
        <Stat label="Storage used" value={fmt(s?.usedBytes ?? 0)}
              caption={`of ${fmt(s?.totalBytes ?? 0)}`} />
      </Box>

      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Card title="Storage"
              subtitle={s?.storageModel === 'pooled'
                ? 'Pooled — one allocation shared across every mailbox'
                : 'Per user — each mailbox has its own fixed allowance'}>
          <Meter used={s?.usedBytes ?? 0} total={s?.totalBytes ?? 1} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            {fmt(s?.availableBytes ?? 0)} still available.
            {s?.storageModel === 'pooled' &&
              ' When a pool fills, every mailbox stops receiving at once — not just the heaviest one.'}
          </Typography>
        </Card>

        <Card title="People by department"
              actions={<Button variant="ghost" href="/org/departments">Manage</Button>}>
          {flat.length === 0 ? (
            <Typography variant="body2" color="text.disabled">
              No departments yet. They carry storage and permissions down to
              everyone inside, so creating them first saves setting the same
              thing on every person.
            </Typography>
          ) : (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {flat.map((d) => (
                <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%',
                             bgcolor: d.colour, flexShrink: 0 }} />
                  <Typography variant="body2" sx={{ flex: 1 }}>{d.name}</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{d.userCount}</Typography>
                </Box>
              ))}
              {(data?.unassignedUsers ?? 0) > 0 && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, pt: 1,
                           borderTop: '1px solid', borderColor: 'divider' }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%',
                             bgcolor: 'text.disabled', flexShrink: 0 }} />
                  <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                    No department
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {data?.unassignedUsers}
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </Card>
      </Box>

      {verified.length > 0 && mailReady.length === 0 && (
        <Alert severity="info" sx={{ mt: 3 }}>
          Your domain is verified, but mail is still delivered wherever it was
          before. Add the MX records under <Link href="/org/domains">Domains</Link> when
          you are ready to move it — nothing you do here interrupts your current
          email until those change.
        </Alert>
      )}
    </AdminShell>
  );
}
