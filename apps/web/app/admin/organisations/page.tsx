'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { formatBytes } from '@tatvaos/core';
import { fetchOrganisations, fetchPlans, type OrgRow, type PlanRow } from '@/lib/adminData';
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
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState<OrgRow | null>(null);

  const load = useCallback(() => {
    fetchOrganisations(authedFetch)
      .then(setOrgs)
      .catch(() => setOrgs([]))
      .finally(() => setLoading(false));
  }, [authedFetch]);

  useEffect(() => {
    load();
    fetchPlans(authedFetch).then(setPlans).catch(() => setPlans([]));
  }, [authedFetch, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orgs.filter((o) => {
      const matchQ = !q
        || o.name.toLowerCase().includes(q)
        || o.primaryDomain.toLowerCase().includes(q)
        || (o.adminEmail ?? '').toLowerCase().includes(q);
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
          <Table head={['Organisation', 'Owner', 'Plan', 'People', 'Storage', 'Status', '']}>
            {filtered.map((o) => {
              const cap = o.storageTotalBytes;
              const hasDomain = o.primaryDomain && o.primaryDomain !== '—';
              const initial = (o.name || '?').charAt(0).toUpperCase();

              return (
                <tr key={o.id} className="hover:bg-canvas">
                  {/* Organisation: an avatar tile + name + real domain (never a
                      stray em-dash for orgs that have not added one yet). */}
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-brand-500 text-[13px] font-bold text-white">
                        {initial}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-ink">{o.name}</div>
                        <div className="truncate text-[12px] text-ink-muted">
                          {hasDomain ? o.primaryDomain : `${TYPE_LABEL[o.type] ?? o.type}`}
                        </div>
                      </div>
                    </div>
                  </Td>
                  {/* Owner: WHO runs this org — the thing that was missing. */}
                  <Td>
                    {o.adminName || o.adminEmail ? (
                      <div className="min-w-0">
                        {o.adminName && <div className="truncate font-medium text-ink">{o.adminName}</div>}
                        <div className="truncate text-[12px] text-ink-muted">{o.adminEmail ?? '—'}</div>
                      </div>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="font-medium">{o.planName ?? <span className="text-ink-faint">No plan</span>}</div>
                    {o.seats ? <div className="text-[12px] text-ink-muted">{o.seats} seats</div> : null}
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
                  <Td>
                    <div className="flex justify-end">
                      <Button variant="secondary" onClick={() => setChanging(o)}>Manage</Button>
                    </div>
                  </Td>
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

      {changing && (
        <ChangePlan org={changing} plans={plans}
                    onClose={() => setChanging(null)}
                    onChanged={() => { setChanging(null); load(); }} />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------

function ChangePlan({ org, plans, onClose, onChanged }: {
  org: OrgRow;
  plans: PlanRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authedFetch } = useAuth();
  const [planId, setPlanId] = useState(org.planId ?? '');
  const [seats, setSeats] = useState(org.seats && org.seats > 0 ? String(org.seats) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identity + owner contact — the "edit all the things" fields.
  const [name, setName] = useState(org.name);
  const [type, setType] = useState(org.type);
  const [adminName, setAdminName] = useState(org.adminName ?? '');
  const [adminEmail, setAdminEmail] = useState(org.adminEmail ?? '');
  const [phone, setPhone] = useState(org.phone ?? '');
  const [gstin, setGstin] = useState(org.gstin ?? '');

  const chosen = plans.find((p) => p.id === planId);
  const onTrial = org.status === 'trial';
  const suspended = org.status === 'suspended';
  const active = org.status === 'active';

  async function post(path: string, method: string, ok: () => void) {
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(`/admin/organisations/${org.id}${path}`, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'That did not work.');
      ok();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
      setBusy(false);
    }
  }

  // The plan PUT carries a body, so it can't share the bare-POST helper above.
  async function changePlan() {
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(`/admin/organisations/${org.id}/plan`, {
        method: 'PUT',
        body: JSON.stringify({ planId, seats: seats.trim() === '' ? null : Number(seats) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not change the plan.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the plan.');
      setBusy(false);
    }
  }

  async function saveDetails() {
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(`/admin/organisations/${org.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, type, adminName, adminEmail, phone, gstin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save the details.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the details.');
      setBusy(false);
    }
  }

  const detailsDirty =
    name.trim() !== org.name || type !== org.type ||
    adminName !== (org.adminName ?? '') || adminEmail !== (org.adminEmail ?? '') ||
    phone !== (org.phone ?? '') || gstin !== (org.gstin ?? '');

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        Manage — {org.name}
        <Typography variant="body2" color="text.secondary">
          {org.planName ?? 'No plan'}
          {' · '}
          <Box component="span" sx={{ textTransform: 'capitalize' }}>{org.status}</Box>
        </Typography>
      </DialogTitle>

      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2.5 }}>{error}</Alert>}

        {/* ---- Details: name, type, owner ---------------------------- */}
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 1.5 }}>Details</Typography>
        <TextField fullWidth label="Organisation name" value={name} sx={{ mb: 2 }}
                   onChange={(e) => setName(e.target.value)} />
        <TextField select fullWidth label="Type" value={type} sx={{ mb: 2 }}
                   onChange={(e) => setType(e.target.value)}>
          {Object.entries(TYPE_LABEL).map(([v, label]) => (
            <MenuItem key={v} value={v}>{label}</MenuItem>
          ))}
        </TextField>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, mb: 2 }}>
          <TextField fullWidth label="Owner name" value={adminName}
                     onChange={(e) => setAdminName(e.target.value)} />
          <TextField fullWidth label="Owner email" value={adminEmail}
                     onChange={(e) => setAdminEmail(e.target.value)} />
          <TextField fullWidth label="Phone" value={phone}
                     onChange={(e) => setPhone(e.target.value)} />
          <TextField fullWidth label="GSTIN" value={gstin}
                     onChange={(e) => setGstin(e.target.value)} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          The owner contact is who this organisation is billed to and called
          about — editing it here does not change any user&apos;s sign-in.
        </Typography>
        <Box sx={{ mt: 1.5 }}>
          <Button variant="primary" onClick={saveDetails} disabled={busy || !detailsDirty || name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save details'}
          </Button>
        </Box>

        <Box sx={{ my: 3, borderTop: '1px solid', borderColor: 'divider' }} />

        {/* ---- Lifecycle: the "still trial" fix ----------------------- */}
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>Status</Typography>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
          {(onTrial || suspended) && (
            <Button variant="primary" disabled={busy}
                    onClick={() => post('/activate', 'POST', onChanged)}>
              {onTrial ? 'End trial — activate' : 'Reactivate'}
            </Button>
          )}
          {active && (
            <Button variant="ghost" disabled={busy}
                    onClick={() => post('/suspend', 'POST', onChanged)}>
              Suspend
            </Button>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {onTrial && 'Activating ends the trial and marks the organisation a paying customer. It keeps signing in and receiving mail throughout.'}
          {active && 'Suspending stops sign-in and mail delivery immediately. Nothing is deleted — data is retained for the grace period.'}
          {suspended && 'Reactivating restores sign-in and delivery.'}
        </Typography>

        <Box sx={{ my: 3, borderTop: '1px solid', borderColor: 'divider' }} />

        {/* ---- Plan --------------------------------------------------- */}
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 1.5 }}>Plan</Typography>
        <TextField select fullWidth label="Plan" value={planId} sx={{ mb: 2.5 }}
                   onChange={(e) => setPlanId(e.target.value)}>
          {plans.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
              {p.maxUsers ? ` — up to ${p.maxUsers} people` : ' — unlimited people'}
              {p.pricePerUserMonthly ? `, ₹${p.pricePerUserMonthly}/user/mo`
                : p.priceMonthly ? `, ₹${p.priceMonthly}/mo` : ''}
            </MenuItem>
          ))}
        </TextField>

        <TextField fullWidth label="Seats (optional)" value={seats}
                   onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))}
                   helperText={chosen?.maxUsers
                     ? `Billable seats. Leave empty to keep the current value; the plan caps people at ${chosen.maxUsers}.`
                     : 'Billable seats. Leave empty to keep the current value.'} />

        <Alert severity="info" sx={{ mt: 2.5 }}>
          The new plan&apos;s seat and domain limits apply immediately to new
          growth. Storage already provisioned is untouched — shrinking a live
          organisation&apos;s storage is a separate, deliberate action.
        </Alert>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={changePlan}
                disabled={busy || !planId || planId === org.planId}>
          {busy ? 'Saving…' : 'Change plan'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
