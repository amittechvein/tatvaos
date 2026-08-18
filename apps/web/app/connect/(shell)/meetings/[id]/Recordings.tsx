'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import {
  durationLabel, recordingApi, sizeLabel, timeLabel,
  type NotesPayload, type RecordingList, type RecordingListItem, type RecordingStatus,
  type TranscriptStatus,
} from '@/lib/connect';

// ============================================================================
//  Recordings, transcript and notes, for one meeting.
// ============================================================================
//
//  ITS OWN FILE, AND ITS OWN REQUESTS. The meeting page already polls the
//  waiting room; hanging two more endpoints off that load would make every
//  three-second lobby tick fetch a transcript nobody is watching change.
//
//  IT POLLS ONLY WHILE SOMETHING IS ACTUALLY MOVING. A recording being
//  written, a transcript queued or running, notes queued or running — those
//  change on their own and are worth asking about. A finished meeting whose
//  notes are ready is asked about exactly once. The rule is one line
//  (`busy` below) rather than scattered through the component, because the
//  version of this that polls forever is the version that gets written by
//  accident.
//
//  EVERY EMPTY STATE SAYS WHY IT IS EMPTY. "No transcript" is four different
//  situations — recording is not deployed, transcription is not configured,
//  it is still running, it failed — and they need four different sentences.
//  A single "nothing here" would send somebody looking for a bug that is
//  really an unset environment variable.
// ============================================================================

const POLL_MS = 10_000;

const RECORDING_LABEL: Record<RecordingStatus, string> = {
  starting: 'Starting',
  recording: 'Recording',
  processing: 'Finishing',
  ready: 'Ready',
  failed: 'Failed',
  aborted: 'Stopped early',
  deleted: 'Deleted',
};

function recordingTone(s: RecordingStatus) {
  if (s === 'ready') return 'ok' as const;
  if (s === 'failed') return 'danger' as const;
  if (s === 'recording' || s === 'starting') return 'warn' as const;
  return 'neutral' as const;
}

export default function Recordings({ meetingId, isHost, canDelete }: {
  meetingId: string;
  /** Host or cohost: may start, stop, and ask for the notes again. */
  isHost: boolean;
  /** Host only. Deleting a recording is not the same act as stopping one. */
  canDelete: boolean;
}) {
  const { authedFetch } = useAuth();

  const [list, setList] = useState<RecordingList | null>(null);
  const [notes, setNotes] = useState<NotesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, n] = await Promise.all([
        recordingApi.list(authedFetch, meetingId),
        recordingApi.notes(authedFetch, meetingId),
      ]);
      setList(l);
      setNotes(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the recordings.');
    }
  }, [authedFetch, meetingId]);

  useEffect(() => { void load(); }, [load]);

  // The whole polling rule, in one expression.
  const busy = (list?.items.some((i) =>
    i.recording.status === 'starting'
    || i.recording.status === 'recording'
    || i.recording.status === 'processing'
    || i.transcript?.status === 'queued'
    || i.transcript?.status === 'running') ?? false)
    || notes?.notes?.status === 'queued'
    || notes?.notes?.status === 'running';

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusyId(null); }
  }

  if (!list) return null;

  // Recording needs a container that may simply not be deployed. Saying so is
  // better than an empty card that looks like a missing feature.
  if (!list.enabled) {
    return (
      <Card title="Recording" className="mt-3">
        <Empty
          title="Recording is not switched on for this server"
          hint="The recorder is a separate service. Once it is deployed, hosts can record a meeting's audio and have notes written from it automatically."
        />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Recordings"
        subtitle={list.transcription
          ? undefined
          : 'Transcription is not configured, so recordings are kept as audio only.'}
        className="mt-3"
        actions={isHost && list.items.length > 0 ? (
          <Button onClick={() => void load()}>Refresh</Button>
        ) : undefined}
      >
        {error && <div className="alert alert-danger py-2 fs-13">{error}</div>}

        {list.items.length === 0 ? (
          <Empty
            title="Nothing recorded yet"
            hint="A host can start recording from inside the meeting. Audio is recorded by default — it is a quarter of the load of video on this server, and it is all the notes need."
          />
        ) : (
          <Table head={['Started', 'Kind', 'Length', 'Size', 'Status', '']}>
            {list.items.map((item) => (
              <Row key={item.recording.id} item={item} meetingId={meetingId}
                   isHost={isHost} canDelete={canDelete}
                   busy={busyId === item.recording.id} act={act} />
            ))}
          </Table>
        )}
      </Card>

      <NotesCard notes={notes} isHost={isHost}
                 show={showTranscript} onToggle={() => setShowTranscript((s) => !s)}
                 onRegenerate={() => void act('notes', () =>
                   recordingApi.regenerate(authedFetch, meetingId))}
                 busy={busyId === 'notes'} />
    </>
  );
}

