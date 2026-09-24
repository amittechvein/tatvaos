'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Empty, Spinner } from '@/components/ui/Kit';
import { Field, Input, Select, Switch } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { ApplicationActions, OutcomeBadge, type Outcome, type Stage } from '../../../candidates/_components/ApplicationActions';
import { StatusBadge, type JobStatus } from '../../_components/JobStatus';

// ============================================================================
//  A job's pipeline — every application to it, grouped by stage.
//
//  A list per stage rather than drag-and-drop columns: twelve stages do not
//  fit side by side on a laptop, let alone a phone, and a stage dropdown on
//  each person is the same action with nothing to miss. Rejected and
//  withdrawn people are hidden until asked for, not deleted.
// ============================================================================

interface Row {
  id: string;
  candidateId: string;
  stageId: string;
  outcome: Outcome;
  rejectionReason: string | null;
  stageChangedAt: string;
  candidate: { fullName: string; currentCompany: string | null; currentDesignation: string | null } | null;
}

interface Board {
  job: { id: string; title: string; status: JobStatus };
  canManage: boolean;
  canAdd: boolean;
  stages: Stage[];
  applications: Row[];
}

export default function JobPipelinePage() {
  const { authedFetch } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<Board | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch(`/hire/jobs/${id}/applications`);
    if (res.status === 404) { setNotFound(true); return; }
    if (res.ok) setBoard(await res.json());
  }, [authedFetch, id]);

  useEffect(() => { void load(); }, [load]);

  if (notFound) {
    return (
      <>
        <PageHeader title="Job opening not found" breadcrumb={[{ label: 'Job openings', href: '/hire/jobs' }]} />
        <Alert tone="warn">It may have been deleted, or it is not one of the jobs you manage.</Alert>
      </>
    );
  }
  if (!board) return <Spinner />;

  const jobOpen = board.job.status === 'open' || board.job.status === 'on_hold';
  const active = board.applications.filter((a) => a.outcome === 'active');
  const ended = board.applications.filter((a) => a.outcome !== 'active');

  return (
    <>
      <PageHeader
        title={`Pipeline — ${board.job.title}`}
        breadcrumb={[{ label: 'Job openings', href: '/hire/jobs' }, { label: board.job.title, href: `/hire/jobs/${id}` }, { label: 'Pipeline' }]}
        actions={board.canAdd ? <Button variant="primary" onClick={() => setAdding(true)}>Add a candidate</Button> : undefined}
      />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
        <StatusBadge status={board.job.status} />
        <span>{active.length} in progress · {ended.length} rejected or withdrawn</span>
      </div>
      {!jobOpen && (
        <Alert tone="info">This job is {board.job.status === 'draft' ? 'a draft' : 'closed'}, so its pipeline is kept as it was.</Alert>
      )}

      {board.applications.length === 0 ? (
        <Card><Empty title="Nobody has applied yet"
                     hint={board.canAdd ? 'Put forward someone from your candidates.' : undefined}
                     action={board.canAdd ? <Button onClick={() => setAdding(true)}>Add a candidate</Button> : undefined} /></Card>
      ) : (
        <>
          {board.stages.map((s) => {
            const here = active.filter((a) => a.stageId === s.id);
            if (here.length === 0) return null;
            return (
              <Card key={s.id} title={`${s.name} (${here.length})`} className="mb-4">
                <ul className="divide-y divide-line">
                  {here.map((a) => <PersonRow key={a.id} a={a} stages={board.stages} jobOpen={jobOpen} canManage={board.canManage} onChanged={load} />)}
                </ul>
              </Card>
            );
          })}
          {active.length === 0 && <Alert tone="info">Nobody is in progress for this job.</Alert>}

          {ended.length > 0 && (
            <Switch label={`Show rejected and withdrawn (${ended.length})`} checked={showClosed}
                    onChange={(e) => setShowClosed(e.target.checked)} />
          )}
          {showClosed && ended.length > 0 && (
            <Card title="Rejected or withdrawn" className="mb-4">
              <ul className="divide-y divide-line">
                {ended.map((a) => <PersonRow key={a.id} a={a} stages={board.stages} jobOpen={jobOpen} canManage={board.canManage} onChanged={load} />)}
              </ul>
            </Card>
          )}
        </>
      )}

      {adding && (
        <AddDialog jobId={id} already={board.applications.map((a) => a.candidateId)}
                   onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await load(); }} />
      )}
    </>
  );
}

function PersonRow({ a, stages, jobOpen, canManage, onChanged }: {
  a: Row; stages: Stage[]; jobOpen: boolean; canManage: boolean; onChanged: () => void;
}) {
  const stageName = stages.find((s) => s.id === a.stageId)?.name;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Link href={`/hire/candidates/${a.candidateId}`} className="font-medium text-ink hover:underline">
          {a.candidate?.fullName ?? 'Candidate'}
        </Link>
        {a.candidate && (a.candidate.currentDesignation || a.candidate.currentCompany) && (
          <span className="text-sm text-ink-muted">
            {[a.candidate.currentDesignation, a.candidate.currentCompany].filter(Boolean).join(', ')}
          </span>
        )}
        {a.outcome !== 'active' && <><OutcomeBadge outcome={a.outcome} /><span className="text-xs text-ink-muted">at {stageName}</span></>}
      </div>
      {a.outcome === 'rejected' && a.rejectionReason && (
        <p className="mb-2 whitespace-pre-wrap text-[0.8125rem] text-ink-muted">Reason: {a.rejectionReason}</p>
      )}
      {canManage && (
        <ApplicationActions applicationId={a.id} stageId={a.stageId} outcome={a.outcome}
                            stages={stages} jobOpen={jobOpen} onChanged={onChanged} />
      )}
    </li>
  );
}

function AddDialog({ jobId, already, onClose, onDone }: {
  jobId: string; already: string[]; onClose: () => void; onDone: () => void;
}) {
  const { authedFetch } = useAuth();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; fullName: string; email: string | null; phone: string | null }[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        const res = await authedFetch(`/hire/candidates${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
        if (res.ok) setFound(await res.json());
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [authedFetch, q]);

  const choices = found.filter((c) => !already.includes(c.id));

  async function add() {
    setBusy(true);
    setError(null);
    const res = await authedFetch('/hire/applications', { method: 'POST', body: JSON.stringify({ candidateId, jobId }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? 'Could not save.'); setBusy(false); return; }
    onDone();
  }

  return (
    <Modal title="Add a candidate to this job" busy={busy} onClose={onClose}
           footer={
             <>
               <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
               <Button variant="primary" onClick={() => void add()} disabled={busy || !candidateId}>Add</Button>
             </>
           }>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Find a candidate">
        {(p) => <Input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone" autoFocus />}
      </Field>
      <Field label="Candidate" required hint="Not listed? Add them under Candidates first.">
        {(p) => (
          <Select {...p} value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.fullName} — {c.email ?? c.phone}</option>)}
          </Select>
        )}
      </Field>
    </Modal>
  );
}
