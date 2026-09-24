'use client';

import { useState } from 'react';

import { Button, Card } from '@/components/ui/Kit';
import { Field, FormActions, Input, Select, Switch, Textarea } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

// ============================================================================
//  The job opening form — shared by New and the job's own page.
//
//  Everything is sent on every save (the API is a full replacement), so
//  clearing a field clears it. The three long fields are PLAIN TEXT: they
//  will be shown to strangers on the careers page, and the hint says so, so
//  nobody pastes HTML and expects it to render.
// ============================================================================

export interface JobOptions {
  departments: { id: string; name: string }[];
  designations: { id: string; title: string; isActive: boolean }[];
  locations: { id: string; name: string; isRemote: boolean; isActive: boolean }[];
  people: { id: string; displayName: string; email: string }[];
  employmentTypes: string[];
}

export interface Job {
  id: string;
  title: string;
  slug: string;
  status: 'draft' | 'open' | 'on_hold' | 'closed';
  closedReason: 'filled' | 'cancelled' | null;
  departmentId: string | null;
  designationId: string | null;
  locationId: string | null;
  employmentType: string;
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  qualification: string | null;
  skills: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: 'year' | 'month';
  showSalary: boolean;
  vacancies: number;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
  hiringManagerId: string | null;
  recruiterId: string | null;
  openingDate: string | null;
  closingDate: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  canDelete: boolean;
}

export const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};

