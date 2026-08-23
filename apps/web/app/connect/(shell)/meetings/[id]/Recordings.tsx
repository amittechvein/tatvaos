'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Player } from './Player';
import {
  durationLabel, recordingApi, sizeLabel, timeLabel,
  minutesApi,
  type NotesPayload, type Recording, type RecordingList, type RecordingListItem,
  type RecordingStatus,
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

export default function Recordings({ meetingId, isHost, canDelete, guestNames }: {
  meetingId: string;
  /** Host or cohost: may start, stop, and ask for the notes again. */
  isHost: boolean;
  /** Host only. Deleting a recording is not the same act as stopping one. */
  canDelete: boolean;
  /**
   * Guests who attended. Minutes are written from what each person's OWN
   * browser heard, and guests cannot take part in that yet — so their half of
   * the conversation is missing from a record that will read as complete.
   * Whoever reads the minutes has to be told that, by name.
   */
  guestNames: string[];
}) {
  const { authedFetch } = useAuth();

  const [list, setList] = useState<RecordingList | null>(null);
  const [notes, setNotes] = useState<NotesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  // The recording currently open in the player, if any.
  const [playing, setPlaying] = useState<Recording | null>(null);

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
  //
  // The NOTES card is still rendered underneath, because notes no longer
  // depend on recording at all — attendance comes from the API's own rows and
  // the event log. This branch used to return early and hid them.
  if (!list.enabled) {
    return (
      <>
        <Card title="Recording" className="mt-3">
          <Empty
            title="Recording is not switched on for this server"
            hint="The recorder is a separate service. Once it is deployed, hosts can record a meeting's audio and have what was said written up automatically."
          />
        </Card>
        <NotesCard notes={notes} meetingId={meetingId} isHost={isHost} guestNames={guestNames}
                   show={showTranscript} onToggle={() => setShowTranscript((s) => !s)}
                   onRegenerate={() => void act('notes', () =>
                     recordingApi.regenerate(authedFetch, meetingId))}
                   busy={busyId === 'notes'} />
      </>
    );
  }

  return (
    <>
      <Card
        title="Recordings"
        // NOT "transcription is not configured", which read as something
        // half-installed. Nothing is broken: sending recordings away to be
        // transcribed was switched off deliberately on 22 August 2026, because
        // it was 97% of the AI bill and could not say who spoke. A screen that
        // reports a decision as a fault sends people hunting for a bug.
        subtitle={'Recordings are kept as they were made. Nothing is sent away to be '
          + 'transcribed — the minutes come from live captions during the meeting, '
          + 'which cost nothing and can say who said what.'}
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
                   busy={busyId === item.recording.id} act={act}
                   onPlay={setPlaying} />
            ))}
          </Table>
        )}
      </Card>

      <NotesCard notes={notes} meetingId={meetingId} isHost={isHost} guestNames={guestNames}
                 show={showTranscript} onToggle={() => setShowTranscript((s) => !s)}
                 onRegenerate={() => void act('notes', () =>
                   recordingApi.regenerate(authedFetch, meetingId))}
                 busy={busyId === 'notes'} />

      {playing && (
        <Player meetingId={meetingId} recording={playing}
                onClose={() => setPlaying(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
/**
 * Who is missing from these minutes, by name.
 *
 * Worded with some care, because this is the sentence that decides whether
 * somebody relies on an incomplete record:
 *
 *  - it says WHY, so it does not read as a fault to be reported;
 *  - it NAMES people, so a reader can tell whether the missing half matters
 *    for what they are about to do with this;
 *  - it says the record will look complete, because the danger is not the
 *    absence, it is the absence being invisible.
 *
 * Not styled as an error. Nothing has gone wrong: a limitation stated once,
 * plainly, is worth more than a red box people learn to close.
 */
function GuestGap({ names }: { names: string[] }) {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const who = rest > 0
    ? `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
      : shown[0];

  return (
    <div className="cx-gap mb-3">
      <strong>Not everything said is in here.</strong>
      <p>
        Minutes are written from what each person&rsquo;s own browser heard, and
        guests cannot take part in that yet. Anything said by {who} is missing.
        These notes will read as a complete account of the meeting, and they are
        not one.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Row({ item, meetingId, isHost, canDelete, busy, act, onPlay }: {
  item: RecordingListItem;
  meetingId: string;
  isHost: boolean;
  canDelete: boolean;
  busy: boolean;
  act: (id: string, fn: () => Promise<unknown>) => Promise<void>;
  onPlay: (r: Recording) => void;
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
          <div className={`fs-11 mt-1 ${
            item.transcript.status === 'failed' ? 'text-danger' : 'text-muted'
          }`}>
            {transcriptLine(item.transcript)}
          </div>
        )}
      </Td>
      <Td className="text-end">
        <div className="d-flex gap-2 justify-content-end flex-wrap">
          {/* A BUTTON, not a link — see recordingApi.download. A plain <a>
              here answered 401 every time, because this app's access token is
              an Authorization header and a navigation does not carry one. */}
          {/* WATCHING IS THE COMMON CASE. Downloading a file, finding it, and
              opening it in another application is three steps to answer "what
              did they actually say" — and for video it is half a gigabyte to
              answer it. The file is already reachable in the shape a player
              wants, so this is the primary action and Download moved inside
              the player for the people who genuinely want the file. */}
          {r.hasFile && (
            <Button variant="primary" className="btn-sm" onClick={() => onPlay(r)}>
              {r.mode === 'video' ? 'Watch' : 'Listen'}
            </Button>
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

/**
 * The transcript's state in one line.
 *
 * On FAILURE this prefers the SERVER'S OWN SENTENCE over anything written
 * here. The transcriber distinguishes half a dozen causes — the recording was
 * too large, the service rejected our credentials, the account is out of
 * credit, the recording may be silent — and each needs a different person to
 * do a different thing. "Transcription failed" sends all of them to the same
 * wrong place, which is to say to us.
 *
 * Those sentences existed all along and were dropped by the API one field
 * short of this component. Fixed 22 August 2026; the lesson worth keeping is
 * that an error message is not shipped until somebody has SEEN it on a screen.
 */
function transcriptLine(t: { status: TranscriptStatus; error: string | null }): string {
  switch (t.status) {
    case 'ready': return 'Transcribed';
    case 'running': return 'Transcribing…';
    case 'queued': return 'Waiting to be transcribed';
    case 'failed': return t.error?.trim() || 'Transcription failed';
    // Not a failure — nobody switched it on. Said in those words on purpose.
    case 'unavailable': return 'No transcription service configured';
  }
}

// ---------------------------------------------------------------------------
function NotesCard({
  notes, meetingId, isHost, guestNames, show, onToggle, onRegenerate, busy,
}: {
  notes: NotesPayload | null;
  meetingId: string;
  isHost: boolean;
  guestNames: string[];
  show: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
  busy: boolean;
}) {
  if (!notes) return null;
  const n = notes.notes;
  const t = notes.transcript;

  // Several different reasons for an empty card, several different sentences.
  if (!n || n.status !== 'ready') {
    let title = 'No notes yet';
    let hint = 'Notes are written automatically a minute or so after a meeting ends — '
      + 'who attended and for how long, and what was said if it was recorded.';

    if (t?.status === 'failed') {
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
      // ── THREE TRUE SENTENCES, AND THIS USED TO TELL ONE LIE. ────────────
      //
      // "no transcript" cannot say WHY there is none, which is why the notes
      // carry hadRecording alongside hadTranscript. This subtitle ignored it
      // and said "this meeting was not recorded" on a meeting whose recording
      // is listed in the card directly above — the page contradicting itself
      // on one screen, while the emailed copy said the correct thing.
      //
      // A person reading "not recorded" next to their own recording either
      // stops trusting the notes or goes looking for a bug in the recorder.
      subtitle={n.kind === 'model'
        ? `Written by ${n.model ?? 'a language model'}${n.generatedAt ? ` · ${timeLabel(n.generatedAt)}` : ''}`
        : n.hadTranscript
          ? 'Assembled from the transcript on this server — no model was involved'
          : n.hadRecording
            ? 'From attendance only — the meeting was recorded, but no transcript was made of it'
            : 'From attendance only — this meeting was not recorded'}
      className="mt-3"
      actions={(
        <>
          <MinutesActions meetingId={meetingId} isHost={isHost} />
          {isHost && (
            <Button disabled={busy} onClick={onRegenerate}>
              {busy ? 'Asking…' : 'Write again'}
            </Button>
          )}
        </>
      )}
    >
      {/* ── WHAT THIS RECORD DOES NOT CONTAIN. ──────────────────────────
          The gap is the dangerous part, not the absence. Minutes assembled
          from captions read as a complete account of the meeting, because
          nothing in them says otherwise — and in a meeting with a parent, a
          patient or a client, the missing half is exactly the half somebody
          will later rely on. Named, so a reader can tell WHOSE words are not
          here rather than being left with a general disclaimer to discount. */}
      {guestNames.length > 0 && <GuestGap names={guestNames} />}

      {n.summary && <p className="mb-3">{n.summary}</p>}

      <Points title="Decisions" items={n.decisions} />
      <Points title="Follow-ups" items={n.actionItems} />
      <Points title="Points raised" items={n.keyPoints} />

      {/* Attendance first. For most meetings it is the ONLY thing here, and
          for a school marking a register it is the thing they came for. */}
      {n.attendance.length > 0 && (
        <>
          <h6 className="fs-13 text-muted">Who attended ({n.attendance.length})</h6>
          <div className="table-responsive mb-3">
            <table className="table table-sm text-nowrap mb-0">
              <tbody>
                {n.attendance.map((a) => (
                  <tr key={a.identity}>
                    <td className="fs-13">
                      {a.name}
                      {a.guest && <span className="badge bg-secondary-transparent ms-2">Guest</span>}
                    </td>
                    <td className="fs-13 text-muted">
                      {a.joinedAt ? timeLabel(a.joinedAt) : '—'}
                    </td>
                    <td className="fs-13 text-muted">
                      {/* 0 seconds means the API saw them join but the media
                          server never reported it. Saying "0:00" would read as
                          "they were not there", which is not what we know. */}
                      {a.seconds > 0 ? durationLabel(a.seconds * 1000) : 'not recorded'}
                    </td>
                    <td className="fs-13 text-muted">
                      {a.joins > 1 ? `rejoined ${a.joins - 1}×` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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

// ===========================================================================
//  Minutes of meeting — the document, and sending it.
// ===========================================================================
//
//  The notes card already SHOWS everything. This is about the thing people
//  actually do with minutes: keep a copy, and send it to the people who were
//  there. A school secretary's next move after a fee committee meeting is to
//  put the minutes somewhere and mail them, and until this existed the answer
//  was to select the page and paste it into an email.
//
//  Both buttons are deliberately plain about what happens. "Email to
//  attendees" says who gets it, in the confirmation, with a count — because
//  the one thing worse than not sending minutes is sending them to a list you
//  did not know about.
function MinutesActions({ meetingId, isHost }: { meetingId: string; isHost: boolean }) {
  const { authedFetch } = useAuth();
  const [busy, setBusy] = useState<'file' | 'mail' | null>(null);
  // The minutes themselves, once fetched. Held rather than re-fetched on every
  // open: they do not change while the page is up unless somebody presses
  // Write again, which reloads the card anyway.
  const [minutes, setMinutes] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // ── A SUCCESS MESSAGE THAT NEVER LEAVES BECOMES FURNITURE. ──────────────
  //
  // "Downloaded." sat in the header for the rest of the session, wedged
  // between two buttons, long after the file had been saved — it stopped
  // meaning "just now" and started looking like a broken label. Confirmation
  // is worth a few seconds and no more.
  //
  // A FAILURE is not cleared: it is the only place the reason appears, and a
  // person who looked away for four seconds would be left with a button that
  // silently did nothing.
  useEffect(() => {
    if (said === null || failed) return;
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [said, failed]);

  // Returns the sentence to show, or null when the action speaks for itself —
  // opening a dialog needs no caption underneath it.
  async function run(kind: 'file' | 'mail', fn: () => Promise<string | null>) {
    setBusy(kind);
    setSaid(null);
    setFailed(false);
    try {
      setSaid(await fn());
    } catch (e) {
      setFailed(true);
      setSaid(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {/* ── READ, NOT SAVED. ────────────────────────────────────────────────
          This was "Download minutes", which answered a question nobody had
          asked yet. Almost everybody pressing it wanted to KNOW what the
          minutes said — and got a file in a downloads folder, to be found,
          opened in another application, and read there. Three steps to answer
          "what did we decide". Saving a copy is a real need, but it is the
          rarer one, so it moved inside: the popup keeps it, one press away,
          for the person who actually wants the file. */}
      <Button
        variant="primary"
        disabled={busy !== null}
        onClick={() => void run('file', async () => {
          const text = await minutesApi.read(authedFetch, meetingId);
          setMinutes(text);
          setShowing(true);
          // No confirmation sentence: the dialog opening IS the confirmation,
          // and a message under a dialog is a message nobody reads.
          return null;
        })}
      >
        {busy === 'file' ? 'Opening…' : 'View minutes'}
      </Button>

      {isHost && (
        <Button
          disabled={busy !== null}
          onClick={() => void run('mail', async () => {
            const n = await minutesApi.email(authedFetch, meetingId);
            // The count, always — including zero, which is a real answer for a
            // meeting everybody attended as a guest and is the one case where
            // silence would be actively misleading.
            return n === 0
              ? 'Nobody in this meeting has an address on this platform, so there was no one to send to.'
              : `Sent to ${n} ${n === 1 ? 'person' : 'people'} who attended.`;
          })}
        >
          {busy === 'mail' ? 'Sending…' : 'Email to attendees'}
        </Button>
      )}

      {/* w-100 puts this on its OWN line inside the header's wrapping flex
          row. Without it the message is just another flex item and lands
          BETWEEN the buttons — which is what pushed "Write again" out of line
          and made a confirmation look like a broken control. A sentence is
          not a button and should not queue with them. */}
      {said && (
        <span className={`w-100 fs-12 ${failed ? 'text-danger' : 'text-muted'}`}>{said}</span>
      )}

      {showing && minutes !== null && (
        <Modal
          title="Minutes of the meeting"
          subtitle="Written from what was said. Check anything you are going to rely on."
          size="lg"
          onClose={() => setShowing(false)}
          footer={(
            <>
              <Button onClick={() => setShowing(false)}>Close</Button>
              {/* Kept, and only here. Somebody filing minutes for a school or
                  a board still needs the file; everybody else needed to read
                  them, which is now the thing the button on the card does. */}
              <Button variant="primary"
                      onClick={() => void minutesApi.download(authedFetch, meetingId)}>
                Save a copy
              </Button>
            </>
          )}
        >
          {/* Plain text, and rendered as plain text — see minutesApi.read for
              why it is not the HTML version. pre-wrap keeps the document's own
              line breaks without a monospace font making it look like output
              from a program rather than a record of a meeting. */}
          <div className="cx-mom">{minutes}</div>
        </Modal>
      )}
    </>
  );
}
