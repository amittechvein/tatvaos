'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import {
  connectApi, prettyCode, timeLabel, whenLabel,
  type LobbyEntry, type Meeting, type Participant,
} from '@/lib/connect';
import Recordings from './Recordings';

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
  const [copied, setCopied] = useState(false);

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

  async function copyLink() {
    if (!meeting) return;
    try {
      await navigator.clipboard.writeText(meeting.joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure context, permissions). The
      // link is on screen and selectable, so this is not worth an error.
      setNotice('Copy the link from the box above.');
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
      <div className="page-header-breadcrumb d-flex align-items-center justify-content-between flex-wrap gap-2 my-3">
        <div>
          <h1 className="page-title fw-semibold fs-20 mb-1">{meeting.title}</h1>
          <ol className="breadcrumb mb-0">
            <li className="breadcrumb-item"><a href="/connect">Connect</a></li>
            <li className="breadcrumb-item active" aria-current="page">{whenLabel(meeting)}</li>
          </ol>
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {!over && <Button variant="primary" href={`/connect/room/${meeting.code}`}>Join</Button>}
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
                      <span className="fw-semibold">{p.displayName}</span>
                      {p.isGuest && <span className="ms-2"><Badge tone="warn">Guest</Badge></span>}
                    </Td>
                    <Td className="text-muted">{p.role}</Td>
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
            <div className="input-group mb-3">
              <input id="joinurl" className="form-control" readOnly value={meeting.joinUrl}
                     onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-primary" type="button" onClick={() => void copyLink()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <label className="form-label" htmlFor="code">Code</label>
            <input id="code" className="form-control mb-3" readOnly value={prettyCode(meeting.code)}
                   onFocus={(e) => e.currentTarget.select()} />

            <dl className="mb-0">
              <dt className="fs-12 text-muted">Waiting room</dt>
              <dd>{meeting.waitingRoom === 'off' ? 'Off'
                : meeting.waitingRoom === 'guests' ? 'Guests wait' : 'Everyone waits'}</dd>

              <dt className="fs-12 text-muted">Guests</dt>
              <dd>{meeting.allowGuests ? 'Allowed' : 'Colleagues only'}</dd>

              <dt className="fs-12 text-muted">Password</dt>
              <dd>{meeting.hasPassword ? 'Required' : 'None'}</dd>
            </dl>
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