const num = (s: string) => (s.trim() === '' ? null : Number(s));
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function JobForm({ job, options, submitLabel, busy, error, onSubmit, onCancel }: {
  job: Job | null;
  options: JobOptions;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(job?.title ?? '');
  const [departmentId, setDepartmentId] = useState(job?.departmentId ?? '');
  const [designationId, setDesignationId] = useState(job?.designationId ?? '');
  const [locationId, setLocationId] = useState(job?.locationId ?? '');
  const [employmentType, setEmploymentType] = useState(job?.employmentType ?? 'full_time');
  const [vacancies, setVacancies] = useState(str(job?.vacancies ?? 1));
  const [expMin, setExpMin] = useState(str(job?.experienceMinYears));
  const [expMax, setExpMax] = useState(str(job?.experienceMaxYears));
  const [qualification, setQualification] = useState(job?.qualification ?? '');
  const [skills, setSkills] = useState((job?.skills ?? []).join(', '));
  const [salaryMin, setSalaryMin] = useState(str(job?.salaryMin));
  const [salaryMax, setSalaryMax] = useState(str(job?.salaryMax));
  const [salaryCurrency, setSalaryCurrency] = useState(job?.salaryCurrency ?? 'INR');
  const [salaryPeriod, setSalaryPeriod] = useState(job?.salaryPeriod ?? 'year');
  const [showSalary, setShowSalary] = useState(job?.showSalary ?? false);
  const [description, setDescription] = useState(job?.description ?? '');
  const [responsibilities, setResponsibilities] = useState(job?.responsibilities ?? '');
  const [requirements, setRequirements] = useState(job?.requirements ?? '');
  const [hiringManagerId, setHiringManagerId] = useState(job?.hiringManagerId ?? '');
  const [recruiterId, setRecruiterId] = useState(job?.recruiterId ?? '');
  const [openingDate, setOpeningDate] = useState(job?.openingDate ?? '');
  const [closingDate, setClosingDate] = useState(job?.closingDate ?? '');

  // An archived location or title is offered only when this job already
  // names it — so editing an older job does not silently drop its location,
  // and a new job cannot pick one that has been retired.
  const locations = options.locations.filter((l) => l.isActive || l.id === job?.locationId);
  const designations = options.designations.filter((d) => d.isActive || d.id === job?.designationId);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      title,
      departmentId: departmentId || null,
      designationId: designationId || null,
      locationId: locationId || null,
      employmentType,
      vacancies: num(vacancies),
      experienceMinYears: num(expMin),
      experienceMaxYears: num(expMax),
      qualification,
      skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
      salaryMin: num(salaryMin),
      salaryMax: num(salaryMax),
      salaryCurrency,
      salaryPeriod,
      showSalary,
      description,
      responsibilities,
      requirements,
      hiringManagerId: hiringManagerId || null,
      recruiterId: recruiterId || null,
      openingDate: openingDate || null,
      closingDate: closingDate || null,
    });
  }

  const noLocations = options.locations.filter((l) => l.isActive).length === 0;

  return (
    <form onSubmit={submit} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <Card title="The role" className="mb-5">
        <Field label="Job title" required>
          {(p) => (
            <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)}
                   maxLength={150} required placeholder="Senior Software Engineer" />
          )}
        </Field>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Location" required
                 hint={noLocations ? 'No locations yet — add them under Organisation → People → Locations.' : 'Needed before the job can be published.'}>
            {(p) => (
              <Select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Choose…</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}{l.isActive ? '' : ' (archived)'}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Employment type">
            {(p) => (
              <Select {...p} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
                {options.employmentTypes.map((t) => (
                  <option key={t} value={t}>{EMPLOYMENT_LABEL[t] ?? t}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Designation">
            {(p) => (
              <Select {...p} value={designationId} onChange={(e) => setDesignationId(e.target.value)}>
                <option value="">None</option>
                {designations.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}{d.isActive ? '' : ' (archived)'}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Department">
            {(p) => (
              <Select {...p} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">None</option>
                {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Vacancies">
            {(p) => (
              <Input {...p} type="number" min={1} max={10000} value={vacancies}
                     onChange={(e) => setVacancies(e.target.value)} />
            )}
          </Field>
        </div>
      </Card>

      <Card title="Description" subtitle="Plain text — shown exactly as typed on the careers page" className="mb-5">
        <Field label="About the role" required hint="Needed before the job can be published.">
          {(p) => (
            <Textarea {...p} rows={6} value={description} maxLength={20000}
                      onChange={(e) => setDescription(e.target.value)} />
          )}
        </Field>
        <Field label="Responsibilities">
          {(p) => (
            <Textarea {...p} rows={5} value={responsibilities} maxLength={20000}
                      onChange={(e) => setResponsibilities(e.target.value)} />
          )}
        </Field>
        <Field label="Requirements">
          {(p) => (
            <Textarea {...p} rows={5} value={requirements} maxLength={20000}
                      onChange={(e) => setRequirements(e.target.value)} />
          )}
        </Field>
      </Card>

      <Card title="Who you are looking for" className="mb-5">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Experience from (years)">
            {(p) => <Input {...p} type="number" min={0} max={60} value={expMin} onChange={(e) => setExpMin(e.target.value)} />}
          </Field>
          <Field label="Experience to (years)">
            {(p) => <Input {...p} type="number" min={0} max={60} value={expMax} onChange={(e) => setExpMax(e.target.value)} />}
          </Field>
        </div>
        <Field label="Qualification">
          {(p) => (
            <Input {...p} value={qualification} maxLength={300} placeholder="B.Tech or equivalent"
                   onChange={(e) => setQualification(e.target.value)} />
          )}
        </Field>
        <Field label="Skills" hint="Separate with commas, such as React, SQL, Communication">
          {(p) => <Input {...p} value={skills} onChange={(e) => setSkills(e.target.value)} />}
        </Field>
      </Card>

      <Card title="Pay" className="mb-5">
        <div className="grid gap-x-4 sm:grid-cols-4">
          <Field label="From">
            {(p) => <Input {...p} type="number" min={0} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} />}
          </Field>
          <Field label="To">
            {(p) => <Input {...p} type="number" min={0} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} />}
          </Field>
          <Field label="Currency">
            {(p) => (
              <Input {...p} value={salaryCurrency} maxLength={3}
                     onChange={(e) => setSalaryCurrency(e.target.value.toUpperCase())} />
            )}
          </Field>
          <Field label="Per">
            {(p) => (
              <Select {...p} value={salaryPeriod} onChange={(e) => setSalaryPeriod(e.target.value as 'year' | 'month')}>
                <option value="year">Year</option>
                <option value="month">Month</option>
              </Select>
            )}
          </Field>
        </div>
        <Switch label="Show the pay range on the careers page"
                hint="Off by default. Candidates see it only if you switch this on."
                checked={showSalary} onChange={(e) => setShowSalary(e.target.checked)} />
      </Card>

      <Card title="People and dates" className="mb-5">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Hiring manager">
            {(p) => (
              <Select {...p} value={hiringManagerId} onChange={(e) => setHiringManagerId(e.target.value)}>
                <option value="">None</option>
                {options.people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Recruiter">
            {(p) => (
              <Select {...p} value={recruiterId} onChange={(e) => setRecruiterId(e.target.value)}>
                <option value="">None</option>
                {options.people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Opening date" hint="Left empty, it becomes the day you publish.">
            {(p) => <Input {...p} type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />}
          </Field>
          <Field label="Closing date" hint="Optional. Last day to apply.">
            {(p) => <Input {...p} type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} />}
          </Field>
        </div>
      </Card>

      <FormActions>
        {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </FormActions>
    </form>
  );
}
