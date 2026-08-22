'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import {
  connectApi, prettyCode, timeLabel, whenLabel,
  type LobbyEntry, type Meeting, type Participant, type SharePolicy,
  type UpdateMeeting, type WaitingRoom,
} from '@/lib/connect';
import Recordings from './Recordings';
import { SumRow, faceOf, toneOf } from '../../ConnectSkin';

// ============================================================================
//  One meeting — the organiser's view
// ============================================================================
//
//  The waiting room is polled, and only while somebody could actually be in
//  it. Polling a lobby for a meeting that ended is a request every three
//  seconds, per open tab, forever — and the answer never changes.
//
//  Host actions are NEVER optimistic. Mute and remove are Twirp calls to
//  LiveKit that can fail, and a UI that greys someone out before the server
//  agrees tells the host they have handled a problem they have not. The row
//  changes when the reload says it changed.
// ============================================================================

const LOBBY_POLL_MS = 3000;

/** Kept beside the front door's copy of this on purpose — one map each, so a
 *  change to what "cancelled" looks like is a change to one screen. */
const STATUS_TONE: Record<string, 'ok' | 'info' | 'danger' | 'neutral'> = {
  active: 'ok',
  scheduled: 'info',
  cancelled: 'danger',
};

// ---------------------------------------------------------------------------
//  <input type="datetime-local"> speaks LOCAL WALL TIME with no zone, while
//  the API speaks ISO instants. These two convert between them through the
//  browser's own zone, which is the zone the person editing is standing in.
//
//  Written out rather than sliced off an ISO string: `toISOString().slice(0,16)`
//  is the tempting one-liner and it is wrong by the UTC offset — in India it
//  shows a meeting five and a half hours earlier than it is, which reads as a
//  bug in the meeting rather than in the field.
// ---------------------------------------------------------------------------
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (value.length === 0) return null;
  const d = new Date(value);          // parsed in the browser's zone
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authedFetch } = useAuth();
  const router = useRouter();

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [people, setPeople] = useState<Participant[]>([]);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  // ---- Editing --------------------------------------------------------
  //
  // The form is only mounted while `editing` is true, and it is SEEDED from
  // the meeting at that moment rather than kept in sync with it. A form bound
  // to live data fights the person typing in it: the lobby poll above reloads
  // the meeting every three seconds, and a synced field would throw away a
  // half-typed title on every tick.
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    title: string; start: string; end: string;
    waitingRoom: WaitingRoom; allowGuests: boolean;
    sharePolicy: SharePolicy; autoRecord: boolean;
    password: string; clearPassword: boolean;
  } | null>(null);

  function openEditor(m: Meeting) {
    setForm({
      title: m.title,
      start: toLocalInput(m.scheduledStart),
      end: toLocalInput(m.scheduledEnd),
      waitingRoom: m.waitingRoom,
      allowGuests: m.allowGuests,
      sharePolicy: m.sharePolicy,
      autoRecord: m.autoRecord,
      // NEVER seeded with the real password — the server keeps a hash and
      // could not tell us even if this screen asked. Empty means "leave it
      // exactly as it is", which is also what the API means by null.
      password: '',
      clearPassword: false,
    });
    setEditing(true);
    setError(null);
    setNotice(null);
  }

  async function saveEdit(m: Meeting) {
    if (!form) return;
    const title = form.title.trim();
    if (title.length === 0 || title.length > 200) {
      setError('Give the meeting a title of up to 200 characters.');
      return;
    }
    const start = fromLocalInput(form.start);
    const end = fromLocalInput(form.end);
    if (start && end && new Date(end) < new Date(start)) {
      // Caught here as well as on the server, because a person who has just
      // typed both fields should be told by the field, not by a round trip.
      setError('The meeting cannot end before it starts.');
      return;
    }

    const body: UpdateMeeting = {
      title,
      scheduledStart: start,
      scheduledEnd: end,
      waitingRoom: form.waitingRoom,
      allowGuests: form.allowGuests,
      sharePolicy: form.sharePolicy,
    };

    // ── THE THREE MEANINGS OF A PASSWORD BOX. ─────────────────────────────
    // Absent  = leave the existing one alone   (send nothing)
    // ''      = remove it                      (send an empty string)
    // 'abcd'  = replace it                     (send the new one)
    // Conflating the first two is how a password survives an edit that meant
    // to remove it — so removal is its own explicit checkbox, never an
    // emptied field.
    if (form.clearPassword) body.password = '';
    else if (form.password.length > 0) body.password = form.password;

    // Auto-record is not offered at all on a Private meeting — the server
    // refuses it in words and the database has a CHECK behind that. Sending
    // it only when it is meaningful keeps the refusal a thing that cannot
    // happen rather than an error somebody has to read.
    if (m.mode !== 'private') body.autoRecord = form.autoRecord;

    await run('save', () => connectApi.update(authedFetch, m.id, body).then(() => undefined),
              'Saved.');
    setEditing(false);
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, p] = await Promise.all([
        connectApi.get(authedFetch, id),
        connectApi.participants(authedFetch, id),
      ]);
      setMeeting(m);
      setPeople(p.participants);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that meeting.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, id]);

  useEffect(() => { void load(); }, [load]);

  const isHost = meeting?.myRole === 'host' || meeting?.myRole === 'cohost';
  // Only while people could still be waiting. See the header.
  const lobbyLive = isHost
    && meeting !== null
    && (meeting.status === 'active' || meeting.status === 'scheduled')
    && meeting.waitingRoom !== 'off';

  useEffect(() => {
    if (!lobbyLive) { setLobby([]); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await connectApi.lobby(authedFetch, id);
        if (alive) setLobby(r.waiting);
      } catch {
        // A failed poll is not worth a banner: the next one is three seconds
        // away, and an error that clears itself teaches people to ignore errors.
      }
    };
    void tick();
    const t = setInterval(() => void tick(), LOBBY_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [lobbyLive, authedFetch, id]);

  async function run(label: string, fn: () => Promise<void>, after?: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (after) setNotice(after);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  // One copier for both boxes. `which` is what says which button turns into
  // "Copied", so copying the code does not claim the link was copied too.
  async function copy(text: string, which: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be refused (insecure context, permissions). Both
      // boxes are on screen and selectable, so this is not worth an error.
      setNotice('Select the text and copy it by hand — the clipboard was refused.');
    }
  }

  if (loading) {
    return (
      <div className="p-5 text-center text-muted">
        <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  if (!meeting) {
    return (
      <Card>
        <Empty
          title="That meeting is not here"
          hint={error ?? 'It may have been cancelled, or it belongs to somebody else.'}
          action={<Button href="/connect">Back to meetings</Button>}
        />
      </Card>
    );
  }

  const over = meeting.status === 'ended' || meeting.status === 'cancelled';

  return (
    <>
      {/* The meeting itself, rather than a page title with a breadcrumb under
          it. When it is and what state it is in are the two things anybody
          opening this page came to check, so they sit beside the name instead
          of being spelled out three cards down. */}
      <div className="cx-head">
        <div className="cx-who">
          <span className={`cx-face cx-face--xl ${toneOf(meeting.id)}`} aria-hidden="true">
            {faceOf(meeting.title)}
          </span>
          <div>
            <h1 className="page-title mb-0">{meeting.title}</h1>
            <div className="cx-headmeta">
              <Badge tone={STATUS_TONE[meeting.status] ?? 'neutral'}>{meeting.status}</Badge>
              <span>{whenLabel(meeting)}</span>
              <span className="cx-code">{prettyCode(meeting.code)}</span>
            </div>
          </div>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {!over && <Button variant="primary" href={`/connect/room/${meeting.code}`}>Join</Button>}
          {isHost && !over && !editing && (
            <Button onClick={() => openEditor(meeting)}>Edit</Button>
          )}
          {isHost && meeting.status === 'active' && (
            <Button variant="danger" disabled={busy !== null}
                    onClick={() => void run('end', () => connectApi.end(authedFetch, meeting.id),
                                            'The meeting has ended for everyone.')}>
              End for everyone
            </Button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="alert">{notice}</div>}

      {editing && form && (
        <Card title="Edit this meeting" className="mb-3">
          <div className="row g-3">
            <div className="col-12">
              <label className="form-label" htmlFor="ed-title">Title</label>
              <input id="ed-title" className="form-control" value={form.title} maxLength={200}
                     onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>

            <div className="col-md-6">
              <label className="form-label" htmlFor="ed-start">Starts</label>
              <input id="ed-start" type="datetime-local" className="form-control" value={form.start}
                     onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </div>
            <div className="col-md-6">
              <label className="form-label" htmlFor="ed-end">Ends</label>
              <input id="ed-end" type="datetime-local" className="form-control" value={form.end}
                     onChange={(e) => setForm({ ...form, end: e.target.value })} />
              <div className="form-text">
                Times are in this computer&apos;s time zone. Leave both empty for a
                meeting with no fixed time.
              </div>
            </div>

            <div className="col-md-6">
              <label className="form-label" htmlFor="ed-waiting">Waiting room</label>
              <select id="ed-waiting" className="form-select" value={form.waitingRoom}
                      onChange={(e) => setForm({ ...form, waitingRoom: e.target.value as WaitingRoom })}>
                <option value="off">Off — anyone with the link joins straight in</option>
                <option value="guests">Guests wait to be let in</option>
                <option value="everyone">Everyone waits to be let in</option>
              </select>
              <div className="form-text">
                Opening the door also lets in anybody already waiting.
              </div>
            </div>

            <div className="col-md-6">
              <label className="form-label" htmlFor="ed-share">Who can share their screen</label>
              <select id="ed-share" className="form-select" value={form.sharePolicy}
                      onChange={(e) => setForm({ ...form, sharePolicy: e.target.value as SharePolicy })}>
                <option value="everyone">Everyone</option>
                <option value="cohost">Only the host and co-hosts</option>
                <option value="host">Only the host</option>
              </select>
              <div className="form-text">Applies to people already in the meeting, immediately.</div>
            </div>

            <div className="col-md-6">
              <label className="form-label" htmlFor="ed-password">Password</label>
              <input id="ed-password" type="password" className="form-control"
                     value={form.password} disabled={form.clearPassword}
                     placeholder={meeting.hasPassword ? 'Unchanged' : 'None'}
                     autoComplete="new-password"
                     onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <div className="form-text">
                {meeting.hasPassword
                  ? 'Leave this empty to keep the current password.'
                  : 'Type one to start requiring a password. 4 characters or more.'}
              </div>
              {meeting.hasPassword && (
                <div className="form-check mt-2">
                  <input className="form-check-input" type="checkbox" id="ed-clearpw"
                         checked={form.clearPassword}
                         onChange={(e) => setForm({
                           ...form, clearPassword: e.target.checked, password: '',
                         })} />
                  <label className="form-check-label" htmlFor="ed-clearpw">
                    Remove the password
                  </label>
                </div>
              )}
            </div>

            <div className="col-md-6">
              <div className="form-check form-switch">
                <input className="form-check-input" type="checkbox" id="ed-guests"
                       checked={form.allowGuests}
                       onChange={(e) => setForm({ ...form, allowGuests: e.target.checked })} />
                <label className="form-check-label" htmlFor="ed-guests">
                  Let people without an account join
                </label>
              </div>

              {/* Auto-record is absent, not disabled, on a Private meeting:
                  its media cannot be read by this server at all, so the
                  control would be a promise the product cannot keep. */}
              {meeting.mode !== 'private' && (
                <div className="form-check form-switch mt-2">
                  <input className="form-check-input" type="checkbox" id="ed-autorec"
                         checked={form.autoRecord}
                         onChange={(e) => setForm({ ...form, autoRecord: e.target.checked })} />
                  <label className="form-check-label" htmlFor="ed-autorec">
                    Start recording automatically
                  </label>
                </div>
              )}
            </div>

            <div className="col-12">
              <div className="alert alert-light border mb-0 fs-12">
                <strong>Meeting type: {meeting.mode === 'private' ? 'Private' : 'Recorded'}</strong>
                {' — this cannot be changed. '}
                {meeting.mode === 'private'
                  ? 'People were told this meeting is encrypted and cannot be recorded, and that '
                    + 'promise has to hold for its whole life.'
                  : 'A meeting cannot become private after people have joined it believing '
                    + 'otherwise. Create a private meeting instead.'}
              </div>
            </div>
          </div>

          <div className="d-flex gap-2 mt-3">
            <Button variant="primary" disabled={busy !== null}
                    onClick={() => void saveEdit(meeting)}>
              {busy === 'save' ? 'Saving…' : 'Save changes'}
            </Button>
            <Button disabled={busy !== null} onClick={() => { setEditing(false); setError(null); }}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <div className="row">
        <div className="col-xl-8">
          {lobby.length > 0 && (
            <Card title="Waiting to be let in" className="mb-3">
              {lobby.map((w) => (
                <div key={w.requestId}
                     className="d-flex align-items-center justify-content-between flex-wrap gap-2 py-2 border-bottom">
                  <div>
                    <span className="fw-semibold">{w.displayName}</span>
                    {w.isGuest && <span className="ms-2"><Badge tone="warn">Guest</Badge></span>}
                    <div className="text-muted fs-12">Since {timeLabel(w.requestedAt)}</div>
                  </div>
                  <div className="d-flex gap-2">
                    <Button variant="primary" disabled={busy !== null}
                            onClick={() => void run(w.requestId,
                              () => connectApi.admit(authedFetch, meeting.id, w.requestId))}>
                      Let in
                    </Button>
                    <Button disabled={busy !== null}
                            onClick={() => void run(w.requestId,
                              () => connectApi.deny(authedFetch, meeting.id, w.requestId))}>
                      Turn away
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          )}

          <Card title="People" padded={false}>
            {people.length === 0 ? (
              <Empty title="Nobody has joined yet"
                     hint="People appear here as they arrive, and stay listed afterwards." />
            ) : (
              <Table head={['Name', 'Role', 'In the meeting', 'First joined', '']}>
                {people.map((p) => (
                  <tr key={p.identity}>
                    <Td>
                      <div className="cx-who">
                        <span className={`cx-face ${toneOf(p.identity)}`} aria-hidden="true">
                          {faceOf(p.displayName)}
                        </span>
                        <div>
                          <span className="cx-name">{p.displayName}</span>
                          {p.isGuest && <span className="cx-tag">Guest</span>}
                        </div>
                      </div>
                    </Td>
                    <Td><span className="cx-role">{p.role}</span></Td>
                    <Td>
                      {p.connected
                        ? <Badge tone="ok">Yes</Badge>
                        : <span className="text-muted">No</span>}
                    </Td>
                    <Td className="text-muted">
                      {p.firstJoinedAt ? timeLabel(p.firstJoinedAt) : '—'}
                    </Td>
                    <Td className="text-end">
                      {isHost && p.connected && p.role !== 'host' && (
                        <div className="d-flex gap-1 justify-content-end">
                          <Button disabled={busy !== null}
                                  onClick={() => void run(p.identity,
                                    () => connectApi.mute(authedFetch, meeting.id, p.identity),
                                    `${p.displayName} was muted.`)}>
                            Mute
                          </Button>
                          <Button variant="danger" disabled={busy !== null}
                                  onClick={() => void run(p.identity,
                                    () => connectApi.remove(authedFetch, meeting.id, p.identity),
                                    `${p.displayName} was removed.`)}>
                            Remove
                          </Button>
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {/* Recordings, transcript and notes. Visible to anybody who was in
              the meeting — RLS scopes it to the organisation and the API
              additionally requires a participant row, so a recording of a
              leadership meeting is not readable by everyone who works there.
              Only a HOST may delete: stopping a recording and destroying one
              are not the same act. */}
          <Recordings meetingId={meeting.id} isHost={isHost}
                      canDelete={meeting.myRole === 'host'} />
        </div>

        <div className="col-xl-4">
          <Card title="Invite">
            <label className="form-label" htmlFor="joinurl">Link</label>
            <div className="input-group">
              <input id="joinurl" className="form-control" readOnly value={meeting.joinUrl}
                     onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-primary" type="button"
                      onClick={() => void copy(meeting.joinUrl, 'link')}>
                {copied === 'link' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="form-text">Anyone holding this can use it — see the waiting room below.</div>

            {/* The code exists for the person whose link did not survive being
                pasted into a chat app, and it gets READ ALOUD. So it is set
                large and spaced rather than squeezed into a form field where
                an l and a 1 look the same. */}
            <label className="form-label mt-3">Code</label>
            <div className="cx-bigcode">
              <span>{prettyCode(meeting.code)}</span>
              <button className="btn btn-light btn-sm" type="button"
                      onClick={() => void copy(meeting.code, 'code')}>
                {copied === 'code' ? 'Copied' : 'Copy'}
              </button>
            </div>

            <ul className="cx-sum-list">
              <SumRow k="Waiting room"
                      v={meeting.waitingRoom === 'off' ? 'Off — nobody waits'
                        : meeting.waitingRoom === 'guests' ? 'Guests wait' : 'Everyone waits'}
                      warn={meeting.waitingRoom === 'off'} />
              <SumRow k="Who can get in"
                      v={meeting.allowGuests ? 'Anyone with the link' : 'Colleagues only'} />
              <SumRow k="Password" v={meeting.hasPassword ? 'Required' : 'None'} />
            </ul>
          </Card>

          {isHost && !over && (
            <Card title="Organiser" className="mt-3">
              <div className="form-check form-switch mb-3">
                <input className="form-check-input" type="checkbox" id="locked"
                       checked={meeting.locked} disabled={busy !== null}
                       onChange={(e) => void run('lock',
                         () => connectApi.update(authedFetch, meeting.id, { locked: e.target.checked })
                           .then(() => undefined))} />
                <label className="form-check-label" htmlFor="locked">
                  Lock the meeting
                </label>
                <div className="form-text">
                  Nobody new can join, with a link or a code. People already in stay in.
                </div>
              </div>

              <Button variant="danger" disabled={busy !== null}
                      onClick={() => void run('cancel',
                        () => connectApi.cancel(authedFetch, meeting.id)
                          .then(() => { router.push('/connect'); }))}>
                Cancel this meeting
              </Button>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
