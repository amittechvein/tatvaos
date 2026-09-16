'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Checkbox, Input, Select, Switch } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import {
  connectApi, prettyCode, timeLabel, whenLabel,
  type ChatPolicy, type LobbyEntry, type Meeting, type MeetingBlock, type Participant,
  type SharePolicy, type UpdateMeeting, type WaitingRoom,
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

// ---------------------------------------------------------------------------
//  ONE ROW PER PERSON, NOT PER JOIN.
//
//  A signed-in colleague has ONE identity for every join they ever make, so
//  their rows collapse on their own. A guest does not: the identity is minted
//  when they open the link, so reconnecting after a dropped train, or opening
//  the link twice, or a laptop lid closing and reopening, each produce a
//  separate participant. Rishav Anand appeared five times in one meeting, in
//  five different colours, and looked like five different people.
//
//  Grouping guests by the NAME they typed is a judgement, not a fact: two
//  people who both type "Ravi" merge into one row. The alternative on show
//  above is worse — the list is meant to answer "who was in this meeting",
//  and five rows for one person answers it wrongly in a way nobody can
//  correct. The row says how many times they joined, so nothing is hidden.
//
//  The real fix is a guest identity that survives a reconnect, which is the
//  server's to mint. Raised with Core; this is the honest view until then.
// ---------------------------------------------------------------------------

interface Attendee {
  key: string;
  /** The session to ACT on — see the note in groupPeople. */
  who: Participant;
  sessions: number;
  firstJoinedAt: string | null;
  lastSeenAt: string | null;
  connected: boolean;
}

const stamp = (iso: string | null): number => (iso ? new Date(iso).getTime() : NaN);

/** True when a is a real time and is before b (or b is missing). */
function isBefore(a: string | null, b: string | null): boolean {
  const x = stamp(a);
  if (Number.isNaN(x)) return false;
  const y = stamp(b);
  return Number.isNaN(y) || x < y;
}

function isAfter(a: string | null, b: string | null): boolean {
  const x = stamp(a);
  if (Number.isNaN(x)) return false;
  const y = stamp(b);
  return Number.isNaN(y) || x > y;
}

/**
 * The attendance list as a CSV, made in the browser.
 *
 * No endpoint, and that is the right call rather than a shortcut: every field
 * below is already on this page, and a server route would be a second place
 * for the grouping rules to live — the guest-merging in groupPeople is a
 * judgement, and two copies of a judgement disagree eventually.
 *
 * Quoting is not optional. A meeting called Q3 Review, Finance would split
 * into two columns and shift every field after it, silently, in a file
 * somebody files as a register.
 */
function attendanceCsv(rows: Attendee[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

  const head = ['Name', 'Type', 'Role', 'First joined', 'Last seen', 'Times joined', 'Still in the meeting'];
  const body = rows.map((a) => [
    cell(a.who.displayName),
    cell(a.who.isGuest ? 'Guest' : 'Member'),
    cell(a.who.role),
    cell(when(a.firstJoinedAt)),
    cell(when(a.lastSeenAt)),
    cell(String(a.sessions)),
    cell(a.connected ? 'Yes' : 'No'),
  ].join(','));

  // A BOM, because this file gets opened in Excel more often than anywhere
  // else, and without it Excel reads UTF-8 as its local codepage — which
  // turns every non-English name in the register into rubbish.
  return `\uFEFF${head.map(cell).join(',')}\n${body.join('\n')}\n`;
}

function downloadCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Same reasoning as the minutes download: Safari has not read the blob when
  // click() returns, and revoking immediately gives a file of zero bytes.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Safe for a filename on every platform, and still recognisable. */
function fileSafe(title: string): string {
  const clean = title.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60);
  return clean.length > 0 ? clean : 'Meeting';
}

