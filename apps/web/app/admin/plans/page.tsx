'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import {
  fetchPlans, createPlan, updatePlan, deletePlan,
  type PlanRow, type UpsertPlanBody,
} from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Empty } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { Modal } from '@/components/ui/Modal';

// ============================================================================
//  MIGRATED OFF BOOTSTRAP, 8 Sept 2026 — stage 3 of docs/UI_LANE_BRIEF.md.
//
//  This page went first of the remaining six because it is platform-admin only:
//  if a layout here is wrong, we see it and no customer does. It is the pattern
//  for the other five, so the substitutions are worth stating plainly:
//
//    .card custom-card / .card-body   -> <Card>
//    .alert-*                         -> <Alert tone>
//    .btn .btn-primary / .btn-light   -> <Button variant>
//    hand-rolled .modal markup        -> <Modal> (components/ui/Modal.tsx)
//    .row + .col-xxl-3 col-lg-6       -> a Tailwind grid
//    .form-check                      -> a labelled native checkbox
//
//  NOTHING ABOUT WHAT THIS PAGE DOES CHANGED. Same state, same validation, same
//  requests, same copy. That is the stage 3 rule — migrate while it still looks
//  and behaves the same — and it is what makes a regression here obviously this
//  commit's fault rather than something to go hunting for.
//
//  TWO THINGS DELIBERATELY LEFT. The `ri-*` icons are Remix Icon's font, which
//  YZEN loads; they are not Bootstrap and swapping them would change the look
//  for no gain today. And the grid classes below must stay inside the list
//  re-declared in styles/overrides.css — YZEN's own `.grid` utility outranks
//  Tailwind's `grid-cols-*` by source order, so a count that is not in that
//  list silently collapses to one column.
// ============================================================================

// Storage is stored in bytes; the form works in GB and converts on the way in
// and out — the same GB convention the onboarding form and org pages use.
const GB = 1024 ** 3;

// ---------------------------------------------------------------------------
//  THE PRODUCTS A PLAN CAN GRANT. This list must match core.products, and for
//  months it did not.
//
//  It offered People, Payroll, Sheet and Word — all four DELETED from
//  core.products by 0028-product-catalogue.sql — while omitting Connect,
//  Calendar and Family, which are the products that actually exist. The
//  consequence, found on 9 Sept 2026 when Amit tried to give his own
//  organisation Connect and could not: there was no checkbox for it. Granting
//  Connect was impossible from the admin console, on any plan, for anyone.
//
//  Codes, not labels, and two do not match their names — the same trap
//  apps/mobile/theme.js documents:
//      Space    -> code 'drive'   (renamed; the code stayed because
//                                  allocations, audit rows and storage all
//                                  point at it)
//      Contacts -> code 'family'
//  Get one wrong and the product silently vanishes from every plan that had
//  it, which reads as an entitlement bug rather than a typo.
//
//  Verified against local/postgres/init: 0000-core-schema.sql seeds mail,
//  drive, calendar, connect; 0022-family-departure.sql adds family;
//  0025-space-schema.sql renames drive to Space; 0028 removes the four
//  placeholders. `soon` marks a product that exists in the catalogue but is
//  not shipped yet (is_available = false).
//
//  Unknown codes are still preserved on save — see formFromPlan, which unions
//  this list with whatever the plan already grants. That is what stops a stale
//  list here silently stripping entitlements, and it is why the damage above
//  was invisible rather than loud.
// ---------------------------------------------------------------------------
const PRODUCTS: { key: string; label: string; soon?: boolean }[] = [
  { key: 'mail', label: 'Mail' },
  { key: 'family', label: 'Contacts' },
  { key: 'drive', label: 'Space' },
  { key: 'connect', label: 'Connect', soon: true },
  { key: 'calendar', label: 'Calendar', soon: true },
];

type StorageModel = 'per_user' | 'pooled';
type PricingModel = 'per_user' | 'flat' | 'custom';

/**
 * Numbers are held as strings on purpose: an empty field has to mean
 * "unlimited" rather than 0, and a half-typed value must not coerce to NaN
 * mid-keystroke. They are converted once, in toBody().
 */
