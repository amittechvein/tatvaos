'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { Button, Card, Empty, Spinner } from '@/components/ui/Kit';
import { Field, Input, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { ApplicationActions, OutcomeBadge, type Outcome, type Stage } from '../_components/ApplicationActions';
import { CandidateForm, SOURCE_LABEL, type Candidate } from '../_components/CandidateForm';

// ============================================================================
//  One candidate: their applications first (what a recruiter came to do),
//  then their details.
//
//  A hiring manager sees only the applications to their own jobs and the
//  details read-only; the API sends only what they may see, and says whether
//  they may edit or erase.
//
//  ERASE is the DPDP "delete my data" answer: the person, every application
//  and all their history go, and the audit trail keeps only that it happened.
//  The dialog says exactly that before anyone confirms.
// ============================================================================

interface Application {
  id: string;
  jobId: string;
  jobTitle: string | null;
  jobStatus: string | null;
  stageId: string;
  stage: string | null;
  outcome: Outcome;
  rejectionReason: string | null;
  appliedAt: string;
}

interface Detail { candidate: Candidate; applications: Application[]; canEdit: boolean; canErase: boolean }
interface OpenJob { id: string; title: string; status: string }

function CandidatePage() {
  const { authedFetch } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created') === '1';

  const [detail, setDetail] = useState<Detail | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [notice, setNotice] = useState<string | null>(created ? 'Candidate added.' : null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [applying, setApplying] = useState(false);
  const [erasing, setErasing] = useState(false);

  const load = useCallback(async () => {
    const [d, s] = await Promise.all([authedFetch(`/hire/candidates/${id}`), authedFetch('/hire/pipeline')]);
    if (d.status === 404) { setNotFound(true); return; }
    if (d.ok) setDetail(await d.json());
    if (s.ok) setStages(await s.json());
  }, [authedFetch, id]);

  useEffect(() => { void load(); }, [load]);

  async function save(payload: Record<string, unknown>) {
    setSaving(true);
    setFormError(null);
    try {
      const res = await authedFetch(`/hire/candidates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setNotice('Changes saved.');
      await load();
      setFormKey((k) => k + 1);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <>
        <PageHeader title="Candidate not found" breadcrumb={[{ label: 'Candidates', href: '/hire/candidates' }]} />
        <Alert tone="warn">They may have been erased, or they have not applied to a job you manage.</Alert>
      </>
    );
  }
  if (!detail) return <Spinner />;
  const c = detail.candidate;

  return (
    <>
      <PageHeader
        title={c.fullName}
        subtitle={[c.currentDesignation, c.currentCompany].filter(Boolean).join(', ') || SOURCE_LABEL[c.source]}
        breadcrumb={[{ label: 'Candidates', href: '/hire/candidates' }, { label: c.fullName }]}
        actions={
          <div className="flex flex-wrap gap-2">
            {detail.canErase && <Button variant="ghost" onClick={() => setErasing(true)}>Erase…</Button>}
            {detail.canEdit && <Button variant="primary" onClick={() => setApplying(true)}>Put forward for a job</Button>}
          </div>
        }
      />
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Card title="Applications" padded={detail.applications.length > 0} className="mb-5">
        {detail.applications.length === 0 ? (
          <Empty title="Not put forward for any job yet"
                 action={detail.canEdit ? <Button onClick={() => setApplying(true)}>Put forward for a job</Button> : undefined} />
        ) : (
          <ul className="divide-y divide-line">
            {detail.applications.map((a) => {
              const jobOpen = a.jobStatus === 'open' || a.jobStatus === 'on_hold';
              return (
                <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Link href={`/hire/jobs/${a.jobId}/pipeline`} className="font-medium text-ink hover:underline">
                      {a.jobTitle ?? 'Job'}
                    </Link>
                    <span className="text-sm text-ink-muted">· {a.stage}</span>
                    <OutcomeBadge outcome={a.outcome} />
                    {!jobOpen && <span className="text-xs text-ink-muted">(job closed)</span>}
                  </div>
                  {a.outcome === 'rejected' && a.rejectionReason && (
                    <p className="mb-2 whitespace-pre-wrap text-[0.8125rem] text-ink-muted">Reason: {a.rejectionReason}</p>
                  )}
                  <ApplicationActions applicationId={a.id} stageId={a.stageId} outcome={a.outcome}
                                      stages={stages} jobOpen={jobOpen} onChanged={() => void load()} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <CandidateForm key={formKey} candidate={c} submitLabel="Save changes" busy={saving} error={formError}
                     readOnly={!detail.canEdit} onSubmit={(p) => void save(p)} />

      {applying && (
        <ApplyDialog candidateId={id} already={detail.applications.map((a) => a.jobId)}
                     onClose={() => setApplying(false)}
                     onDone={async () => { setApplying(false); setNotice('Put forward.'); await load(); }} />
      )}

      {erasing && (
        <EraseDialog name={c.fullName} applications={detail.applications.length} candidateId={id}
                     onClose={() => setErasing(false)} onDone={() => router.push('/hire/candidates')} />
      )}
    </>
  );
}

function ApplyDialog({ candidateId, already, onClose, onDone }: {
  candidateId: string; already: string[]; onClose: () => void; onDone: () => void;
}) {
  const { authedFetch } = useAuth();
  const [jobs, setJobs] = useState<OpenJob[] | null>(null);
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await authedFetch('/hire/jobs?status=all');
      const body = res.ok ? await res.json() : { jobs: [] };
      setJobs(body.jobs as OpenJob[]);
    })();
  }, [authedFetch]);

  // Filtered at render, not in the effect: the effect would otherwise depend
  // on `already`, a fresh array on every parent render, and refetch each time.
  const choices = jobs?.filter((j) => (j.status === 'open' || j.status === 'on_hold') && !already.includes(j.id)) ?? null;

  async function apply() {
    setBusy(true);
    setError(null);
    const res = await authedFetch('/hire/applications', { method: 'POST', body: JSON.stringify({ candidateId, jobId }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? 'Could not save.'); setBusy(false); return; }
    onDone();
  }

  return (
    <Modal title="Put forward for a job" subtitle="They start at the first stage of the pipeline." busy={busy} onClose={onClose}
           footer={
             <>
               <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
               <Button variant="primary" onClick={() => void apply()} disabled={busy || !jobId}>Put forward</Button>
             </>
           }>
      {error && <Alert tone="danger">{error}</Alert>}
      {choices === null ? <Spinner /> : choices.length === 0 ? (
        <Alert tone="info">No open job to put them forward for. Publish a job opening first.</Alert>
      ) : (
        <Field label="Job opening" required>
          {(p) => (
            <Select {...p} value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Choose…</option>
              {choices.map((j) => <option key={j.id} value={j.id}>{j.title}{j.status === 'on_hold' ? ' (on hold)' : ''}</option>)}
            </Select>
          )}
        </Field>
      )}
    </Modal>
  );
}

function EraseDialog({ name, applications, candidateId, onClose, onDone }: {
  name: string; applications: number; candidateId: string; onClose: () => void; onDone: () => void;
}) {
  const { authedFetch } = useAuth();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function erase() {
    setBusy(true);
    const res = await authedFetch(`/hire/candidates/${candidateId}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? 'Could not erase.'); setBusy(false); return; }
    onDone();
  }

  return (
    <Modal title={`Erase ${name}?`} busy={busy} onClose={onClose}
           footer={
             <>
               <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
               <Button variant="danger" onClick={() => void erase()} disabled={busy || typed.trim() !== 'ERASE'}>Erase for good</Button>
             </>
           }>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-[0.8125rem] text-ink-muted">
        This removes {name}, {applications === 1 ? 'their application' : `all ${applications} of their applications`} and
        every stage change and rejection reason recorded about them. It cannot be undone. The audit trail keeps only
        that a candidate was erased, and by whom — not who they were.
      </p>
      <p className="mb-2 text-[0.8125rem] text-ink-muted">Use this when someone asks for their data to be deleted, or for a profile added by mistake.</p>
      <Field label='Type ERASE to confirm'>
        {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
      </Field>
    </Modal>
  );
}

export default function CandidateDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CandidatePage />
    </Suspense>
  );
}
