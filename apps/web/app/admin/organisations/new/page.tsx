'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { adminApi, formatBytes } from '@tatvaos/core';
import type { OnboardingDraft, OrgType, Plan } from '@tatvaos/types';
import { AdminShell } from '@/components/admin/AdminShell';

const GB = 1024 ** 3;

const STEPS = ['Organisation', 'Domain', 'Plan and limits', 'Administrator'] as const;

const ORG_TYPES: { value: OrgType; label: string; hint: string }[] = [
  { value: 'business', label: 'Business', hint: 'Company, agency, firm' },
  { value: 'school', label: 'School or institute', hint: 'Staff and students' },
  { value: 'hospital', label: 'Hospital or clinic', hint: 'Patient data — see compliance' },
  { value: 'nonprofit', label: 'Non-profit', hint: '' },
  { value: 'government', label: 'Government', hint: '' },
  { value: 'other', label: 'Other', hint: '' },
];

export default function OnboardOrganisation() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [draft, setDraft] = useState<OnboardingDraft>({
    name: '',
    type: 'business',
    country: 'India',
    phone: '',
    gstin: '',
    adminName: '',
    adminEmail: '',
    primaryDomain: '',
    planId: 'plan-business',
    storageModel: 'per_user',
    maxUsers: 100,
    perUserQuotaGb: 30,
    pooledStorageGb: 2048,
  });

  useEffect(() => {
    adminApi.getPlans().then(setPlans);
  }, []);

  function set<K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** Selecting a plan pre-fills its limits — they stay editable per organisation. */
  function choosePlan(p: Plan) {
    setDraft((d) => ({
      ...d,
      planId: p.id,
      storageModel: p.storageModel,
      maxUsers: p.maxUsers,
      perUserQuotaGb: p.perUserQuotaBytes ? Math.round(p.perUserQuotaBytes / GB) : d.perUserQuotaGb,
      pooledStorageGb: p.pooledStorageBytes
        ? Math.round(p.pooledStorageBytes / GB)
        : d.pooledStorageGb,
    }));
  }

  const totalCommitted = useMemo(() => {
    if (draft.storageModel === 'pooled') return draft.pooledStorageGb * GB;
    return draft.perUserQuotaGb * GB * (draft.maxUsers ?? 0);
  }, [draft]);

  const canContinue = [
    draft.name.trim().length > 1,
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(draft.primaryDomain.trim()),
    draft.storageModel === 'pooled' ? draft.pooledStorageGb > 0 : draft.perUserQuotaGb > 0,
    draft.adminName.trim().length > 1 && /\S+@\S+\.\S+/.test(draft.adminEmail),
  ][step];

  async function submit() {
    setSubmitting(true);
    // Phase 1 wires this to POST /admin/organisations
    await new Promise((r) => setTimeout(r, 700));
    router.push('/admin');
  }

  return (
    <AdminShell
      scope="platform"
      title="Onboard organisation"
      subtitle="Create a new tenant on the platform"
      nav={[{ href: '/admin', label: 'Organisations' }, { href: '/admin/plans', label: 'Plans' }]}
    >
      <div className="mx-auto max-w-3xl">
        <ol className="mb-8 flex items-center gap-2">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  i < step
                    ? 'bg-brand-600 text-white'
                    : i === step
                      ? 'bg-brand-100 text-brand-800 ring-2 ring-brand-600'
                      : 'bg-canvas text-ink-faint'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </div>
              <span
                className={`hidden text-sm sm:inline ${i === step ? 'font-medium text-ink' : 'text-ink-muted'}`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="ml-1 h-px flex-1 bg-line" />}
            </li>
          ))}
        </ol>

        <div className="rounded-xl border border-line bg-surface p-6">
          {/* ---------------------------------------------------------- 1 */}
          {step === 0 && (
            <div className="space-y-5">
              <Field label="Organisation name" required>
                <input
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="ABC School"
                  className={inputCls}
                />
              </Field>

              <Field
                label="Type"
                hint="Drives the default user categories and which compliance notes apply"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {ORG_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => set('type', t.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition ${
                        draft.type === t.value
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-line hover:border-line'
                      }`}
                    >
                      <div className="text-sm font-medium text-ink">{t.label}</div>
                      {t.hint && <div className="text-xs text-ink-muted">{t.hint}</div>}
                    </button>
                  ))}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Country">
                  <input
                    value={draft.country}
                    onChange={(e) => set('country', e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label="Phone" hint="Verified by OTP — an anti-abuse signal">
                  <input
                    value={draft.phone}
                    onChange={(e) => set('phone', e.target.value)}
                    placeholder="+91 98765 43210"
                    className={inputCls}
                  />
                </Field>
              </div>

              {draft.country === 'India' && (
                <Field label="GSTIN" hint="Optional. Required to issue a GST invoice">
                  <input
                    value={draft.gstin}
                    onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                    placeholder="27AABCT1234H1Z5"
                    className={inputCls}
                  />
                </Field>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------- 2 */}
          {step === 1 && (
            <div className="space-y-5">
              <Field label="Primary domain" required hint="The domain their email addresses use">
                <input
                  value={draft.primaryDomain}
                  onChange={(e) => set('primaryDomain', e.target.value.toLowerCase())}
                  placeholder="abcschool.edu.in"
                  className={inputCls}
                />
              </Field>

              <div className="rounded-lg border border-warn/30 bg-warn/10 p-4 text-sm">
                <div className="font-medium text-warn">Nothing is delivered yet</div>
                <p className="mt-1 text-warn">
                  Adding a domain does not accept mail for it. The organisation must publish a
                  verification TXT record first, then MX, SPF, DKIM and DMARC. Until ownership is
                  proven, no mail is accepted and no user can send as this domain.
                </p>
                <p className="mt-2 text-warn">
                  This is what stops anyone claiming a domain they do not control — and it is the
                  answer we give providers who ask how we prevent abuse.
                </p>
              </div>

              {draft.primaryDomain && (
                <div className="rounded-lg bg-canvas p-4 font-mono text-xs text-ink">
                  <div className="mb-2 font-sans text-xs font-medium uppercase text-ink-muted">
                    They will be asked to add
                  </div>
                  TXT @ tatvaos-verification=&lt;token&gt;
                  <br />
                  MX @ 10 mx1.tatvaos.mail
                  <br />
                  TXT @ v=spf1 include:_spf.tatvaos.mail -all
                  <br />
                  TXT tatvaos._domainkey v=DKIM1; k=rsa; p=…
                  <br />
                  TXT _dmarc v=DMARC1; p=none; rua=mailto:…
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------- 3 */}
          {step === 2 && (
            <div className="space-y-6">
              <Field label="Plan">
                <div className="grid gap-2">
                  {plans.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => choosePlan(p)}
                      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition ${
                        draft.planId === p.id
                          ? 'border-brand-600 bg-brand-50'
                          : 'border-line hover:border-line'
                      }`}
                    >
                      <div className="flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-ink">{p.name}</span>
                          <span className="text-xs text-ink-muted">
                            {p.maxUsers === null ? 'Unlimited users' : `up to ${p.maxUsers} users`}
                            {' · '}
                            {p.storageModel === 'pooled'
                              ? `${formatBytes(p.pooledStorageBytes ?? 0)} pooled`
                              : `${formatBytes(p.perUserQuotaBytes ?? 0)} per user`}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-muted">
                          {p.features.slice(0, 3).join(' · ')}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-sm">
                        {p.pricePerUserMonthly ? (
                          <>
                            <span className="font-semibold">₹{p.pricePerUserMonthly}</span>
                            <span className="text-ink-muted">/user/mo</span>
                          </>
                        ) : (
                          <>
                            <span className="font-semibold">
                              ₹{p.priceMonthly?.toLocaleString('en-IN')}
                            </span>
                            <span className="text-ink-muted">/mo</span>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </Field>

              {/* ---- the storage model decision ---- */}
              <Field label="Storage model" hint="Overrides the plan default for this organisation">
                <div className="grid gap-3 sm:grid-cols-2">
                  <StorageOption
                    active={draft.storageModel === 'per_user'}
                    onClick={() => set('storageModel', 'per_user')}
                    title="Per-user quota"
                    body="Every mailbox gets the same fixed allowance. Predictable, easy to explain, bills cleanly per seat."
                    caveat="Wastes space on light users."
                  />
                  <StorageOption
                    active={draft.storageModel === 'pooled'}
                    onClick={() => set('storageModel', 'pooled')}
                    title="Pooled storage"
                    body="One allocation shared across all mailboxes. Far cheaper where usage is uneven."
                    caveat="Harder to reason about when it fills."
                  />
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Maximum users" hint="Leave empty for unlimited">
                  <input
                    type="number"
                    min={1}
                    value={draft.maxUsers ?? ''}
                    onChange={(e) =>
                      set('maxUsers', e.target.value === '' ? null : Number(e.target.value))
                    }
                    placeholder="Unlimited"
                    className={inputCls}
                  />
                </Field>

                {draft.storageModel === 'per_user' ? (
                  <Field label="Storage per user (GB)">
                    <input
                      type="number"
                      min={1}
                      value={draft.perUserQuotaGb}
                      onChange={(e) => set('perUserQuotaGb', Number(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                ) : (
                  <Field label="Total pooled storage (GB)">
                    <input
                      type="number"
                      min={1}
                      value={draft.pooledStorageGb}
                      onChange={(e) => set('pooledStorageGb', Number(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                )}
              </div>

              <div className="rounded-lg bg-canvas p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-muted">Total storage committed</span>
                  <span className="font-semibold text-ink">{formatBytes(totalCommitted)}</span>
                </div>
                {draft.storageModel === 'per_user' && draft.maxUsers !== null && (
                  <div className="mt-1 text-xs text-ink-muted">
                    {draft.perUserQuotaGb} GB × {draft.maxUsers} users. Only consumed as mailboxes
                    are created.
                  </div>
                )}
                {draft.storageModel === 'pooled' && (
                  <div className="mt-1 text-xs text-ink-muted">
                    Shared across every mailbox. A school of 200 students at 2 GB each plus 40 staff
                    at 15 GB needs roughly 1 TB — against 4.8 TB committed under a flat 20 GB
                    per-user quota.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---------------------------------------------------------- 4 */}
          {step === 3 && (
            <div className="space-y-5">
              <Field label="Administrator name" required>
                <input
                  value={draft.adminName}
                  onChange={(e) => set('adminName', e.target.value)}
                  placeholder="Sunita Rao"
                  className={inputCls}
                />
              </Field>

              <Field
                label="Administrator email"
                required
                hint="Must be a working address OUTSIDE the domain being onboarded — they need it to receive credentials before their own mail works"
              >
                <input
                  value={draft.adminEmail}
                  onChange={(e) => set('adminEmail', e.target.value)}
                  placeholder="sunita@gmail.com"
                  className={inputCls}
                />
              </Field>

              <div className="rounded-lg border border-line bg-canvas p-4">
                <div className="mb-3 text-sm font-medium text-ink">Summary</div>
                <dl className="space-y-1.5 text-sm">
                  <Row k="Organisation" v={draft.name || '—'} />
                  <Row k="Type" v={ORG_TYPES.find((t) => t.value === draft.type)?.label ?? '—'} />
                  <Row k="Domain" v={draft.primaryDomain || '—'} />
                  <Row k="Plan" v={plans.find((p) => p.id === draft.planId)?.name ?? '—'} />
                  <Row
                    k="Storage"
                    v={
                      draft.storageModel === 'pooled'
                        ? `${draft.pooledStorageGb} GB pooled`
                        : `${draft.perUserQuotaGb} GB per user`
                    }
                  />
                  <Row k="Max users" v={draft.maxUsers === null ? 'Unlimited' : String(draft.maxUsers)} />
                  <Row k="Administrator" v={draft.adminEmail || '—'} />
                </dl>
              </div>

              <p className="text-xs text-ink-muted">
                On creation the organisation is <strong>pending</strong>. It becomes active once the
                domain is verified. No mail is accepted for the domain before that.
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-canvas"
            >
              Back
            </button>
          )}
          <div className="ml-auto flex gap-3">
            <button
              type="button"
              onClick={() => router.push('/admin')}
              className="rounded-lg px-4 py-2 text-sm text-ink-muted hover:bg-canvas"
            >
              Cancel
            </button>
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                disabled={!canContinue}
                onClick={() => setStep((s) => s + 1)}
                className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                disabled={!canContinue || submitting}
                onClick={submit}
                className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? 'Creating…' : 'Create organisation'}
              </button>
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

const inputCls =
  'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-brand-500';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

function StorageOption({
  active,
  onClick,
  title,
  body,
  caveat,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
  caveat: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-4 text-left transition ${
        active ? 'border-brand-600 bg-brand-50' : 'border-line hover:border-line'
      }`}
    >
      <div className="text-sm font-medium text-ink">{title}</div>
      <p className="mt-1 text-xs text-ink-muted">{body}</p>
      <p className="mt-1.5 text-xs text-ink-faint">{caveat}</p>
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="text-right font-medium text-ink">{v}</dd>
    </div>
  );
}