// ---------------------------------------------------------------------------
function Row({ item, meetingId, isHost, canDelete, busy, act }: {
  item: RecordingListItem;
  meetingId: string;
  isHost: boolean;
  canDelete: boolean;
  busy: boolean;
  act: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { authedFetch } = useAuth();
  const r = item.recording;
  const live = r.status === 'starting' || r.status === 'recording';

  return (
    <tr>
      <Td>{r.startedAt ? timeLabel(r.startedAt) : timeLabel(r.createdAt)}</Td>
      <Td>{r.mode === 'video' ? 'Video' : 'Audio'}</Td>
      <Td>{durationLabel(r.durationMs)}</Td>
      <Td>{sizeLabel(r.sizeBytes)}</Td>
      <Td>
        <Badge tone={recordingTone(r.status)}>{RECORDING_LABEL[r.status]}</Badge>
        {r.error && <div className="fs-11 text-danger mt-1">{r.error}</div>}
        {item.transcript && (
          <div className="fs-11 text-muted mt-1">{transcriptLine(item.transcript.status)}</div>
        )}
      </Td>
      <Td className="text-end">
        <div className="d-flex gap-2 justify-content-end flex-wrap">
          {/* A plain link, not a fetch: the browser has to navigate for the
              download to happen, and the session cookie goes with it. */}
          {r.hasFile && (
            <a className="btn btn-outline-light btn-sm"
               href={recordingApi.fileUrl(meetingId, r.id)}>
              Download
            </a>
          )}
          {isHost && live && (
            <Button variant="danger" className="btn-sm" disabled={busy}
                    onClick={() => void act(r.id,
                      () => recordingApi.stop(authedFetch, meetingId, r.id))}>
              Stop
            </Button>
          )}
          {canDelete && !live && r.status !== 'deleted' && (
            <Button variant="ghost" className="btn-sm" disabled={busy}
                    onClick={() => void act(r.id,
                      () => recordingApi.remove(authedFetch, meetingId, r.id))}>
              Delete
            </Button>
          )}
        </div>
      </Td>
    </tr>
  );
}

function transcriptLine(status: TranscriptStatus): string {
  switch (status) {
    case 'ready': return 'Transcribed';
    case 'running': return 'Transcribing…';
    case 'queued': return 'Waiting to be transcribed';
    case 'failed': return 'Transcription failed';
    // Not a failure — nobody switched it on. Said in those words on purpose.
    case 'unavailable': return 'No transcription service configured';
  }
}

// ---------------------------------------------------------------------------
function NotesCard({ notes, isHost, show, onToggle, onRegenerate, busy }: {
  notes: NotesPayload | null;
  isHost: boolean;
  show: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
  busy: boolean;
}) {
  if (!notes) return null;
  const n = notes.notes;
  const t = notes.transcript;

  // Four different reasons for an empty card, four different sentences.
  if (!n || n.status !== 'ready') {
    let title = 'No notes yet';
    let hint = 'Notes are written automatically once a recording has been transcribed.';

    if (!notes.transcriptionConfigured) {
      title = 'Transcription is not configured';
      hint = 'Notes are written from a transcript, and this server has no transcription '
        + 'service set. Nothing is sent anywhere until one is configured — see '
        + 'docs/CONNECT_RECORDING_AND_NOTES.md for the three ways to do it.';
    } else if (t?.status === 'failed') {
      title = 'The transcript failed';
      hint = t.error ?? 'The transcription service could not be reached.';
    } else if (t?.status === 'running' || t?.status === 'queued') {
      title = 'Transcribing';
      hint = 'The notes will appear here once the transcript is done. '
        + 'An hour of audio takes a while on a shared server.';
    } else if (n?.status === 'running' || n?.status === 'queued') {
      title = 'Writing the notes';
      hint = 'This page will update on its own.';
    } else if (n?.status === 'failed') {
      title = 'The notes could not be written';
      hint = n.error ?? 'Something went wrong.';
    }

    return (
      <Card title="Meeting notes" className="mt-3">
        <Empty title={title} hint={hint} />
      </Card>
    );
  }

  return (
    <Card
      title="Meeting notes"
      // Decision 5 of the migration, surfaced. A summary that MIGHT have been
      // written by a model and might have been assembled by a regex, with no
      // way to tell, is worse than either one honestly labelled.
      subtitle={n.kind === 'model'
        ? `Written by ${n.model ?? 'a language model'}${n.generatedAt ? ` · ${timeLabel(n.generatedAt)}` : ''}`
        : 'Assembled from the transcript on this server — no model was involved'}
      className="mt-3"
      actions={isHost ? (
        <Button disabled={busy} onClick={onRegenerate}>
          {busy ? 'Asking…' : 'Write again'}
        </Button>
      ) : undefined}
    >
      {n.summary && <p className="mb-3">{n.summary}</p>}

      <Points title="Decisions" items={n.decisions} />
      <Points title="Follow-ups" items={n.actionItems} />
      <Points title="Points raised" items={n.keyPoints} />

      {n.speakers.length > 0 && (
        <>
          <h6 className="fs-13 text-muted mt-3">Who spoke</h6>
          <ul className="list-unstyled mb-3">
            {n.speakers.map((s) => (
              <li key={s.name} className="fs-13">
                {s.name} — {durationLabel(s.seconds * 1000)} over {s.turns} turns
              </li>
            ))}
          </ul>
        </>
      )}

      {t?.text && (
        <>
          <Button className="btn-sm" onClick={onToggle}>
            {show ? 'Hide the transcript' : 'Show the transcript'}
          </Button>
          {show && (
            <>
              <pre className="mt-3 p-3 fs-12 bg-light rounded"
                   style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {t.segments.length > 0
                  ? t.segments.map((s) => `[${clock(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n')
                  : t.text}
              </pre>
              <div className="fs-11 text-muted">
                Transcribed by {t.provider ?? 'the configured service'}
                {t.language ? ` · ${t.language}` : ''}
                {' · '}
                Machine transcription: expect names and numbers to need checking.
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function Points({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h6 className="fs-13 text-muted">{title}</h6>
      <ul className="mb-3">
        {items.map((s) => <li key={s} className="fs-13">{s}</li>)}
      </ul>
    </>
  );
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
