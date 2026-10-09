'use client';

import { useEffect, useState } from 'react';

import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Field, FormActions, Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import type { Employee } from '../PeopleAccess';

interface Options {
  codeMode: 'auto' | 'manual';
  departments: { id: string; name: string }[];
  designations: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  signIns: { id: string; displayName: string; email: string; linked: boolean }[];
  managers: { id: string; name: string; code: string }[];
}

export interface EmployeeDraft {
  fullName: string;
  workEmail: string;
  userId: string;
  departmentId: string;
  designationId: string;
  locationId: string;
  reportsTo: string;
  employmentType: Employee['employmentType'];
  joinedOn: string;
  employeeCode: string;
  status: 'active' | 'on_notice';
}

export function draftFrom(e?: Employee): EmployeeDraft {
  return {
    fullName: e?.fullName ?? '', workEmail: e?.workEmail ?? '', userId: e?.userId ?? '',
    departmentId: e?.departmentId ?? '', designationId: e?.designationId ?? '', locationId: e?.locationId ?? '',
    reportsTo: e?.reportsTo ?? '', employmentType: e?.employmentType ?? 'full_time',
    joinedOn: e?.joinedOn ?? '', employeeCode: e?.employeeCode ?? '',
    status: e?.status === 'on_notice' ? 'on_notice' : 'active',
  };
}

/** The request body: empty strings become null, as the API expects. */
export function bodyFrom(d: EmployeeDraft, includeCode: boolean) {
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    fullName: d.fullName.trim(), workEmail: n(d.workEmail), userId: n(d.userId),
    departmentId: n(d.departmentId), designationId: n(d.designationId), locationId: n(d.locationId),
    reportsTo: n(d.reportsTo), employmentType: d.employmentType, joinedOn: n(d.joinedOn),
    employeeCode: includeCode ? n(d.employeeCode) : null, status: d.status,
  };
}

/**
 * Add or edit an employee record (People HR only — the API refuses anyone
 * else). The "Reports to" hint says what the field DOES, because it is an
 * access grant (Mr. Singh, 9 Oct): the manager chosen can then see this
 * person's record. The sentence is true of the code — PeopleAccess.VisibleAsync.
 */
export function EmployeeForm({ existing, onSubmit, submitLabel }: {
  existing?: Employee;
  onSubmit: (d: EmployeeDraft, manualCodes: boolean) => Promise<string | null>;
  submitLabel: string;
}) {
  const { authedFetch } = useAuth();
  const [opt, setOpt] = useState<Options | null>(null);
  const [d, setD] = useState<EmployeeDraft>(draftFrom(existing));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await authedFetch('/people/options');
      if (res.ok) setOpt(await res.json());
      else setError('Could not load the choices for this form.');
    })();
  }, [authedFetch]);

  const set = <K extends keyof EmployeeDraft>(k: K, v: EmployeeDraft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await onSubmit(d, opt?.codeMode === 'manual');
    if (err) setError(err);
    setBusy(false);
  }

  if (!opt) return error ? <Alert tone="danger">{error}</Alert> : <Spinner />;

  const managers = opt.managers.filter((m) => m.id !== existing?.id);
  const signIns = opt.signIns.filter((s) => !s.linked || s.id === existing?.userId);

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card title="Who they are" className="mb-5">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Full name" required>
            {(p) => <Input {...p} value={d.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={200} required />}
          </Field>
          <Field label="Work email">
            {(p) => <Input {...p} type="email" value={d.workEmail} onChange={(e) => set('workEmail', e.target.value)} maxLength={320} />}
          </Field>
          {existing ? (
            <Field label="Employee ID" hint="Never changes once given.">
              {(p) => <Input {...p} value={d.employeeCode} disabled />}
            </Field>
          ) : opt.codeMode === 'manual' ? (
            <Field label="Employee ID" required hint="Your organisation types employee IDs by hand.">
              {(p) => <Input {...p} value={d.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} maxLength={30} required />}
            </Field>
          ) : (
            <Field label="Employee ID" hint="Given automatically from your organisation's scheme when you save.">
              {(p) => <Input {...p} value="" placeholder="Automatic" disabled />}
            </Field>
          )}
          <Field label="Sign-in" hint="Optional. Some staff never sign in to TatvaOS; link one if they do, so they can see their record.">
            {(p) => (
              <Select {...p} value={d.userId} onChange={(e) => set('userId', e.target.value)}>
                <option value="">No sign-in</option>
                {signIns.map((s) => <option key={s.id} value={s.id}>{s.displayName} — {s.email}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card title="Their work" className="mb-5">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Reports to"
                 hint="Their manager can see this person's record, and the records of everyone who reports to them. Changing it is recorded.">
            {(p) => (
              <Select {...p} value={d.reportsTo} onChange={(e) => set('reportsTo', e.target.value)}>
                <option value="">Nobody</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
              </Select>
            )}
          </Field>
          <Field label="Joined on" required>
            {(p) => <Input {...p} type="date" value={d.joinedOn} onChange={(e) => set('joinedOn', e.target.value)} required />}
          </Field>
          <Field label="Department">
            {(p) => (
              <Select {...p} value={d.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">None</option>
                {opt.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Designation">
            {(p) => (
              <Select {...p} value={d.designationId} onChange={(e) => set('designationId', e.target.value)}>
                <option value="">None</option>
                {opt.designations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Location">
            {(p) => (
              <Select {...p} value={d.locationId} onChange={(e) => set('locationId', e.target.value)}>
                <option value="">None</option>
                {opt.locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Employment type">
            {(p) => (
              <Select {...p} value={d.employmentType} onChange={(e) => set('employmentType', e.target.value as EmployeeDraft['employmentType'])}>
                <option value="full_time">Full time</option>
                <option value="part_time">Part time</option>
                <option value="contract">Contract</option>
                <option value="intern">Intern</option>
              </Select>
            )}
          </Field>
          {existing && (
            <Field label="Status" hint="Someone leaving goes through Record leaving, below.">
              {(p) => (
                <Select {...p} value={d.status} onChange={(e) => set('status', e.target.value as EmployeeDraft['status'])}>
                  <option value="active">Active</option>
                  <option value="on_notice">On notice</option>
                </Select>
              )}
            </Field>
          )}
        </div>
      </Card>

      <FormActions>
        <Button variant="ghost" href={existing ? `/people/${existing.id}` : '/people'}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
      </FormActions>
    </form>
  );
}
