'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button } from '@/components/ui/Kit';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/Form';
import { Field, Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Interviews on one application (Phase 2; InterviewEndpoints.cs).
//
//  WHAT THE SCREEN PROMISES, CHECKED AGAINST THE CODE:
//    * "Only recruiters and administrators schedule" — the API answers 403 to
//      anyone else; this component shows the buttons only when canSchedule.
//    * "The panel is people who can already see this application" — the
//      panel choices come from /panel-options, the same rule the API checks.
//    * "You will see colleagues' feedback once you have given yours" — the
//      API leaves it out of the response until then (feedbackHidden counts it).
// ============================================================================

interface Feedback { interviewerId: string; name: string | null; rating: number; recommendation: string; notes: string | null; submittedAt: string }
interface Interview {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  mode: 'in_person' | 'video' | 'phone';
  place: string | null;
  status: 'scheduled' | 'cancelled';
  cancelReason: string | null;
  panel: { userId: string; name: string | null }[];
  feedback: Feedback[];
  feedbackGiven: number;
  feedbackHidden: number;
  youAreOnPanel: boolean;
}

const MODE: Record<Interview['mode'], string> = { in_person: 'In person', video: 'Video', phone: 'Phone' };
const RECO: Record<string, string> = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function Interviews({ applicationId, canSchedule, open }: {
  applicationId: string;
  /** Recruiters and administrators (the candidate page's canEdit). */
  canSchedule: boolean;
  /** The application is active and its job open or on hold. */
  open: boolean;
}) {
  const { authedFetch, user } = useAuth();
  const [rows, setRows] = useState<Interview[] | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<Interview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authedFetch(`/hire/applications/${applicationId}/interviews`);
    setRows(res.ok ? await res.json() : []);
  }, [authedFetch, applicationId]);

  useEffect(() => { void load(); }, [load]);

  async function cancel(iv: Interview) {
    const res = await authedFetch(`/hire/interviews/${iv.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Could not cancel.');
    await load();
  }

  if (rows === null) return null;
  if (rows.length === 0 && !(canSchedule && open)) return null;

  return (
    <div className="mt-3 rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[0.8125rem] font-semibold text-ink">Interviews</span>
        {canSchedule && open && <Button size="sm" onClick={() => setScheduling(true)}>Schedule interview</Button>}
      </div>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {rows.length === 0 && <p className="text-[0.8125rem] text-ink-muted">None scheduled yet.</p>}
      <ul className="space-y-3">
        {rows.map((iv) => {
          const mine = iv.feedback.find((f) => f.interviewerId === user?.id);
          return (
            <li key={iv.id} className="text-[0.8125rem]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{when(iv.scheduledAt)}</span>
                <span className="text-ink-muted">· {iv.durationMinutes} min · {MODE[iv.mode]}{iv.place ? ` · ${iv.place}` : ''}</span>
                {iv.status === 'cancelled' && <Badge tone="neutral">Cancelled</Badge>}
              </div>
              <div className="text-ink-muted">Panel: {iv.panel.map((p) => p.name ?? 'Someone').join(', ')}</div>
              {iv.status === 'cancelled' && iv.cancelReason && <div className="text-ink-muted">Why: {iv.cancelReason}</div>}

              {iv.feedback.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {iv.feedback.map((f) => (
                    <li key={f.interviewerId} className="rounded bg-canvas px-2 py-1">
                      <span className="font-medium text-ink">{f.name ?? 'Someone'}</span>: {f.rating}/5, {RECO[f.recommendation] ?? f.recommendation}
                      {f.notes && <div className="whitespace-pre-wrap text-ink-muted">{f.notes}</div>}
                    </li>
                  ))}
                </ul>
              )}
              {iv.feedbackHidden > 0 && (
                <p className="mt-1 text-xs text-ink-muted">
                  {iv.feedbackHidden} colleague{iv.feedbackHidden === 1 ? ' has' : 's have'} given feedback. You will see it once you have given
                  yours, so your view is your own.
                </p>
              )}

              {iv.status === 'scheduled' && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {iv.youAreOnPanel && (
                    <Button size="sm" variant="primary" onClick={() => setFeedbackFor(iv)}>
                      {mine ? 'Change my feedback' : 'Give my feedback'}
                    </Button>
                  )}
                  {canSchedule && open && <Button size="sm" variant="ghost" onClick={() => void cancel(iv)}>Cancel interview</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {scheduling && (
        <ScheduleDialog applicationId={applicationId} onClose={() => setScheduling(false)}
                        onDone={() => { setScheduling(false); void load(); }} />
      )}
      {feedbackFor && (
        <FeedbackDialog interview={feedbackFor} mine={feedbackFor.feedback.find((f) => f.interviewerId === user?.id)}
                        onClose={() => setFeedbackFor(null)} onDone={() => { setFeedbackFor(null); void load(); }} />
      )}
    </div>
  );
}

function ScheduleDialog({ applicationId, onClose, onDone }: { applicationId: string; onClose: () => void; onDone: () => void }) {
  const { authedFetch } = useAuth();
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [at, setAt] = useState('');
  const [duration, setDuration] = useState('60');
  const [mode, setMode] = useState<Interview['mode']>('in_person');
  const [place, setPlace] = useState('');
  const [panel, setPanel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await authedFetch(`/hire/applications/${applicationId}/interviews/panel-options`);
      if (res.ok) setOptions(await res.json());
    })();
  }, [authedFetch, applicationId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // datetime-local is the browser's local time; new Date() reads it as
      // such and toISOString() sends UTC, which the API stores as given.
      const res = await authedFetch(`/hire/applications/${applicationId}/interviews`, {
        method: 'POST',
        body: JSON.stringify({
          scheduledAt: at ? new Date(at).toISOString() : null,
          durationMinutes: Number(duration), mode, place: place.trim() || null, panel: [...panel],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not schedule.');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not schedule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Schedule an interview" onClose={onClose} busy={busy}
           footer={<>
             <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={() => void save()} disabled={busy || !at || panel.size === 0}>Schedule</Button>
           </>}>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <Field label="When" required>
        <Input type="datetime-local" aria-label="When" value={at} onChange={(e) => setAt(e.target.value)} />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="How long">
          <Select aria-label="How long" value={duration} onChange={(e) => setDuration(e.target.value)}>
            {['30', '45', '60', '90', '120'].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </Select>
        </Field>
        <Field label="How">
          <Select aria-label="How" value={mode} onChange={(e) => setMode(e.target.value as Interview['mode'])}>
            <option value="in_person">In person</option>
            <option value="video">Video</option>
            <option value="phone">Phone</option>
          </Select>
        </Field>
      </div>
      <Field label="Where, or the meeting link" hint="Optional. Shown as plain text.">
        <Input aria-label="Where, or the meeting link" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={300} />
      </Field>
      <Field label="Who interviews" required
             hint="Only people who can already see this application: administrators, recruiters and this job's hiring manager.">
        <div className="space-y-1">
          {options.map((o) => (
            <Checkbox key={o.id} id={`panel-${o.id}`} label={o.name} checked={panel.has(o.id)}
                      onChange={(e) => setPanel((s) => { const n = new Set(s); if (e.target.checked) n.add(o.id); else n.delete(o.id); return n; })} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function FeedbackDialog({ interview, mine, onClose, onDone }: {
  interview: Interview; mine?: Feedback; onClose: () => void; onDone: () => void;
}) {
  const { authedFetch } = useAuth();
  const [rating, setRating] = useState(String(mine?.rating ?? ''));
  const [reco, setReco] = useState(mine?.recommendation ?? '');
  const [notes, setNotes] = useState(mine?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/hire/interviews/${interview.id}/feedback`, {
        method: 'PUT', body: JSON.stringify({ rating: Number(rating), recommendation: reco, notes: notes.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Your feedback" subtitle={when(interview.scheduledAt)} onClose={onClose} busy={busy}
           footer={<>
             <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
             <Button variant="primary" onClick={() => void save()} disabled={busy || !rating || !reco}>Save</Button>
           </>}>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Rating" required>
          <Select aria-label="Rating" value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">Choose…</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} — {['', 'Poor', 'Below the bar', 'Mixed', 'Good', 'Excellent'][n]}</option>)}
          </Select>
        </Field>
        <Field label="Recommendation" required>
          <Select aria-label="Recommendation" value={reco} onChange={(e) => setReco(e.target.value)}>
            <option value="">Choose…</option>
            {Object.entries(RECO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notes" hint="Up to 2,000 characters. Deleted with the candidate; never copied into the audit log.">
        <Textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={4} />
      </Field>
    </Modal>
  );
}
