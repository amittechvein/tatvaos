'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import { fetchOrganisations, fetchPlans, type OrgRow, type PlanRow } from '@/lib/adminData';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { Button, Card, Empty, Meter, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

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
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-card border px-4 py-1.5 text-[13px] capitalize transition
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
          className="ml-auto w-full max-w-xs rounded-card border border-line bg-surface px-4 py-2 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-400"
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
                        <Link href={`/admin/organisations/${o.id}`} className="block truncate font-semibold text-ink hover:text-brand-700 hover:underline">{o.name}</Link>
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
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" href={`/admin/organisations/${o.id}`}>Details</Button>
                      <Button variant="secondary" onClick={() => setChanging(o)}>Manage</Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="mt-4 text-[12px] text-ink-muted">
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
    <Modal
      title={`Manage — ${org.name}`}
      subtitle={<>{org.planName ?? 'No plan'} · <span className="capitalize">{org.status}</span></>}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={changePlan}
                  disabled={busy || !planId || planId === org.planId}>
            {busy ? 'Saving…' : 'Change plan'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {/* ---- Details: name, type, owner ---------------------------- */}
      <h6 className="font-semibold mb-4">Details</h6>

      <Field label="Organisation name">
        <Input  value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Type">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(TYPE_LABEL).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Field label="Owner name">
            <Input  value={adminName}
                   onChange={(e) => setAdminName(e.target.value)} />
          </Field>
        </div>
        <div>
          <Field label="Owner email">
            <Input  value={adminEmail}
                   onChange={(e) => setAdminEmail(e.target.value)} />
          </Field>
        </div>
        <div>
          <Field label="Phone">
            <Input  value={phone}
                   onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div>
          <Field label="GSTIN">
            <Input  value={gstin}
                   onChange={(e) => setGstin(e.target.value)} />
          </Field>
        </div>
      </div>

      <p className="text-[0.75rem] text-ink-muted">
        The owner contact is who this organisation is billed to and called
        about — editing it here does not change any user&apos;s sign-in.
      </p>

      <div className="mt-2">
        <Button variant="primary" onClick={saveDetails}
                disabled={busy || !detailsDirty || name.trim().length < 2}>
          {busy ? 'Saving…' : 'Save details'}
        </Button>
      </div>

      <hr className="my-6" />

      {/* ---- Lifecycle: the "still trial" fix ----------------------- */}
      <h6 className="font-semibold mb-2">Status</h6>
      <div className="flex flex-wrap gap-2 mb-2">
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
      </div>
      <p className="text-[0.75rem] text-ink-muted">
        {onTrial && 'Activating ends the trial and marks the organisation a paying customer. It keeps signing in and receiving mail throughout.'}
        {active && 'Suspending stops sign-in and mail delivery immediately. Nothing is deleted — data is retained for the grace period.'}
        {suspended && 'Reactivating restores sign-in and delivery.'}
      </p>

      <hr className="my-6" />

      {/* ---- Plan --------------------------------------------------- */}
      <h6 className="font-semibold mb-4">Plan</h6>

      <Field label="Plan">
        <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.maxUsers ? ` — up to ${p.maxUsers} people` : ' — unlimited people'}
              {p.pricePerUserMonthly ? `, ₹${p.pricePerUserMonthly}/user/mo`
                : p.priceMonthly ? `, ₹${p.priceMonthly}/mo` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Seats (optional)"
        hint={chosen?.maxUsers
          ? `Billable seats. Leave empty to keep the current value; the plan caps people at ${chosen.maxUsers}.`
          : 'Billable seats. Leave empty to keep the current value.'}
      >
        <Input  value={seats}
               onChange={(e) => setSeats(e.target.value.replace(/\D/g, ''))} />
      </Field>

      <Alert tone="info" className="mb-0">
        The new plan&apos;s seat and domain limits apply immediately to new
        growth. Storage already provisioned is untouched — shrinking a live
        organisation&apos;s storage is a separate, deliberate action.
      </Alert>

      <hr className="my-6" />

      <InvitationCaps orgId={org.id} />

      <hr className="my-6" />

      <AiUsageSection orgId={org.id} />
      <AiCreditsSection orgId={org.id} />
      <MailAiOfferSection orgId={org.id} />

      <hr className="my-6" />

      <DocsSwitch orgId={org.id} />

      <hr className="my-6" />

      <ProductSwitch orgId={org.id} product="sheets" name="Sheets"
        blurb="Collaborative spreadsheets, stored in Space. Separate from Docs: either can be on without the other. Off until you turn it on. Only you can change this; the organisation cannot. Turning it off closes open spreadsheets within a minute; nothing is deleted." />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
//  Connect: how many people this organisation may invite to a meeting by email.
//
//  Amit, 19 Sept 2026 — a 300-person meeting met "Invite at most 50 people at a
//  time". The caps are now per organisation, and the dial is HERE ONLY: they are
//  the one guard on outbound invitation mail, so the organisation's own console
//  has no such field. Empty means "the platform default", stored as null, so a
//  later change to the default reaches everyone never given their own number.
//
//  Its own section with its own Save, like Details: the modal's footer button is
//  the plan's. The defaults and the ceiling come from the API's answer rather
//  than being typed here a second time.
// ---------------------------------------------------------------------------
type CapsAnswer = {
  perRequest: number | null;
  perMeeting: number | null;
  effectivePerRequest: number;
  effectivePerMeeting: number;
  defaultPerRequest: number;
  defaultPerMeeting: number;
  ceiling: number;
};

/**
 * TatvaOS Docs, on or off for this organisation. Off by default; only the
 * platform operator turns it on (DocsAdminEndpoints), and every change is
 * audited. Turning it on also means this organisation's documents may go to
 * the AI provider when its AI switch is on.
 */
function DocsSwitch({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/admin/organisations/${orgId}/docs`;

  useEffect(() => {
    let gone = false;
    authedFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Could not load the Docs setting.');
        if (!gone) setEnabled(Boolean(body.enabled));
      })
      .catch((e) => { if (!gone) setError(e instanceof Error ? e.message : 'Could not load the Docs setting.'); });
    return () => { gone = true; };
  }, [authedFetch, path]);

  async function flip() {
    if (enabled === null) return;
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not change the Docs setting.');
      setEnabled(Boolean(body.enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the Docs setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h6 className="font-semibold mb-2">Docs</h6>
      <p className="text-[0.75rem] text-ink-muted mb-4">
        Collaborative documents, stored in Space. Off until you turn it on. Only you can change this;
        the organisation cannot. Turning it off closes open documents within a minute; nothing is deleted.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex items-center justify-between">
        <span className="text-sm">
          {enabled === null ? 'Loading…' : enabled ? 'On for this organisation' : 'Off for this organisation'}
        </span>
        <Button variant={enabled ? 'secondary' : 'primary'} onClick={flip} disabled={busy || enabled === null}>
          {busy ? 'Saving…' : enabled ? 'Turn Docs off' : 'Turn Docs on'}
        </Button>
      </div>
    </>
  );
}

/**
 * This organisation's AI use this month — the same summary its own TatvaOS AI
 * page shows (AiUsageReport). The limits are platform settings, so this is
 * read-only; change them on the Settings page.
 */
function AiUsageSection({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [u, setU] = useState<{
    tokens: number; requests: number; refused: number; ceilingTokens: number | null; percentOfCeiling: number;
    byFeature: { feature: string; requests: number; tokens: number }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    authedFetch(`/admin/organisations/${orgId}/ai-usage`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Could not load AI use.');
        if (!gone) setU(body);
      })
      .catch((e) => { if (!gone) setError(e instanceof Error ? e.message : 'Could not load AI use.'); });
    return () => { gone = true; };
  }, [authedFetch, orgId]);

  const n = (x: number) => x.toLocaleString('en-IN');
  return (
    <>
      <h6 className="font-semibold mb-2">TatvaOS AI — use this month</h6>
      {error && <Alert tone="danger">{error}</Alert>}
      {!u && !error && <p className="text-[0.75rem] text-ink-muted">Loading…</p>}
      {u && (
        <p className="text-sm mb-1">
          {n(u.tokens)} tokens in {n(u.requests)} requests
          {u.ceilingTokens === null ? ' — no ceiling'
            : u.ceilingTokens === 0 ? ' — allowance set to none (AI refused)'
            : ` — ${u.percentOfCeiling}% of the ${n(u.ceilingTokens)} allowance`}.
          {u.refused > 0 && ` ${n(u.refused)} refused.`}
          {u.byFeature.length > 0 && ` By feature: ${u.byFeature.map((f) => `${f.feature} ${n(f.tokens)}`).join(', ')}.`}
        </p>
      )}
      <p className="text-[0.75rem] text-ink-muted mb-0">
        Limits and the platform-wide pause are on the Settings page.
      </p>
    </>
  );
}

/**
 * AI credits for this organisation (26 Sept 2026): what its plan gives, what
 * it has spent, and the operator's exception. Empty follows the plan; a
 * number is exactly that many credits a month; 0 allows none. Audited.
 */
function AiCreditsSection({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  type C = { allowance: number | null; source: string; planName: string | null; model: string | null;
    perUser: number | null; users: number | null; used: number; percent: number;
    base?: number | null; topUp?: number };
  type T = { id: string; credits: number; priceInr: number | null; reason: string; createdAt: string;
    withdrawnAt: string | null; withdrawReason: string | null };
  const [c, setC] = useState<C | null>(null);
  const [topups, setTopups] = useState<T[]>([]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const path = `/admin/organisations/${orgId}/ai-credits`;

  const load = useCallback(() => {
    authedFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Could not load AI credits.');
        setC(body.credits);
        setTopups(Array.isArray(body.topups) ? body.topups : []);
        setValue(body.override === null || body.override === undefined ? '' : String(body.override));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load AI credits.'));
  }, [authedFetch, path]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const v = value.trim();
      if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 0)) throw new Error('A whole number, or empty to follow the plan.');
      const res = await authedFetch(path, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override: v === '' ? null : Number(v) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setSaved(true);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const n = (x: number) => x.toLocaleString('en-IN');
  return (
    <>
      <h6 className="font-semibold mb-2 mt-4">AI credits</h6>
      {error && <Alert tone="danger">{error}</Alert>}
      {c && (
        <p className="text-sm mb-2">
          {n(c.used)} used this month
          {c.allowance === null ? ' — no credit limit' : ` of ${n(c.allowance)} (${c.percent}%)`}.{' '}
          <span className="text-ink-muted">
            {c.source === 'override' ? 'Set for this organisation by the operator.'
              : c.source === 'plan'
                ? c.model === 'per_user'
                  ? `From the ${c.planName} plan: ${c.perUser != null ? n(c.perUser) : '—'} per user × ${c.users ?? 0} users.`
                  : `From the ${c.planName} plan (pooled).`
                : 'No plan sets AI credits for this organisation.'}
          </span>
        </p>
      )}
      <div className="flex items-end gap-2">
        <div>
          <label htmlFor={`ai-credits-${orgId}`} className="mb-1 block text-[0.75rem] text-ink-muted">
            Override credits / month (empty follows the plan; 0 allows none)
          </label>
          <input id={`ai-credits-${orgId}`} type="number" min={0} value={value} placeholder="Follow the plan"
                 onChange={(e) => { setValue(e.target.value); setSaved(false); }}
                 className="w-40 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink" />
        </div>
        <Button variant="ghost" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        {saved && <span className="text-[0.75rem] text-ok">Saved and recorded in the audit trail.</span>}
      </div>
      <TopupsPanel orgId={orgId} topups={topups} hasLimit={c?.base !== null && c?.base !== undefined} onChanged={load} />
    </>
  );
}

/**
 * Mail AI for this organisation (30 Sept 2026): whether it is on the Mail AI
 * list (ai.mail.organisations), and the one action that puts it there.
 *
 * Offering is also a RESET: the organisation's own Mail AI goes off, sorting
 * off, features to their defaults, so its administrator agrees again under
 * the text that is live now. Organisation 5 is why: their switch from 25 Sept
 * was still on behind the gate, and a plain list edit would have resumed it.
 * The page sends back the list it showed, and the server refuses if it has
 * changed since. Run only after the privacy text is live, on Amit's go.
 */
function MailAiOfferSection({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  type S = { list: string; onList: boolean; everyone: boolean; allowAi: boolean; allowMailAi: boolean;
    privacyTextComplete: boolean; privacyTextIncomplete: string | null;
    sorting: boolean; features: { rewrite: boolean; suggest: boolean; summary: boolean } };
  const [s, setS] = useState<S | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const path = `/admin/organisations/${orgId}/mail-ai`;

  const load = useCallback(() => {
    authedFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Could not load Mail AI.');
        setS(body);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load Mail AI.'));
  }, [authedFetch, path]);
  useEffect(() => { load(); }, [load]);

  async function offer() {
    if (!s) return;
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(`${path}/offer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedList: s.list }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not offer Mail AI.');
      setDone(true); setConfirming(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not offer Mail AI.');
    } finally {
      setBusy(false);
    }
  }

  const onOff = (b: boolean) => (b ? 'on' : 'off');
  return (
    <>
      <h6 className="font-semibold mb-2 mt-4">TatvaOS AI in Mail</h6>
      {error && <Alert tone="danger">{error}</Alert>}
      {s && (
        <p className="text-sm mb-2">
          {s.everyone ? 'Offered to every organisation (the list is "all").'
            : s.onList ? 'On the Mail AI list.' : 'Not on the Mail AI list: its administrators see "not available yet".'}{' '}
          <span className="text-ink-muted">
            Its own switches: AI {onOff(s.allowAi)}, Mail AI {onOff(s.allowMailAi)}, sorting {onOff(s.sorting)};
            Help me write {onOff(s.features.rewrite)}, suggested replies {onOff(s.features.suggest)},
            Summarise {onOff(s.features.summary)}.
          </span>
        </p>
      )}
      {s && !s.onList && !s.everyone && !s.privacyTextComplete && (
        <p className="text-[0.75rem] text-warn mb-0">{s.privacyTextIncomplete}</p>
      )}
      {s && !s.onList && !s.everyone && s.privacyTextComplete && (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
          Offer Mail AI to this organisation…
        </Button>
      )}
      {done && <p className="text-[0.75rem] text-ok mb-0">Offered, reset, and recorded in the audit trail under your name.</p>}
      {confirming && s && (
        <Modal onClose={() => !busy && setConfirming(false)} title="Offer TatvaOS AI in Mail?" busy={busy}>
          <p>
            This organisation goes on the Mail AI list, and in the same step its own Mail AI is reset:
            Mail AI off, sorting off, Help me write on, suggested replies and Summarise off. Nothing is
            sent until its administrator turns Mail AI on again and agrees to the text shown then.
          </p>
          <p className="text-ink-muted">
            Only do this once the Mail AI privacy text is live on production. It is recorded in this
            organisation&apos;s audit trail under your name.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void offer()}>
              {busy ? 'Offering…' : 'Offer and reset'}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Top-up packs (26 Sept 2026): extra credits for THIS month on top of the
 * plan. The packs pre-fill the proposed prices; both stay editable, because
 * the price is Amit's decision and a goodwill top-up is ₹0. Withdrawn, never
 * deleted — each row records a sale.
 */
const PACKS = [
  { credits: 1000, price: 99 },
  { credits: 5000, price: 449 },
  { credits: 25000, price: 1999 },
];

function TopupsPanel({ orgId, topups, hasLimit, onChanged }: {
  orgId: string;
  topups: { id: string; credits: number; priceInr: number | null; reason: string; createdAt: string;
    withdrawnAt: string | null; withdrawReason: string | null }[];
  hasLimit: boolean;
  onChanged: () => void;
}) {
  const { authedFetch } = useAuth();
  const [credits, setCredits] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/admin/organisations/${orgId}/ai-credits/topups`;
  const n = (x: number) => x.toLocaleString('en-IN');

  async function add() {
    setBusy(true); setError(null);
    try {
      const cr = Number(credits);
      if (!(Number.isInteger(cr) && cr > 0)) throw new Error('Credits must be a whole number above 0.');
      if (!reason.trim()) throw new Error('Say why — for example the invoice number, or "goodwill".');
      const res = await authedFetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits: cr, priceInr: price.trim() === '' ? null : Number(price), reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not add the top-up.');
      setCredits(''); setPrice(''); setReason('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the top-up.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    const why = window.prompt('Why is this top-up being withdrawn? (kept in the record)');
    if (!why || !why.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(`${base}/${id}/withdraw`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: why.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not withdraw it.');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not withdraw it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="mb-1 text-sm font-medium">Top-up credits (this month only)</p>
      {!hasLimit && (
        <p className="mb-2 text-[0.75rem] text-warn">
          This organisation has no credit limit, so a top-up changes nothing until its plan or an override sets one.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {PACKS.map((p) => (
          <button key={p.credits} type="button"
                  onClick={() => { setCredits(String(p.credits)); setPrice(String(p.price)); }}
                  className="rounded-full border border-line px-3 py-1 text-xs hover:border-brand-400">
            {n(p.credits)} credits · ₹{n(p.price)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`tu-c-${orgId}`} className="mb-1 block text-[0.75rem] text-ink-muted">Credits</label>
          <input id={`tu-c-${orgId}`} type="number" min={1} value={credits} onChange={(e) => setCredits(e.target.value)}
                 className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink" />
        </div>
        <div>
          <label htmlFor={`tu-p-${orgId}`} className="mb-1 block text-[0.75rem] text-ink-muted">Price charged (₹)</label>
          <input id={`tu-p-${orgId}`} type="number" min={0} value={price} placeholder="0 for goodwill" onChange={(e) => setPrice(e.target.value)}
                 className="w-28 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink" />
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={`tu-r-${orgId}`} className="mb-1 block text-[0.75rem] text-ink-muted">Reason (invoice number, goodwill…)</label>
          <input id={`tu-r-${orgId}`} value={reason} onChange={(e) => setReason(e.target.value)}
                 className="w-full rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink" />
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add top-up'}</Button>
      </div>
      {topups.length > 0 && (
        <ul className="mb-0 mt-2 list-none space-y-1 p-0 text-[0.8rem]">
          {topups.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-center gap-2 ${t.withdrawnAt ? 'text-ink-faint line-through' : ''}`}>
              <span>{n(t.credits)} credits</span>
              <span className="text-ink-muted">{t.priceInr != null ? `₹${n(t.priceInr)}` : '—'}</span>
              <span className="text-ink-muted">{new Date(t.createdAt).toLocaleDateString('en-IN')}</span>
              <span className="min-w-0 truncate text-ink-muted">{t.reason}</span>
              {t.withdrawnAt
                ? <span className="no-underline text-ink-faint">(withdrawn: {t.withdrawReason})</span>
                : <button type="button" disabled={busy} onClick={() => void withdraw(t.id)}
                          className="text-danger hover:underline">Withdraw</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InvitationCaps({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const [answer, setAnswer] = useState<CapsAnswer | null>(null);
  const [perRequest, setPerRequest] = useState('');
  const [perMeeting, setPerMeeting] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const path = `/admin/organisations/${orgId}/connect-invitation-caps`;

  const take = useCallback((a: CapsAnswer) => {
    setAnswer(a);
    setPerRequest(a.perRequest === null ? '' : String(a.perRequest));
    setPerMeeting(a.perMeeting === null ? '' : String(a.perMeeting));
  }, []);

  useEffect(() => {
    let gone = false;
    authedFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? 'Could not load the invitation limits.');
        if (!gone) take(body as CapsAnswer);
      })
      .catch((e) => { if (!gone) setError(e instanceof Error ? e.message : 'Could not load the invitation limits.'); });
    return () => { gone = true; };
  }, [authedFetch, path, take]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const res = await authedFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          perRequest: perRequest === '' ? null : Number(perRequest),
          perMeeting: perMeeting === '' ? null : Number(perMeeting),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save the invitation limits.');
      take(body as CapsAnswer);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the invitation limits.');
    } finally {
      setBusy(false);
    }
  }

  const dirty = answer !== null && (
    perRequest !== (answer.perRequest === null ? '' : String(answer.perRequest)) ||
    perMeeting !== (answer.perMeeting === null ? '' : String(answer.perMeeting)));

  return (
    <>
      <h6 className="font-semibold mb-2">Connect — email invitations</h6>
      <p className="text-[0.75rem] text-ink-muted mb-4">
        How many people this organisation may invite to one meeting by email. Only
        you can change this; the organisation cannot.
        {answer && <> In force now: {answer.effectivePerRequest} per send, {answer.effectivePerMeeting} per meeting.</>}
      </p>

      {error && <Alert tone="danger">{error}</Alert>}
      {saved && !dirty && <Alert tone="ok">Saved. It applies to the next invitation sent.</Alert>}

      <Field label="Per send"
             hint={answer ? `Leave empty for the default (${answer.defaultPerRequest}). At most ${answer.ceiling}.` : undefined}>
        <Input value={perRequest} inputMode="numeric" disabled={answer === null}
               placeholder={answer ? String(answer.defaultPerRequest) : ''}
               onChange={(e) => { setSaved(false); setPerRequest(e.target.value.replace(/\D/g, '')); }} />
      </Field>

      <Field label="Per meeting"
             hint={answer ? `Leave empty for the default (${answer.defaultPerMeeting}). At most ${answer.ceiling}.` : undefined}>
        <Input value={perMeeting} inputMode="numeric" disabled={answer === null}
               placeholder={answer ? String(answer.defaultPerMeeting) : ''}
               onChange={(e) => { setSaved(false); setPerMeeting(e.target.value.replace(/\D/g, '')); }} />
      </Field>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save limits'}
        </Button>
      </div>
    </>
  );
}

/**
 * A product's on/off switch for this organisation, for the products whose
 * operator route is /admin/organisations/{id}/{product} with { enabled }.
 * Sheets uses it (SheetsAdminEndpoints); every change is audited there.
 */
function ProductSwitch({ orgId, product, name, blurb }: { orgId: string; product: string; name: string; blurb: string }) {
  const { authedFetch } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/admin/organisations/${orgId}/${product}`;

  useEffect(() => {
    let gone = false;
    authedFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Could not load the ${name} setting.`);
        if (!gone) setEnabled(Boolean(body.enabled));
      })
      .catch((e) => { if (!gone) setError(e instanceof Error ? e.message : `Could not load the ${name} setting.`); });
    return () => { gone = true; };
  }, [authedFetch, path, name]);

  async function flip() {
    if (enabled === null) return;
    setBusy(true); setError(null);
    try {
      const res = await authedFetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not change the ${name} setting.`);
      setEnabled(Boolean(body.enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not change the ${name} setting.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h6 className="font-semibold mb-2">{name}</h6>
      <p className="text-[0.75rem] text-ink-muted mb-4">{blurb}</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex items-center justify-between">
        <span className="text-sm">
          {enabled === null ? 'Loading…' : enabled ? 'On for this organisation' : 'Off for this organisation'}
        </span>
        <Button variant={enabled ? 'secondary' : 'primary'} onClick={flip} disabled={busy || enabled === null}>
          {busy ? 'Saving…' : enabled ? `Turn ${name} off` : `Turn ${name} on`}
        </Button>
      </div>
    </>
  );
}
