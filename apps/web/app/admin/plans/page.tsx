'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import {
  fetchPlans, createPlan, updatePlan, deletePlan,
  type PlanRow, type UpsertPlanBody,
} from '@/lib/adminData';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { Empty } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';

// Storage is stored in bytes; the form works in GB and converts on the way in
// and out — the same GB convention the onboarding form and org pages use.
const GB = 1024 ** 3;

// Every product a plan can grant, kept in step with RAIL_PRODUCTS in lib/nav.
// This list being short is not cosmetic: a plan that includes Sheet, with no
// Sheet checkbox to reflect it, would lose Sheet the moment anyone pressed Save.
const PRODUCTS: { key: string; label: string; soon?: boolean }[] = [
  { key: 'mail', label: 'Mail' },
  { key: 'drive', label: 'Drive', soon: true },
  { key: 'people', label: 'People', soon: true },
  { key: 'payroll', label: 'Payroll', soon: true },
  { key: 'sheet', label: 'Sheet', soon: true },
  { key: 'word', label: 'Word', soon: true },
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

  // Escape closes whichever dialog is open — except mid-save, where it would
  // leave the operator unsure whether the write went through.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || saving || deleting) return;
      setForm(null);
      setToDelete(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, deleting]);

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

  return (
    <AdminShell
      scope="platform"
      title="Plans"
      subtitle="The catalogue every organisation is billed against"
      actions={
        <button type="button" className="btn btn-primary" onClick={openAdd}>
          <i className="ri-add-line me-1" /> Add plan
        </button>
      }
    >
      {notice && (
        <div className={`alert alert-${notice.kind} d-flex align-items-center justify-content-between`} role="alert">
          <span>{notice.text}</span>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setNotice(null)} />
        </div>
      )}

      {loading ? (
        <div className="card custom-card"><div className="card-body"><Empty title="Loading…" /></div></div>
      ) : plans.length === 0 ? (
        <div className="card custom-card">
          <div className="card-body">
            <Empty
              title="No plans yet"
              hint="Add the first plan and it becomes assignable from any organisation's Manage dialog."
              action={
                <button type="button" className="btn btn-primary" onClick={openAdd}>
                  <i className="ri-add-line me-1" /> Add plan
                </button>
              }
            />
          </div>
        </div>
      ) : (
        <div className="row">
          {plans.map((p) => (
            <div className="col-xxl-3 col-lg-6 col-md-6" key={p.id}>
              <div className="card custom-card">
                <div className="card-body">
                  <div className="d-flex align-items-center gap-2 mb-3">
                    <span className="avatar avatar-md bg-primary-transparent">
                      <i className="ri-price-tag-3-line fs-18" />
                    </span>
                    <h6 className="fw-semibold mb-0 flex-fill">{p.name}</h6>
                  </div>

                  <div className="mb-3">
                    {p.pricePerUserMonthly ? (
                      <><span className="fs-24 fw-bold">₹{p.pricePerUserMonthly}</span>
                        <span className="text-muted fs-12"> / user / month</span></>
                    ) : p.priceMonthly ? (
                      <><span className="fs-24 fw-bold">₹{p.priceMonthly}</span>
                        <span className="text-muted fs-12"> / month</span></>
                    ) : (
                      <span className="fs-20 fw-semibold text-muted">Custom pricing</span>
                    )}
                  </div>

                  <ul className="list-unstyled fs-13 mb-0">
                    <Feature>{p.maxUsers ? `Up to ${p.maxUsers} people` : 'Unlimited people'}</Feature>
                    <Feature>
                      {p.storageModel === 'pooled'
                        ? `${formatBytes(p.pooledStorageBytes ?? 0)} pooled storage`
                        : `${formatBytes(p.perUserQuotaBytes ?? 0)} per user`}
                    </Feature>
                    <Feature>{p.maxDomains ? `${p.maxDomains} domain${p.maxDomains > 1 ? 's' : ''}` : 'Unlimited domains'}</Feature>
                    <Feature><span className="text-capitalize">{p.includedProducts.join(', ') || 'mail'}</span></Feature>
                  </ul>

                  <div className="d-flex gap-2 mt-3 pt-3 border-top">
                    <button type="button" className="btn btn-sm btn-light flex-fill" onClick={() => openEdit(p)}>
                      <i className="ri-pencil-line me-1" /> Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => { setDeleteError(null); setToDelete(p); }}
                    >
                      <i className="ri-delete-bin-line" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
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
//  Add / Edit
//
//  Rendered as YZEN's modal markup with the backdrop as a sibling, driven by
//  React state rather than Bootstrap's JS — the bundle ships no Bootstrap
//  JavaScript, and `.modal.show.d-block` needs none.
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
    <>
      <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
        <div className="modal-dialog modal-dialog-centered modal-lg" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h6 className="modal-title">{editing ? 'Edit plan' : 'Add plan'}</h6>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>

            <div className="modal-body">
              {editing && (
                <div className="alert alert-warning" role="alert">
                  Changes apply to new growth only — organisations already on this plan keep the
                  limits they were given and are not resized.
                </div>
              )}

              {errors.length > 0 && (
                <div className="alert alert-danger" role="alert">
                  <ul className="mb-0 ps-3">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </div>
              )}

              <div className="row g-3">
                <div className="col-12">
                  <label className="form-label" htmlFor="plan-name">Name</label>
                  <Input id="plan-name"  value={form.name} autoFocus
                         placeholder="Business" onChange={(e) => set('name', e.target.value)} />
                </div>

                <div className="col-12">
                  <label className="form-label d-block">Storage model</label>
                  <div className="btn-group w-100" role="group" aria-label="Storage model">
                    <button type="button"
                      className={`btn ${form.storageModel === 'per_user' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => set('storageModel', 'per_user')}>
                      Per-user quota
                    </button>
                    <button type="button"
                      className={`btn ${form.storageModel === 'pooled' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => set('storageModel', 'pooled')}>
                      Pooled
                    </button>
                  </div>
                </div>

                <div className="col-sm-6">
                  {form.storageModel === 'per_user' ? (
                    <>
                      <label className="form-label" htmlFor="plan-per-user">Storage per user (GB)</label>
                      <Input id="plan-per-user" type="number" min={1} 
                             value={form.perUserQuotaGb}
                             onChange={(e) => set('perUserQuotaGb', e.target.value)} />
                    </>
                  ) : (
                    <>
                      <label className="form-label" htmlFor="plan-pooled">Total pooled storage (GB)</label>
                      <Input id="plan-pooled" type="number" min={1} 
                             value={form.pooledStorageGb}
                             onChange={(e) => set('pooledStorageGb', e.target.value)} />
                    </>
                  )}
                </div>

                <div className="col-sm-6">
                  <label className="form-label" htmlFor="plan-seats">Max users</label>
                  <Input id="plan-seats" type="number" min={1} 
                         placeholder="Unlimited" value={form.maxUsers}
                         onChange={(e) => set('maxUsers', e.target.value)} />
                </div>

                <div className="col-sm-6">
                  <label className="form-label" htmlFor="plan-domains">Max domains</label>
                  <Input id="plan-domains" type="number" min={1} 
                         placeholder="Unlimited" value={form.maxDomains}
                         onChange={(e) => set('maxDomains', e.target.value)} />
                </div>

                <div className="col-12">
                  <label className="form-label d-block">Pricing</label>
                  <div className="btn-group w-100 mb-2" role="group" aria-label="Pricing model">
                    <button type="button"
                      className={`btn btn-sm ${form.pricingModel === 'per_user' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => set('pricingModel', 'per_user')}>
                      Per user / month
                    </button>
                    <button type="button"
                      className={`btn btn-sm ${form.pricingModel === 'flat' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => set('pricingModel', 'flat')}>
                      Flat / month
                    </button>
                    <button type="button"
                      className={`btn btn-sm ${form.pricingModel === 'custom' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => set('pricingModel', 'custom')}>
                      Custom
                    </button>
                  </div>
                  {form.pricingModel !== 'custom' && (
                    <div className="input-group">
                      <span className="input-group-text">₹</span>
                      <Input type="number" min={0}  value={form.price}
                             placeholder={form.pricingModel === 'per_user' ? 'per user, per month' : 'per month'}
                             onChange={(e) => set('price', e.target.value)} />
                    </div>
                  )}
                </div>

                <div className="col-12">
                  <label className="form-label d-block">Included products</label>
                  {Object.keys(form.products).map((key) => {
                    const known = PRODUCTS.find((x) => x.key === key);
                    return (
                      <div className="form-check form-check-inline" key={key}>
                        <input className="form-check-input" type="checkbox" id={`prod-${key}`}
                               checked={Boolean(form.products[key])}
                               onChange={(e) => setProduct(key, e.target.checked)} />
                        <label className="form-check-label text-capitalize" htmlFor={`prod-${key}`}>
                          {known?.label ?? key}
                          {known?.soon && <span className="text-muted fs-11"> (soon)</span>}
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-light" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
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
    <>
      <div className="modal fade show d-block" tabIndex={-1} role="dialog" aria-modal="true">
        <div className="modal-dialog modal-dialog-centered" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h6 className="modal-title">Delete plan</h6>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body">
              <p className="mb-0">Delete <strong>{plan.name}</strong>? This cannot be undone.</p>
              {/* The dialog stays open on failure: the server's reason is the
                  useful part, and reopening to read it would be busywork. */}
              {error && <div className="alert alert-danger mt-3 mb-0" role="alert">{error}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-light" onClick={onClose} disabled={deleting}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete plan'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
  );
}

// ---------------------------------------------------------------------------
function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="mb-2 d-flex align-items-start gap-2">
      <i className="ri-checkbox-circle-line text-success" style={{ marginTop: 1 }} />
      <span className="text-muted">{children}</span>
    </li>
  );
}