interface PlanForm {
  id?: string;
  name: string;
  maxUsers: string;
  storageModel: StorageModel;
  perUserQuotaGb: string;
  pooledStorageGb: string;
  maxDomains: string;
  pricingModel: PricingModel;
  price: string;
  products: Record<string, boolean>;
}

function blankForm(): PlanForm {
  return {
    name: '',
    maxUsers: '',
    storageModel: 'per_user',
    perUserQuotaGb: '30',
    pooledStorageGb: '2048',
    maxDomains: '',
    pricingModel: 'per_user',
    price: '',
    products: Object.fromEntries(PRODUCTS.map((p) => [p.key, p.key === 'mail'] as const)),
  };
}

function formFromPlan(p: PlanRow): PlanForm {
  const pricingModel: PricingModel =
    p.pricePerUserMonthly != null ? 'per_user' : p.priceMonthly != null ? 'flat' : 'custom';
  return {
    id: p.id,
    name: p.name,
    maxUsers: p.maxUsers != null ? String(p.maxUsers) : '',
    storageModel: p.storageModel === 'pooled' ? 'pooled' : 'per_user',
    perUserQuotaGb: p.perUserQuotaBytes ? String(Math.round(p.perUserQuotaBytes / GB)) : '30',
    pooledStorageGb: p.pooledStorageBytes ? String(Math.round(p.pooledStorageBytes / GB)) : '2048',
    maxDomains: p.maxDomains != null ? String(p.maxDomains) : '',
    pricingModel,
    price:
      pricingModel === 'per_user' ? String(p.pricePerUserMonthly)
      : pricingModel === 'flat' ? String(p.priceMonthly)
      : '',
    // The union of what the UI knows about and what this plan already grants,
    // so an unrecognised product still shows up as a ticked box rather than
    // vanishing from the form — and therefore from the plan.
    products: Object.fromEntries(
      [...new Set([...PRODUCTS.map((x) => x.key), ...p.includedProducts])]
        .map((k) => [k, p.includedProducts.includes(k)] as const),
    ),
  };
}

/** Mirrors the server's rules so an obvious mistake fails here, not after a round trip. */
function validate(f: PlanForm): string[] {
  const errs: string[] = [];
  if (!f.name.trim()) errs.push('A plan name is required.');
  if (f.storageModel === 'per_user' && !(Number(f.perUserQuotaGb) > 0)) {
    errs.push('Storage per user must be greater than 0 GB.');
  }
  if (f.storageModel === 'pooled' && !(Number(f.pooledStorageGb) > 0)) {
    errs.push('Pooled storage must be greater than 0 GB.');
  }
  if (f.pricingModel !== 'custom' && !(Number(f.price) > 0)) {
    errs.push('Enter a price, or switch pricing to Custom.');
  }
  return errs;
}

/**
 * The storage field that does not match the chosen model is sent null, not
 * left over from a previous edit — otherwise switching a plan from pooled to
 * per-user would quietly keep billing the old pooled figure.
 */
function toBody(f: PlanForm): UpsertPlanBody {
  return {
    name: f.name.trim(),
    maxUsers: f.maxUsers.trim() === '' ? null : Number(f.maxUsers),
    storageModel: f.storageModel,
    perUserQuotaBytes: f.storageModel === 'per_user' ? Math.round(Number(f.perUserQuotaGb) * GB) : null,
    pooledStorageBytes: f.storageModel === 'pooled' ? Math.round(Number(f.pooledStorageGb) * GB) : null,
    maxDomains: f.maxDomains.trim() === '' ? null : Number(f.maxDomains),
    // Built from the form's own keys, never from PRODUCTS — that is what keeps
    // a product this screen does not recognise attached to the plan.
    includedProducts: Object.entries(f.products).filter(([, on]) => on).map(([k]) => k),
    pricePerUserMonthly: f.pricingModel === 'per_user' ? Number(f.price) : null,
    priceMonthly: f.pricingModel === 'flat' ? Number(f.price) : null,
  };
}

