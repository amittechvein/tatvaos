'use client';

import { useState } from 'react';

import { Badge, Button } from '@/components/ui/Kit';
import { Field, Select, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  What can be done to one application — shared by the candidate's page and
//  the job's pipeline, so the two cannot drift apart.
//
//  Rejecting asks for a reason, always. The API and the database both refuse
//  a rejection without one; asking here is so nobody meets that refusal as
//  an error. The dialog says why the reason is kept.
// ============================================================================

export interface Stage { id: string; name: string; position: number; isFinal: boolean }

export type Outcome = 'active' | 'rejected' | 'withdrawn';

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  if (outcome === 'active') return <Badge tone="info">In progress</Badge>;
  if (outcome === 'rejected') return <Badge tone="danger">Rejected</Badge>;
  return <Badge>Withdrawn</Badge>;
}

interface HistoryRow { kind: string; from: string | null; to: string | null; reason: string | null; by: string | null; occurredAt: string }

const KIND: Record<string, string> = {
  created: 'Applied', moved: 'Moved', rejected: 'Rejected', withdrawn: 'Withdrew', reopened: 'Reopened',
};

export function ApplicationActions({ applicationId, stageId, outcome, stages, jobOpen, onChanged }: {
  applicationId: string;
  stageId: string;
  outcome: Outcome;
  stages: Stage[];
  /** Open or on hold. A closed job's pipeline is kept as it was. */
  jobOpen: boolean;
  onChanged: () => void;
}) {
  const { authedFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'reject' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/hire/applications/${applicationId}/${path}`, {
        method: 'POST', body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Could not save.');
      setDialog(null);
      setReason('');
      setHistory(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (history) { setHistory(null); return; }
    const res = await authedFetch(`/hire/applications/${applicationId}/history`);
    if (res.ok) setHistory(await res.json());
    else setError('Could not load the history.');
  }

  return (
    <div className="min-w-0">
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        {jobOpen && outcome === 'active' && (
          <>
            <Select aria-label="Move to stage" className="w-auto" value={stageId} disabled={busy}
                    onChange={(e) => void post('move', { stageId: e.target.value })}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('withdraw')}>Withdrew</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setDialog('reject')}>Reject</Button>
          </>
        )}
        {jobOpen && outcome !== 'active' && (
          <Button size="sm" disabled={busy} onClick={() => void post('reopen')}>Reopen</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void toggleHistory()}>
          {history ? 'Hide history' : 'History'}
        </Button>
      </div>

      {history && (
        <ol className="mt-3 space-y-1.5 border-l border-line pl-3 text-[0.8125rem]">
          {history.map((h, i) => (
            <li key={i}>
              <span className="font-medium text-ink">{KIND[h.kind] ?? h.kind}</span>
              {h.kind === 'moved' && h.from && h.to && <span className="text-ink-muted"> {h.from} → {h.to}</span>}
              {h.kind === 'created' && h.to && <span className="text-ink-muted"> at {h.to}</span>}
              {h.reason && <span className="block whitespace-pre-wrap text-ink-muted">“{h.reason}”</span>}
              <span className="block text-xs text-ink-faint">
                {new Date(h.occurredAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                {h.by ? ` · ${h.by}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}

      {dialog && (
        <Modal
          title={dialog === 'reject' ? 'Reject this application?' : 'Mark as withdrawn?'}
          subtitle={dialog === 'reject'
            ? 'The reason is kept with the application, so the decision can be explained later — including to the candidate.'
            : 'For when the candidate stepped back themselves.'}
          busy={busy}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
              <Button variant={dialog === 'reject' ? 'danger' : 'primary'} disabled={busy || (dialog === 'reject' && reason.trim().length < 3)}
                      onClick={() => void post(dialog, { reason })}>
                {dialog === 'reject' ? 'Reject' : 'Mark withdrawn'}
              </Button>
            </>
          }
        >
          <Field label={dialog === 'reject' ? 'Reason' : 'Note (optional)'} required={dialog === 'reject'}
                 hint={dialog === 'reject' ? 'Be specific and fair: what was missing for this role.' : undefined}>
            {(p) => <Textarea {...p} rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
          </Field>
        </Modal>
      )}
    </div>
  );
}
