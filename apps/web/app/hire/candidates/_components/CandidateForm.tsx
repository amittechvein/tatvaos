'use client';

import { useState } from 'react';

import { Button, Card } from '@/components/ui/Kit';
import { Field, FormActions, Input, Select, Textarea } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

// ============================================================================
//  A candidate's details — shared by Add and the candidate's own page.
//
//  Contact and career details only. No identity documents and no files: those
//  come with the careers portal and pre-joining, each after its own review.
//  "Careers page" is not offered as a source — only the portal writes it, so
//  a recruiter can always tell who applied on their own.
// ============================================================================

export interface Candidate {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentLocation: string | null;
  currentCompany: string | null;
  currentDesignation: string | null;
  experienceMonths: number | null;
  education: string | null;
  skills: string[];
  tags: string[];
  expectedSalary: number | null;
  salaryCurrency: string;
  noticePeriodDays: number | null;
  source: string;
  sourceDetail: string | null;
  linkedinUrl: string | null;
  updatedAt: string;
}

export const SOURCE_LABEL: Record<string, string> = {
  careers_page: 'Careers page', referral: 'Referral', linkedin: 'LinkedIn', job_board: 'Job board',
  agency: 'Agency', walk_in: 'Walk-in', other: 'Other',
};
const PICKABLE = ['referral', 'linkedin', 'job_board', 'agency', 'walk_in', 'other'];

const num = (s: string) => (s.trim() === '' ? null : Number(s));
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function CandidateForm({ candidate, submitLabel, busy, error, readOnly, onSubmit, onCancel }: {
  candidate: Candidate | null;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  /** Hiring managers see the details but cannot change them. */
  readOnly?: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel?: () => void;
}) {
  const c = candidate;
  const [fullName, setFullName] = useState(c?.fullName ?? '');
  const [email, setEmail] = useState(c?.email ?? '');
  const [phone, setPhone] = useState(c?.phone ?? '');
  const [currentLocation, setCurrentLocation] = useState(c?.currentLocation ?? '');
  const [currentCompany, setCurrentCompany] = useState(c?.currentCompany ?? '');
  const [currentDesignation, setCurrentDesignation] = useState(c?.currentDesignation ?? '');
  const [years, setYears] = useState(c?.experienceMonths != null ? String(Math.round(c.experienceMonths / 12 * 10) / 10) : '');
  const [education, setEducation] = useState(c?.education ?? '');
  const [skills, setSkills] = useState((c?.skills ?? []).join(', '));
  const [tags, setTags] = useState((c?.tags ?? []).join(', '));
  const [expectedSalary, setExpectedSalary] = useState(str(c?.expectedSalary));
  const [salaryCurrency, setSalaryCurrency] = useState(c?.salaryCurrency ?? 'INR');
  const [noticePeriodDays, setNoticePeriodDays] = useState(str(c?.noticePeriodDays));
  const [source, setSource] = useState(c?.source ?? 'other');
  const [sourceDetail, setSourceDetail] = useState(c?.sourceDetail ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(c?.linkedinUrl ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const y = num(years);
    onSubmit({
      fullName, email, phone, currentLocation, currentCompany, currentDesignation,
      experienceMonths: y === null ? null : Math.round(y * 12),
      education, skills: list(skills), tags: list(tags),
      expectedSalary: num(expectedSalary), salaryCurrency,
      noticePeriodDays: num(noticePeriodDays),
      source, sourceDetail, linkedinUrl,
    });
  }

  const ro = Boolean(readOnly);
  return (
    <form onSubmit={submit} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      <fieldset disabled={ro || busy} className="min-w-0">
        <Card title="Contact" subtitle="An email or a phone number is needed" className="mb-5">
          <Field label="Full name" required>
            {(p) => <Input {...p} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={200} required autoFocus={!c} />}
          </Field>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Email" hint="One candidate per email: someone applying to several roles keeps one profile.">
              {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />}
            </Field>
            <Field label="Phone">
              {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} placeholder="+91 98765 43210" />}
            </Field>
            <Field label="Current location">
              {(p) => <Input {...p} value={currentLocation} onChange={(e) => setCurrentLocation(e.target.value)} maxLength={120} />}
            </Field>
            <Field label="LinkedIn" hint="https:// link">
              {(p) => <Input {...p} value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} maxLength={300} />}
            </Field>
          </div>
        </Card>

        <Card title="Career" className="mb-5">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Current company">
              {(p) => <Input {...p} value={currentCompany} onChange={(e) => setCurrentCompany(e.target.value)} maxLength={150} />}
            </Field>
            <Field label="Current designation">
              {(p) => <Input {...p} value={currentDesignation} onChange={(e) => setCurrentDesignation(e.target.value)} maxLength={150} />}
            </Field>
            <Field label="Experience (years)">
              {(p) => <Input {...p} type="number" min={0} max={60} step={0.5} value={years} onChange={(e) => setYears(e.target.value)} />}
            </Field>
            <Field label="Notice period (days)">
              {(p) => <Input {...p} type="number" min={0} max={365} value={noticePeriodDays} onChange={(e) => setNoticePeriodDays(e.target.value)} />}
            </Field>
            <Field label="Expected salary">
              {(p) => <Input {...p} type="number" min={0} value={expectedSalary} onChange={(e) => setExpectedSalary(e.target.value)} />}
            </Field>
            <Field label="Currency">
              {(p) => <Input {...p} value={salaryCurrency} maxLength={3} onChange={(e) => setSalaryCurrency(e.target.value.toUpperCase())} />}
            </Field>
          </div>
          <Field label="Education">
            {(p) => <Textarea {...p} rows={2} value={education} maxLength={500} onChange={(e) => setEducation(e.target.value)} />}
          </Field>
          <Field label="Skills" hint="Separate with commas">
            {(p) => <Input {...p} value={skills} onChange={(e) => setSkills(e.target.value)} />}
          </Field>
          <Field label="Tags" hint="Your own labels, separated with commas">
            {(p) => <Input {...p} value={tags} onChange={(e) => setTags(e.target.value)} />}
          </Field>
        </Card>

        <Card title="Where they came from" className="mb-5">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Source">
              {(p) => (
                <Select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
                  {/* An existing careers-page candidate keeps that label; nobody can pick it. */}
                  {c?.source === 'careers_page' && <option value="careers_page">Careers page</option>}
                  {PICKABLE.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Detail" hint="Who referred them, which agency or board">
              {(p) => <Input {...p} value={sourceDetail} onChange={(e) => setSourceDetail(e.target.value)} maxLength={200} />}
            </Field>
          </div>
        </Card>
      </fieldset>

      {!ro && (
        <FormActions>
          {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={busy || !fullName.trim()}>{busy ? 'Saving…' : submitLabel}</Button>
        </FormActions>
      )}
    </form>
  );
}