// ===========================================================================
export default function AdminPlansPage() {
  const { authedFetch } = useAuth();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const [form, setForm] = useState<PlanForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);

  const [toDelete, setToDelete] = useState<PlanRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fetchPlans(authedFetch)
      .then(setPlans)
      .catch(() => setPlans([]))
      .finally(() => setLoading(false));
  }, [authedFetch]);

  useEffect(() => { reload(); }, [reload]);

  // Escape used to be handled here for both dialogs. Modal now owns it — and
  // owns the "not while busy" rule too, so a dialog cannot be dismissed mid-save
  // and leave the operator unsure whether the write went through.

  function openAdd() { setFormErrors([]); setForm(blankForm()); }
  function openEdit(p: PlanRow) { setFormErrors([]); setForm(formFromPlan(p)); }

  async function saveForm() {
    if (!form) return;
    const errs = validate(form);
    if (errs.length) { setFormErrors(errs); return; }

    setSaving(true);
    setFormErrors([]);
    try {
      const body = toBody(form);
      if (form.id) {
        await updatePlan(authedFetch, form.id, body);
        setNotice({ kind: 'success', text: `Saved “${body.name}”.` });
      } else {
        await createPlan(authedFetch, body);
        setNotice({ kind: 'success', text: `Created “${body.name}”.` });
      }
      setForm(null);
      reload();
    } catch (e) {
      // Server-side rejections stay INSIDE the dialog, next to the fields that
      // caused them — closing the form to show a banner would lose the edit.
      setFormErrors([e instanceof Error ? e.message : 'Could not save the plan.']);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePlan(authedFetch, toDelete.id);
      setNotice({ kind: 'success', text: `Deleted “${toDelete.name}”.` });
      setToDelete(null);
      reload();
    } catch (e) {
      // The "plan is in use" 400 lands here. Its text names what to do about
      // it (move organisations off first), so it is shown verbatim.
      setDeleteError(e instanceof Error ? e.message : 'Could not delete the plan.');
    } finally {
      setDeleting(false);
    }
  }

  const addButton = (
    <Button variant="primary" onClick={openAdd}>
      <i className="ri-add-line" aria-hidden="true" /> Add plan
    </Button>
  );

  return (
    <AdminShell
      scope="platform"
      title="Plans"
      subtitle="The catalogue every organisation is billed against"
      actions={addButton}
    >
      {notice && (
        <Alert
          tone={notice.kind === 'success' ? 'ok' : 'danger'}
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </Alert>
      )}

      {loading ? (
        <Card padded={false}><Empty title="Loading…" /></Card>
      ) : plans.length === 0 ? (
        <Card padded={false}>
          <Empty
            title="No plans yet"
            hint="Add the first plan and it becomes assignable from any organisation's Manage dialog."
            action={addButton}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              onEdit={() => openEdit(p)}
              onDelete={() => { setDeleteError(null); setToDelete(p); }}
            />
          ))}
        </div>
      )}

      {form && (
        <PlanFormModal
          form={form} setForm={setForm} errors={formErrors} saving={saving}
          onClose={() => setForm(null)} onSave={saveForm}
        />
      )}

      {toDelete && (
        <ConfirmDeleteModal
          plan={toDelete} deleting={deleting} error={deleteError}
          onClose={() => setToDelete(null)} onConfirm={confirmDelete}
        />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
/**
 * One plan. The card is a flex column with the actions pushed to the bottom, so
 * a row of plans with different numbers of features still has its Edit buttons
 * on one line — with Bootstrap's grid they sat wherever the text ended.
 */
function PlanCard({ plan: p, onEdit, onDelete }: {
  plan: PlanRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-700">
          <i className="ri-price-tag-3-line text-lg" aria-hidden="true" />
        </span>
        <h6 className="min-w-0 flex-1 truncate font-semibold text-ink" title={p.name}>{p.name}</h6>
      </div>

      <div className="mb-3">
        {p.pricePerUserMonthly ? (
          <>
            <span className="text-2xl font-bold text-ink">₹{p.pricePerUserMonthly}</span>
            <span className="text-xs text-ink-muted"> / user / month</span>
          </>
        ) : p.priceMonthly ? (
          <>
            <span className="text-2xl font-bold text-ink">₹{p.priceMonthly}</span>
            <span className="text-xs text-ink-muted"> / month</span>
          </>
        ) : (
          <span className="text-xl font-semibold text-ink-muted">Custom pricing</span>
        )}
      </div>

      <ul className="mb-0 list-none space-y-2 p-0 text-[13px]">
        <Feature>{p.maxUsers ? `Up to ${p.maxUsers} people` : 'Unlimited people'}</Feature>
        <Feature>
          {p.storageModel === 'pooled'
            ? `${formatBytes(p.pooledStorageBytes ?? 0)} pooled storage`
            : `${formatBytes(p.perUserQuotaBytes ?? 0)} per user`}
        </Feature>
        <Feature>{p.maxDomains ? `${p.maxDomains} domain${p.maxDomains > 1 ? 's' : ''}` : 'Unlimited domains'}</Feature>
        <Feature><span className="capitalize">{p.includedProducts.join(', ') || 'mail'}</span></Feature>
      </ul>

      {/* mt-auto is what pins this row to the bottom of the tallest card. */}
      <div className="mt-auto flex gap-2 border-t border-line pt-3">
        <Button className="flex-1" onClick={onEdit}>
          <i className="ri-pencil-line" aria-hidden="true" /> Edit
        </Button>
        {/* Hand-rolled rather than <Button variant="secondary" className="text-danger">.
            Two utilities that set the same property — text-ink and text-danger —
            do not resolve by their order in the className string; they resolve by
            their order in Tailwind's generated stylesheet, which is not something
            the caller controls. That is the quiet way a "red" button ships grey.
            Where a variant needs different colours, write the classes once. */}
        <button
          type="button"
          aria-label={`Delete ${p.name}`}
          onClick={onDelete}
          className={
            'inline-flex items-center justify-center rounded-lg border border-danger '
            + 'px-3 py-2 text-sm font-semibold text-danger transition-colors '
            + 'hover:bg-danger hover:text-white focus-visible:outline-none '
            + 'focus-visible:ring-2 focus-visible:ring-danger/40'
          }
        >
          <i className="ri-delete-bin-line" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * A joined row of mutually exclusive choices — what `.btn-group` was doing.
 *
 * These are toggle buttons, so each carries aria-pressed: the selected one is
 * currently signalled by being violet, and colour alone is not a state anyone
 * using a screen reader can perceive. Same rule the sidebar's active item and
 * the Alert's coloured bar follow.
 */
function Segmented<T extends string>({ label, value, options, onChange, size = 'md' }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex w-full" role="group" aria-label={label}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={
              'flex-1 border border-brand-500 font-semibold transition-colors '
              + (size === 'sm' ? 'px-3 py-1.5 text-xs ' : 'px-4 py-2 text-sm ')
              + (i === 0 ? 'rounded-l-lg ' : '')
              + (i === options.length - 1 ? 'rounded-r-lg ' : '')
              // The shared edge is one line, not two stacked on each other.
              + (i > 0 ? '-ml-px ' : '')
              + (active
                ? 'z-10 bg-brand-500 text-white'
                : 'bg-surface text-brand-700 hover:bg-brand-50')
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
//  Add / Edit
// ---------------------------------------------------------------------------
function PlanFormModal({
  form, setForm, errors, saving, onClose, onSave,
}: {
  form: PlanForm;
  setForm: (f: PlanForm) => void;
  errors: string[];
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => setForm({ ...form, [key]: value });
  const setProduct = (key: string, on: boolean) => setForm({ ...form, products: { ...form.products, [key]: on } });
  const editing = Boolean(form.id);

  return (
    <Modal
      title={editing ? 'Edit plan' : 'Add plan'}
      size="lg"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
          </Button>
        </>
      }
    >
      {editing && (
        <Alert tone="warn">
          Changes apply to new growth only — organisations already on this plan keep the
          limits they were given and are not resized.
        </Alert>
      )}

      {errors.length > 0 && (
        <Alert tone="danger">
          <ul className="mb-0 list-disc space-y-0.5 pl-4">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FieldLabel htmlFor="plan-name">Name</FieldLabel>
          <Input id="plan-name" value={form.name} autoFocus
                 placeholder="Business" onChange={(e) => set('name', e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <FieldLabel>Storage model</FieldLabel>
          <Segmented
            label="Storage model"
            value={form.storageModel}
            onChange={(v) => set('storageModel', v)}
            options={[
              { value: 'per_user', label: 'Per-user quota' },
              { value: 'pooled', label: 'Pooled' },
            ]}
          />
        </div>

        <div>
          {form.storageModel === 'per_user' ? (
            <>
              <FieldLabel htmlFor="plan-per-user">Storage per user (GB)</FieldLabel>
              <Input id="plan-per-user" type="number" min={1}
                     value={form.perUserQuotaGb}
                     onChange={(e) => set('perUserQuotaGb', e.target.value)} />
            </>
          ) : (
            <>
              <FieldLabel htmlFor="plan-pooled">Total pooled storage (GB)</FieldLabel>
              <Input id="plan-pooled" type="number" min={1}
                     value={form.pooledStorageGb}
                     onChange={(e) => set('pooledStorageGb', e.target.value)} />
            </>
          )}
        </div>

        <div>
          <FieldLabel htmlFor="plan-seats">Max users</FieldLabel>
          <Input id="plan-seats" type="number" min={1}
                 placeholder="Unlimited" value={form.maxUsers}
                 onChange={(e) => set('maxUsers', e.target.value)} />
        </div>

        <div>
          <FieldLabel htmlFor="plan-domains">Max domains</FieldLabel>
          <Input id="plan-domains" type="number" min={1}
                 placeholder="Unlimited" value={form.maxDomains}
                 onChange={(e) => set('maxDomains', e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <FieldLabel>Pricing</FieldLabel>
          <div className="mb-2">
            <Segmented
              label="Pricing model"
              size="sm"
              value={form.pricingModel}
              onChange={(v) => set('pricingModel', v)}
              options={[
                { value: 'per_user', label: 'Per user / month' },
                { value: 'flat', label: 'Flat / month' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          </div>
          {form.pricingModel !== 'custom' && (
            // The rupee sign sits inside the field rather than in a joined
            // prefix box: one control, one border, and the caret lands after
            // the symbol where you expect it.
            <div className="relative">
              <span aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-muted">
                ₹
              </span>
              <Input type="number" min={0} value={form.price} className="pl-7"
                     aria-label={form.pricingModel === 'per_user' ? 'Price per user per month' : 'Price per month'}
                     placeholder={form.pricingModel === 'per_user' ? 'per user, per month' : 'per month'}
                     onChange={(e) => set('price', e.target.value)} />
            </div>
          )}
        </div>

        <div className="sm:col-span-2">
          <FieldLabel>Included products</FieldLabel>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {Object.keys(form.products).map((key) => {
              const known = PRODUCTS.find((x) => x.key === key);
              return (
                <label key={key} htmlFor={`prod-${key}`}
                       className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    id={`prod-${key}`}
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer rounded border border-line accent-brand-500
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                    checked={Boolean(form.products[key])}
                    onChange={(e) => setProduct(key, e.target.checked)}
                  />
                  <span className="capitalize">{known?.label ?? key}</span>
                  {known?.soon && <span className="text-[11px] text-ink-muted">(soon)</span>}
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ConfirmDeleteModal({
  plan, deleting, error, onClose, onConfirm,
}: {
  plan: PlanRow;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Delete plan"
      busy={deleting}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete plan'}
          </Button>
        </>
      }
    >
      <p className="m-0 text-sm text-ink">
        Delete <strong className="font-semibold">{plan.name}</strong>? This cannot be undone.
      </p>
      {/* The dialog stays open on failure: the server's reason is the useful
          part, and reopening to read it would be busywork. */}
      {error && <Alert tone="danger" className="mb-0 mt-3">{error}</Alert>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <i className="ri-checkbox-circle-line text-ok" aria-hidden="true" style={{ marginTop: 1 }} />
      <span className="text-ink-muted">{children}</span>
    </li>
  );
}