function groupPeople(people: Participant[]): Attendee[] {
  const by = new Map<string, Attendee>();

  for (const p of people) {
    const key = p.isGuest
      ? `guest:${p.displayName.trim().toLowerCase()}`
      : p.identity;

    const seen = by.get(key);
    if (!seen) {
      by.set(key, {
        key,
        who: p,
        sessions: 1,
        firstJoinedAt: p.firstJoinedAt,
        lastSeenAt: p.lastSeenAt,
        connected: p.connected,
      });
      continue;
    }

    seen.sessions += 1;
    seen.connected = seen.connected || p.connected;
    if (isBefore(p.firstJoinedAt, seen.firstJoinedAt)) seen.firstJoinedAt = p.firstJoinedAt;
    if (isAfter(p.lastSeenAt, seen.lastSeenAt)) seen.lastSeenAt = p.lastSeenAt;

    // Mute and Remove need an identity that is actually IN the room. Prefer a
    // connected session; failing that the most recent one, because acting on
    // a session that ended succeeds and changes nothing — the worst kind of
    // button.
    if (p.connected && !seen.who.connected) seen.who = p;
    else if (!seen.who.connected && isAfter(p.lastSeenAt, seen.who.lastSeenAt)) seen.who = p;
  }

  // Whoever is still here, first. After that, whoever arrived earliest.
  return [...by.values()].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return isBefore(a.firstJoinedAt, b.firstJoinedAt) ? -1 : 1;
  });
}

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authedFetch } = useAuth();
  const router = useRouter();

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [people, setPeople] = useState<Participant[]>([]);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [blocks, setBlocks] = useState<MeetingBlock[]>([]);
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
    sharePolicy: SharePolicy; chatPolicy: ChatPolicy; autoRecord: boolean;
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
      chatPolicy: m.chatPolicy,
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
      chatPolicy: form.chatPolicy,
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

      // Asked for after the meeting rather than beside it, because the role
      // is not known until the meeting arrives — and because a refusal here
      // is a normal answer for a participant, not something to put in a red
      // banner. Loaded inside load() so that run() refreshes it: letting
      // somebody back in and then still seeing their name is the kind of
      // small lie that makes people click twice.
      if (m.myRole === 'host' || m.myRole === 'cohost') {
        setBlocks(await connectApi.blocks(authedFetch, id).catch(() => []));
      } else {
        setBlocks([]);
      }
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
      <div className="p-12 text-center text-ink-muted">
        <Spinner inline />
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

  // One row per person. `rejoiners` is only used to decide whether the card
  // needs to explain itself — with nobody having joined twice, the note would
  // be answering a question nobody asked.
  const attendees = groupPeople(people);
  const rejoiners = attendees.filter((a) => a.sessions > 1).length;

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
        <div className="flex gap-2 flex-wrap">
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
          {/* THE UNDO FOR THE BUTTON ABOVE IT.
              Ending a meeting was permanent: status went to 'ended' and
              nothing in the product could move it back, so a meeting ended by
              a misclick — or ended properly and then needed again an hour
              later — was gone, and the only cure was SQL against production.
              Offered only on 'ended'. A CANCELLED meeting is not reopened
              here: ending says it finished, cancelling says it is not
              happening, and reversing that is a decision about a plan rather
              than the undo of a click. */}
          {isHost && meeting.status === 'ended' && (
            <Button variant="primary" disabled={busy !== null}
                    onClick={() => void run('reopen',
                      () => connectApi.reopen(authedFetch, meeting.id),
                      'The meeting is open again. The same link and code still work.')}>
              Reopen
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      {/* THE DOOR IS OPEN, AND NOTHING SAID SO.
          Waiting room off plus guests allowed means anybody holding the link
          walks in, under any name they care to type — and a link is a bearer
          token, so "holding the link" includes whoever it was forwarded to.
          That combination is legitimate for a public briefing and a mistake
          for everything else, and the difference is a decision the host has
          to actually make rather than discover afterwards in the attendance
          list. Shown, not enforced: it is their meeting. */}
      {!over && meeting.waitingRoom === 'off' && meeting.allowGuests && (
        <div className="cx-opendoor" role="status">
          <div>
            <strong>Anyone with the link can walk in.</strong>
            <p>
              The waiting room is off and guests are allowed, so nobody is
              checked at the door and a guest can type any name they like. If
              this link has been forwarded, you will not know who is in the
              room until they are.
            </p>
          </div>
          {isHost && (
            <Button variant="primary" disabled={busy !== null}
                    onClick={() => void run('door',
                      () => connectApi.update(authedFetch, meeting.id,
                        { waitingRoom: 'guests' }).then(() => undefined),
                      'Guests now wait for you to let them in.')}>
              Make guests wait
            </Button>
          )}
        </div>
      )}

      {editing && form && (
        <Card title="Edit this meeting" className="mb-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-title">Title</label>
              <Input id="ed-title" value={form.title} maxLength={200}
                     onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-start">Starts</label>
              <Input id="ed-start" type="datetime-local" value={form.start}
                     onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-end">Ends</label>
              <Input id="ed-end" type="datetime-local" value={form.end}
                     onChange={(e) => setForm({ ...form, end: e.target.value })} />
              <div className="mt-1 text-xs text-ink-muted">
                Times are in this computer&apos;s time zone. Leave both empty for a
                meeting with no fixed time.
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-waiting">Waiting room</label>
              <Select id="ed-waiting" value={form.waitingRoom}
                      onChange={(e) => setForm({ ...form, waitingRoom: e.target.value as WaitingRoom })}>
                <option value="off">Off — anyone with the link joins straight in</option>
                <option value="guests">Guests wait to be let in</option>
                <option value="everyone">Everyone waits to be let in</option>
              </Select>
              <div className="mt-1 text-xs text-ink-muted">
                Opening the door also lets in anybody already waiting.
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-share">Who can share their screen</label>
              <Select id="ed-share" value={form.sharePolicy}
                      onChange={(e) => setForm({ ...form, sharePolicy: e.target.value as SharePolicy })}>
                <option value="everyone">Everyone</option>
                <option value="cohost">Only the host and co-hosts</option>
                <option value="host">Only the host</option>
              </Select>
              <div className="mt-1 text-xs text-ink-muted">Applies to people already in the meeting, immediately.</div>
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-chat">Who can send chat messages</label>
              <Select id="ed-chat" value={form.chatPolicy}
                      onChange={(e) => setForm({ ...form, chatPolicy: e.target.value as ChatPolicy })}>
                <option value="everyone">Everyone</option>
                <option value="cohost">Only the host and co-hosts</option>
                <option value="off">Nobody — chat is closed</option>
              </Select>
              <div className="mt-1 text-xs text-ink-muted">
                Everyone can still read what was sent, whichever you choose.
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="ed-password">Password</label>
              <Input id="ed-password" type="password"
                     value={form.password} disabled={form.clearPassword}
                     placeholder={meeting.hasPassword ? 'Unchanged' : 'None'}
                     autoComplete="new-password"
                     onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <div className="mt-1 text-xs text-ink-muted">
                {meeting.hasPassword
                  ? 'Leave this empty to keep the current password.'
                  : 'Type one to start requiring a password. 4 characters or more.'}
              </div>
              {meeting.hasPassword && (
                <Checkbox id="ed-clearpw" className="mt-2 mb-0" label="Remove the password"
                          checked={form.clearPassword}
                          onChange={(e) => setForm({
                            ...form, clearPassword: e.target.checked, password: '',
                          })} />
              )}
            </div>

            <div>
              <Switch id="ed-guests" className="mb-0" label="Let people without an account join"
                      checked={form.allowGuests}
                      onChange={(e) => setForm({ ...form, allowGuests: e.target.checked })} />

              {/* Auto-record is absent, not disabled, on a Private meeting:
                  its media cannot be read by this server at all, so the
                  control would be a promise the product cannot keep. */}
              {meeting.mode !== 'private' && (
                <Switch id="ed-autorec" className="mt-2 mb-0" label="Start recording automatically"
                        checked={form.autoRecord}
                        onChange={(e) => setForm({ ...form, autoRecord: e.target.checked })} />
              )}
            </div>

            <div className="md:col-span-2">
              <div className="rounded-lg border border-line bg-canvas p-3 mb-0 text-[0.75rem] text-ink">
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

          <div className="flex gap-2 mt-4">
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

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8">
          {lobby.length > 0 && (
            <Card title="Waiting to be let in" className="mb-4">
              {lobby.map((w) => (
                <div key={w.requestId}
                     className="flex items-center justify-between flex-wrap gap-2 border-b border-line py-2">
                  <div>
                    <span className="font-semibold">{w.displayName}</span>
                    {w.isGuest && <span className="ms-2"><Badge tone="warn">Guest</Badge></span>}
                    <div className="text-ink-muted text-[0.75rem]">Since {timeLabel(w.requestedAt)}</div>
                  </div>
                  <div className="flex gap-2">
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

          <Card title="People"
                actions={attendees.length > 0 ? (
                  <Button onClick={() => downloadCsv(
                    `${fileSafe(meeting.title)} - attendance.csv`,
                    attendanceCsv(attendees))}>
                    <i className="ri-download-2-line me-1" />
                    Download attendance
                  </Button>
                ) : undefined}
                subtitle={rejoiners > 0
                  ? 'One row per person. Guests are matched by the name they typed, '
                    + 'because a guest gets a new identity every time they open the link.'
                  : undefined}
                padded={false}>
            {attendees.length === 0 ? (
              <Empty title="Nobody has joined yet"
                     hint="People appear here as they arrive, and stay listed afterwards." />
            ) : (
              <Table head={['Name', 'Role', 'In the meeting', 'First joined', '']}>
                {attendees.map((a) => (
                  <tr key={a.key}>
                    <Td>
                      <div className="cx-who">
                        {/* Coloured from the GROUP key, not the identity — a
                            guest's identity changes on every rejoin, so their
                            colour would too, and the colour is how you find a
                            row again after scrolling. */}
                        <span className={`cx-face ${toneOf(a.key)}`} aria-hidden="true">
                          {faceOf(a.who.displayName)}
                        </span>
                        <div>
                          <span className="cx-name">{a.who.displayName}</span>
                          {a.who.isGuest && <span className="cx-tag">Guest</span>}
                          {a.sessions > 1 && (
                            <div className="cx-sub">
                              Joined {a.sessions} times
                              {a.lastSeenAt ? ` · last ${timeLabel(a.lastSeenAt)}` : ''}
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td><span className="cx-role">{a.who.role}</span></Td>
                    <Td>
                      {a.connected
                        ? <Badge tone="ok">Yes</Badge>
                        : <span className="text-ink-muted">No</span>}
                    </Td>
                    <Td className="text-ink-muted">
                      {a.firstJoinedAt ? timeLabel(a.firstJoinedAt) : '—'}
                    </Td>
                    <Td className="text-end">
                      {isHost && a.connected && a.who.role !== 'host' && (
                        <div className="flex gap-1 justify-end">
                          <Button disabled={busy !== null}
                                  onClick={() => void run(a.who.identity,
                                    () => connectApi.mute(authedFetch, meeting.id, a.who.identity),
                                    `${a.who.displayName} was muted.`)}>
                            Mute
                          </Button>
                          <Button variant="danger" disabled={busy !== null}
                                  onClick={() => void run(a.who.identity,
                                    () => connectApi.remove(authedFetch, meeting.id, a.who.identity),
                                    `${a.who.displayName} was removed.`)}>
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
          {/* Guests who attended, by name and deduplicated, so the notes can
              say whose words are missing from them. Computed here because the
              attendance list already lives on this page — Recordings should
              not fetch participants a second time to answer one question. */}
          <Recordings meetingId={meeting.id} isHost={isHost}
                      canDelete={meeting.myRole === 'host'}
                      guestNames={attendees
                        .filter((a) => a.who.isGuest)
                        .map((a) => a.who.displayName)} />
        </div>

        <div className="xl:col-span-4">
          <Card title="Invite">
            <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="joinurl">Link</label>
            <div className="flex items-stretch">
              <Input id="joinurl" className="rounded-r-none" readOnly value={meeting.joinUrl}
                     onFocus={(e) => e.currentTarget.select()} />
              <Button variant="primary" type="button" className="rounded-l-none"
                      onClick={() => void copy(meeting.joinUrl, 'link')}>
                {copied === 'link' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="mt-1 text-xs text-ink-muted">Anyone holding this can use it — see the waiting room below.</div>

            {/* The code exists for the person whose link did not survive being
                pasted into a chat app, and it gets READ ALOUD. So it is set
                large and spaced rather than squeezed into a form field where
                an l and a 1 look the same. */}
            <label className="mt-4 mb-1 block text-[13px] font-medium text-ink">Code</label>
            <div className="cx-bigcode">
              <span>{prettyCode(meeting.code)}</span>
              <Button size="sm" type="button"
                      onClick={() => void copy(meeting.code, 'code')}>
                {copied === 'code' ? 'Copied' : 'Copy'}
              </Button>
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
            <Card title="Organiser" className="mt-4">
              <Switch id="locked" className="mb-4" label="Lock the meeting"
                      hint="Nobody new can join, with a link or a code. People already in stay in."
                      checked={meeting.locked} disabled={busy !== null}
                      onChange={(e) => void run('lock',
                        () => connectApi.update(authedFetch, meeting.id, { locked: e.target.checked })
                          .then(() => undefined))} />

              <Button variant="danger" disabled={busy !== null}
                      onClick={() => void run('cancel',
                        () => connectApi.cancel(authedFetch, meeting.id)
                          .then(() => { router.push('/connect'); }))}>
                Cancel this meeting
              </Button>
            </Card>
          )}

          {/* WHO WAS REMOVED — AND THE WAY BACK.
              Removing somebody writes a row that the join path reads for ever,
              and until now nothing displayed that row or deleted it. A host
              who misclicked Remove on a crowded People panel had locked that
              person out of the meeting permanently, with no screen anywhere
              admitting it had happened.

              Shown after the meeting ends as well as during it, because that
              is exactly when somebody notices a name that should not be on
              this list. */}
          {isHost && blocks.length > 0 && (
            <Card title="Removed from this meeting" className="mt-4">
              {blocks.map((b) => (
                <div key={b.id}
                     className="flex items-center justify-between gap-2 border-b border-line py-2">
                  <div style={{ minWidth: 0 }}>
                    <div className="font-semibold truncate">{b.displayName}</div>
                    <div className="text-[0.75rem] text-ink-muted">
                      {timeLabel(b.createdAt)}
                      {!b.enforced && ' · joined as a guest'}
                    </div>
                  </div>
                  <Button disabled={busy !== null}
                          onClick={() => void run(`unblock-${b.id}`,
                            () => connectApi.unblock(authedFetch, meeting.id, b.id),
                            `${b.displayName} can join again.`)}>
                    Let back in
                  </Button>
                </div>
              ))}
              {blocks.some((b) => !b.enforced) && (
                <div className="mt-2 text-xs text-ink-muted">
                  A guest was never actually kept out: guests are recognised only
                  for as long as they stay connected, so anyone removed as a guest
                  can return through the link. The waiting room is what stops them.
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
