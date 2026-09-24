'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { Button, Spinner } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { JobForm, type Job, type JobOptions } from '../_components/JobForm';
import { fmtDate, StatusBadge } from '../_components/JobStatus';

// ============================================================================
//  One job opening: its status and what can be done to it, above the form.
//
//  Status changes are buttons here, never a field in the form, because the
//  API moves status only through its own call (which checks the job is fit
//  to be seen). What each button says matches what it does to the public:
//  "Publish" puts it on the careers page once that exists; "Put on hold"
//  takes it off without closing it.
// ============================================================================

function JobPage() {
  const { authedFetch } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const justCreated = useSearchParams().get('created') === '1';

  const [job, setJob] = useState<Job | null>(null);
  const [options, setOptions] = useState<JobOptions | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(justCreated ? 'Saved as a draft.' : null);
  const [acting, setActing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Remounts the form after a save or status change, so it shows what the
  // server stored rather than what was typed.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    const [j, o] = await Promise.all([
      authedFetch(`/hire/jobs/${id}`),
      authedFetch('/hire/jobs/options'),
    ]);
    if (j.status === 404) { setNotFound(true); return; }
    if (j.ok) setJob(await j.json());
    if (o.ok) setOptions(await o.json());
  }, [authedFetch, id]);

  useEffect(() => { void load(); }, [load]);

  async function save(payload: Record<string, unknown>) {
    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await authedFetch(`/hire/jobs/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setJob(body);
      setFormKey((k) => k + 1);
      // A refusal from an earlier Publish is about the job as it WAS; left
      // up beside "Changes saved" it reads as if the save failed too.
      setActionError(null);
      setNotice('Changes saved.');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function move(status: string, reason?: string) {
    setActing(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await authedFetch(`/hire/jobs/${id}/status`, {
        method: 'POST', body: JSON.stringify({ status, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not change the status.');
      setJob(body);
      setFormKey((k) => k + 1);
      setNotice(status === 'open' ? 'Published.' : status === 'on_hold' ? 'On hold.' : 'Closed.');
      setClosing(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not change the status.');
      setClosing(false);
    } finally {
      setActing(false);
    }
  }

  async function remove() {
    setActing(true);
    try {
      const res = await authedFetch(`/hire/jobs/${id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not delete.');
      router.push('/hire/jobs?status=draft');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete.');
      setDeleting(false);
      setActing(false);
    }
  }

  if (notFound) {
    return (
      <>
        <PageHeader title="Job opening not found" breadcrumb={[{ label: 'Job openings', href: '/hire/jobs' }]} />
        <Alert tone="warn">It may have been deleted, or it belongs to another organisation.</Alert>
      </>
    );
  }
  if (!job || !options) return <Spinner />;

  const actions = (
    <div className="flex flex-wrap gap-2">
      {job.status === 'draft' && (
        <>
          <Button variant="ghost" onClick={() => setDeleting(true)} disabled={acting}>Delete draft</Button>
          <Button variant="primary" onClick={() => void move('open')} disabled={acting}>Publish</Button>
        </>
      )}
      {job.status === 'open' && (
        <>
          <Button onClick={() => void move('on_hold')} disabled={acting}>Put on hold</Button>
          <Button onClick={() => setClosing(true)} disabled={acting}>Close</Button>
        </>
      )}
      {job.status === 'on_hold' && (
        <>
          <Button onClick={() => setClosing(true)} disabled={acting}>Close</Button>
          <Button variant="primary" onClick={() => void move('open')} disabled={acting}>Resume</Button>
        </>
      )}
      {job.status === 'closed' && (
        <Button onClick={() => void move('open')} disabled={acting}>Reopen</Button>
      )}
    </div>
  );

  const facts = [
    job.publishedAt ? `Published ${fmtDate(job.publishedAt.slice(0, 10))}` : 'Never published',
    job.closingDate ? `closes ${fmtDate(job.closingDate)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <PageHeader
        title={job.title}
        breadcrumb={[{ label: 'Job openings', href: `/hire/jobs?status=${job.status}` }, { label: job.title }]}
        actions={actions}
      />

      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
        <StatusBadge status={job.status} reason={job.closedReason} />
        <span>{facts}</span>
      </div>

      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {actionError && <Alert tone="danger" onDismiss={() => setActionError(null)}>{actionError}</Alert>}
      {job.status === 'draft' && (
        <Alert tone="info">
          This is a draft. Publishing needs a description and a location; until then only your
          organisation&apos;s administrators can see it.
        </Alert>
      )}

      <JobForm key={formKey} job={job} options={options} submitLabel="Save changes"
               busy={saving} error={formError} onSubmit={(p) => void save(p)} />

      {closing && (
        <Modal
          title={`Close ${job.title}?`}
          subtitle="It stops taking applications. You can reopen it later."
          busy={acting}
          onClose={() => setClosing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(false)} disabled={acting}>Keep it open</Button>
              <Button onClick={() => void move('closed', 'cancelled')} disabled={acting}>Cancelled</Button>
              <Button variant="primary" onClick={() => void move('closed', 'filled')} disabled={acting}>Filled</Button>
            </>
          }
        >
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            Was the position filled, or is it no longer being recruited for?
          </p>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={`Delete ${job.title}?`}
          busy={acting}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(false)} disabled={acting}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove()} disabled={acting}>Delete draft</Button>
            </>
          }
        >
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            It has never been published, so nobody outside your organisation has seen it. This cannot
            be undone. (A job that has been published can only be closed.)
          </p>
        </Modal>
      )}
    </>
  );
}

export default function JobOpeningPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <JobPage />
    </Suspense>
  );
}
