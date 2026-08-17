'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  Room, RoomEvent, Track,
  type Participant as LKParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { useAuth } from '@/lib/auth';
import {
  connectApi, guestApi, DoorClosedError, WrongPasswordError, GUEST_FAILURE,
  type Doorstep, type JoinResult, type Meeting, type Seat,
} from '@/lib/connect';

// ============================================================================
//  The meeting room
// ============================================================================
//
//  The only screen in Connect that renders for somebody with NO SESSION, which
//  is why it lives outside app/connect/(shell) and its own layout. To a guest
//  arriving from a link, this page IS the product.
//
//  ── Lessons from Phase 0, encoded here rather than rediscovered ──────────
//
//  TILES ARE FLEX + aspect-ratio, NEVER grid-cols-*. YZEN's stylesheet
//  defines its own `.grid` and silently flattens Tailwind's column classes —
//  a video wall that looks right in isolation and collapses to one column in
//  the app.
//
//  A BROWSER DENIED ONCE STAYS DENIED. Refusing the camera is sticky per
//  origin; the prompt never comes back. An empty tile and silence is the
//  worst possible answer, so a denial gets a persistent, specific banner.
//
//  DEPARTED PEOPLE LEAVE BLACK RECTANGLES unless their tile is removed by
//  identity on ParticipantDisconnected. A black tile reads as "their video
//  broke", and people wait for someone who has gone.
//
//  wsUrl IS AN ORIGIN. livekit-client appends /rtc/v1 itself — asserted in
//  lib/connect.ts rather than trusted here.
//
//  No useSearchParams anywhere in this tree: it forces a Suspense boundary,
//  and forgetting one fails the PRODUCTION build while dev passes happily.
// ============================================================================

type Phase =
  | { kind: 'resolving' }
  | { kind: 'door'; door: Doorstep; meeting: Meeting | null }
  | { kind: 'waiting'; waitToken: string }
  | { kind: 'live'; seat: Seat; meeting: Meeting | null }
  | { kind: 'denied' }
  | { kind: 'gone'; message: string };

const WAIT_POLL_MS = 2500;

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { user, loading: authLoading, authedFetch } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });

  // ---------------------------------------------------------------------
  //  Getting in
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;
    let alive = true;

    const run = async () => {
      try {
        if (user) {
          // Signed in: resolve the code to a meeting, then take the seat the
          // authenticated route mints — which carries their real identity and
          // role. Routing a colleague through the guest door would make them
          // a guest in their own organisation's meeting.
          const meeting = await connectApi.byCode(authedFetch, code);
          if (meeting.hasPassword) {
            if (alive) {
              setPhase({
                kind: 'door',
                door: {
                  title: meeting.title,
                  scheduledStart: meeting.scheduledStart,
                  state: meeting.status === 'active' ? 'active'
                    : meeting.status === 'ended' ? 'ended' : 'not_started',
                  passwordRequired: true,
                  locked: meeting.locked,
                },
                meeting,
              });
            }
            return;
          }
          const res = await connectApi.join(authedFetch, meeting.id);
          if (!alive) return;
          setPhase(res.status === 'waiting'
            ? { kind: 'waiting', waitToken: res.waitToken }
            : { kind: 'live', seat: res, meeting });
          return;
        }

        // Not signed in: the guest door. It needs a name before it will mint
        // anything, so this always stops to ask.
        const door = await guestApi.doorstep(code);
        if (alive) setPhase({ kind: 'door', door, meeting: null });
      } catch (e) {
        if (!alive) return;
        if (e instanceof DoorClosedError) { setPhase({ kind: 'gone', message: GUEST_FAILURE }); return; }
        setPhase({ kind: 'gone', message: e instanceof Error ? e.message : GUEST_FAILURE });
      }
    };

    void run();
    return () => { alive = false; };
  }, [authLoading, user, authedFetch, code]);

  // ---------------------------------------------------------------------
  //  The park bench
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const token = phase.waitToken;
    let alive = true;

    const tick = async () => {
      try {
        const res = await guestApi.wait(token);
        if (!alive) return;
        if (res.status === 'denied') { setPhase({ kind: 'denied' }); return; }
        if (res.status !== 'waiting') setPhase({ kind: 'live', seat: res, meeting: null });
      } catch (e) {
        if (!alive) return;
        // A 404 here is the token being spent, expired, or never valid — one
        // answer for all three, deliberately, so this cannot be probed.
        if (e instanceof DoorClosedError) setPhase({ kind: 'gone', message: GUEST_FAILURE });
      }
    };

    const t = setInterval(() => void tick(), WAIT_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [phase]);

  // ---------------------------------------------------------------------
  if (authLoading || phase.kind === 'resolving') return <Shade>Opening the meeting…</Shade>;

  if (phase.kind === 'gone') {
    return (
      <Shade>
        <div className="fs-18 fw-semibold mb-2">{phase.message}</div>
        <div className="text-secondary mb-3" style={{ maxWidth: 420 }}>
          Check the link with whoever invited you — it may have been cancelled,
          or the code may have a typo.
        </div>
        <Link href="/connect" className="btn btn-light">Back to Connect</Link>
      </Shade>
    );
  }

  if (phase.kind === 'denied') {
    return (
      <Shade>
        <div className="fs-18 fw-semibold mb-2">You were not let in</div>
        <div className="text-secondary" style={{ maxWidth: 420 }}>
          The host turned down this request. If that was a mistake, ask them to
          send the link again.
        </div>
      </Shade>
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <Shade>
        <span className="spinner-border spinner-border-sm mb-3" role="status" aria-hidden="true" />
        <div className="fs-18 fw-semibold mb-2">Waiting to be let in</div>
        <div className="text-secondary" style={{ maxWidth: 420 }}>
          The host has been told you are here. Keep this page open — you will
          join automatically.
        </div>
      </Shade>
    );
  }

  if (phase.kind === 'door') {
    return (
      <Door
        code={code}
        door={phase.door}
        meeting={phase.meeting}
        signedInName={user?.displayName ?? null}
        onSeat={(res, meeting) => {
          setPhase(res.status === 'waiting'
            ? { kind: 'waiting', waitToken: res.waitToken }
            : { kind: 'live', seat: res, meeting });
        }}
        onGone={(m) => setPhase({ kind: 'gone', message: m })}
      />
    );
  }

  return <Stage seat={phase.seat} meeting={phase.meeting} />;
}

// ===========================================================================
//  A full-bleed dark surface. The room owns the whole viewport — it is not in
//  the app shell, and it manages its own scrolling.
// ===========================================================================
function Shade({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#101014', color: '#f4f4f6',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center', padding: 24,
    }}>
      {children}
    </div>
  );
}

// ===========================================================================
//  The door — name, and a password if the meeting has one
// ===========================================================================
function Door({ code, door, meeting, signedInName, onSeat, onGone }: {
  code: string;
  door: Doorstep;
  meeting: Meeting | null;
  signedInName: string | null;
  onSeat: (res: JoinResult, meeting: Meeting | null) => void;
  onGone: (message: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [name, setName] = useState(signedInName ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (meeting === null && name.trim().length === 0) {
      setError('Tell people who you are.');
      return;
    }
    setBusy(true);
    try {
      const res = meeting
        ? await connectApi.join(authedFetch, meeting.id, password || undefined)
        : await guestApi.join(code, name.trim(), password || undefined);
      onSeat(res, meeting);
    } catch (err) {
      // A wrong password after a VALID code answers 403 and says so: the
      // code-holder already knows the meeting exists, so a distinct answer
      // leaks nothing and lets a typo be corrected. Everything else collapses
      // to the one sentence.
      if (err instanceof WrongPasswordError) setError('That password is not right.');
      else if (err instanceof DoorClosedError) { onGone(GUEST_FAILURE); return; }
      else setError(err instanceof Error ? err.message : 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <Shade>
      <div style={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <div className="text-center mb-4">
          <div className="fs-20 fw-semibold">{door.title}</div>
          <div className="text-secondary fs-13 mt-1">
            {door.state === 'active' ? 'Happening now'
              : door.state === 'ended' ? 'This meeting has ended'
                : 'Not started yet'}
          </div>
        </div>

        {door.locked && (
          <div className="alert alert-warning" role="alert">
            This meeting is locked. Nobody new can join right now.
          </div>
        )}

        <form onSubmit={submit}>
          {meeting === null && (
            <div className="mb-3">
              <label className="form-label" htmlFor="name">Your name</label>
              <input id="name" className="form-control" value={name} maxLength={100}
                     onChange={(e) => setName(e.target.value)} autoComplete="name"
                     placeholder="Ravi Kumar" />
              <div className="form-text text-secondary">Everyone in the meeting will see this.</div>
            </div>
          )}

          {door.passwordRequired && (
            <div className="mb-3">
              <label className="form-label" htmlFor="pw">Meeting password</label>
              <input id="pw" className="form-control" type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
          )}

          {error && <div className="alert alert-danger py-2" role="alert">{error}</div>}

          <button className="btn btn-primary w-100" type="submit"
                  disabled={busy || door.locked || door.state === 'ended'}>
            {busy ? 'Joining…' : 'Join meeting'}
          </button>
        </form>
      </div>
    </Shade>
  );
}

// ===========================================================================
//  The live meeting
// ===========================================================================
interface ChatLine { id: number; who: string; text: string; mine: boolean }

function Stage({ seat, meeting }: { seat: Seat; meeting: Meeting | null }) {
  const { authedFetch } = useAuth();
  const roomRef = useRef<Room | null>(null);

  const [room, setRoom] = useState<Room | null>(null);
  // livekit-client mutates its Room in place; React cannot see that. Every SDK
  // event bumps this counter, which is the only thing that makes the room's
  // current state reach the screen. The value itself is never read — the
  // re-render is the whole point.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [connState, setConnState] = useState<'connecting' | 'live' | 'reconnecting' | 'over'>('connecting');
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [view, setView] = useState<'gallery' | 'speaker'>('gallery');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);

  const isHost = meeting?.myRole === 'host' || meeting?.myRole === 'cohost';

  // ---------------------------------------------------------------------
  //  Connect once, tear down on the way out.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const r = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = r;
    setRoom(r);

    r.on(RoomEvent.Connected, () => { setConnState('live'); rerender(); })
      .on(RoomEvent.Disconnected, () => { setConnState('over'); rerender(); })
      // Reconnecting is NOT an error state. Dropping wifi in a lift is
      // ordinary; the SDK re-establishes and the meeting continues. Saying
      // "the meeting ended" here would make people rejoin a call they never
      // actually left.
      .on(RoomEvent.Reconnecting, () => { setConnState('reconnecting'); rerender(); })
      .on(RoomEvent.Reconnected, () => { setConnState('live'); rerender(); })
      .on(RoomEvent.ParticipantConnected, rerender)
      // Remove the tile by identity, or a black rectangle sits there looking
      // like a broken camera while everyone waits for somebody who has left.
      .on(RoomEvent.ParticipantDisconnected, rerender)
      .on(RoomEvent.TrackSubscribed, rerender)
      .on(RoomEvent.TrackUnsubscribed, rerender)
      .on(RoomEvent.TrackMuted, rerender)
      .on(RoomEvent.TrackUnmuted, rerender)
      .on(RoomEvent.LocalTrackPublished, rerender)
      .on(RoomEvent.ActiveSpeakersChanged, rerender)
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
          if (typeof parsed !== 'object' || parsed === null || !('text' in parsed)) return;
          const text = String((parsed as { text?: unknown }).text ?? '');
          if (text.length === 0) return;
          setChat((c) => [...c, {
            id: c.length,
            who: participant?.name ?? participant?.identity ?? 'Someone',
            text,
            mine: false,
          }]);
        } catch {
          // Chat is ephemeral and best-effort. A malformed frame from a client
          // we do not control is dropped, never thrown — it must not be able
          // to take the meeting down.
        }
      });

    void (async () => {
      try {
        await r.connect(seat.wsUrl, seat.token);
        // Camera and mic are attempted AFTER connecting, separately, and each
        // failure is survivable: joining audio-only because a camera is in use
        // by another app is a normal way to attend a meeting.
        try {
          await r.localParticipant.setMicrophoneEnabled(true);
          setMicOn(true);
        } catch (e) { noteBlocked(e, setBlocked); }
        try {
          await r.localParticipant.setCameraEnabled(true);
          setCamOn(true);
        } catch (e) { noteBlocked(e, setBlocked); }
        rerender();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not connect to the meeting.');
        setConnState('over');
      }
    })();

    return () => { void r.disconnect(); roomRef.current = null; };
  }, [seat.wsUrl, seat.token, rerender]);

  // Device lists, once permission exists — before that the browser returns
  // entries with empty labels, which is a menu of blanks.
  useEffect(() => {
    if (!camOn && !micOn) return;
    void (async () => {
      try {
        setCams(await Room.getLocalDevices('videoinput'));
        setMics(await Room.getLocalDevices('audioinput'));
      } catch {
        // Enumeration can fail in odd browsers; the toggles still work.
      }
    })();
  }, [camOn, micOn]);

  // Read fresh on every render rather than memoised. The inputs are a mutable
  // SDK object, so a dependency array here can only ever be a guess about when
  // that object changed — and a stale guess shows people who have left.
  // Copying a Map of at most a few dozen entries costs nothing.
  const participants: LKParticipant[] = room
    ? [room.localParticipant as LKParticipant, ...Array.from(room.remoteParticipants.values())]
    : [];

  // Whoever is sharing wins the big tile; otherwise the loudest person does.
  const screenSharer = participants.find(
    (p) => p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack,
  );
  const speaker = screenSharer
    ?? participants.find((p) => p.isSpeaking && p !== room?.localParticipant)
    ?? participants[0];

  // Switch to speaker view when a share STARTS — keyed on the sharer's
  // identity, not the object. The object is rebuilt every render, so
  // depending on it re-runs this constantly and pins the view to speaker:
  // the user clicks Gallery, and it snaps back on the next frame.
  const sharerId = screenSharer?.identity ?? null;
  useEffect(() => { if (sharerId) setView('speaker'); }, [sharerId]);

  // ---------------------------------------------------------------------
  async function toggleCam() {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.localParticipant.setCameraEnabled(!camOn);
      setCamOn(!camOn);
      setBlocked(null);
    } catch (e) { noteBlocked(e, setBlocked); }
  }

  async function toggleMic() {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn(!micOn);
      setBlocked(null);
    } catch (e) { noteBlocked(e, setBlocked); }
  }

  async function toggleShare() {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.localParticipant.setScreenShareEnabled(!sharing);
      setSharing(!sharing);
    } catch {
      // Cancelling the browser's own picker throws. That is a decision, not a
      // fault, and it must not raise an error banner.
      setSharing(false);
    }
  }

  async function switchDevice(kind: MediaDeviceKind, deviceId: string) {
    const r = roomRef.current;
    if (!r) return;
    try { await r.switchActiveDevice(kind, deviceId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not switch device.'); }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const r = roomRef.current;
    const text = draft.trim();
    if (!r || text.length === 0) return;
    const payload = new TextEncoder().encode(JSON.stringify({ text }));
    void r.localParticipant.publishData(payload, { reliable: true });
    setChat((c) => [...c, { id: c.length, who: 'You', text, mine: true }]);
    setDraft('');
  }

  async function hostAction(fn: () => Promise<void>) {
    try { await fn(); } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    }
  }

  function leave() {
    void roomRef.current?.disconnect();
    setConnState('over');
  }

  // ---------------------------------------------------------------------
  if (connState === 'over') {
    return (
      <Shade>
        <div className="fs-18 fw-semibold mb-2">You have left the meeting</div>
        {error && <div className="text-danger mb-2">{error}</div>}
        <div className="d-flex gap-2">
          <button type="button" className="btn btn-primary"
                  onClick={() => window.location.reload()}>Rejoin</button>
          <Link href="/connect" className="btn btn-light">Back to Connect</Link>
        </div>
      </Shade>
    );
  }

  const shown = view === 'speaker' && speaker ? [speaker] : participants;

  return (
    <div style={{
      minHeight: '100vh', background: '#101014', color: '#f4f4f6',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Banners. Each says what happened AND what to do — silence and an
          empty tile is the failure Phase 0 warned about. */}
      {connState === 'reconnecting' && (
        <div className="alert alert-warning rounded-0 mb-0 py-2 text-center" role="status">
          <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
          Connection lost — reconnecting. Stay on this page.
        </div>
      )}
      {blocked && (
        <div className="alert alert-danger rounded-0 mb-0 py-2 text-center" role="alert">
          {blocked}
        </div>
      )}
      {error && (
        <div className="alert alert-danger rounded-0 mb-0 py-2 text-center" role="alert">
          {error}
          <button type="button" className="btn-close ms-2" aria-label="Dismiss"
                  onClick={() => setError(null)} />
        </div>
      )}

      {/* Tiles. FLEX + aspect-ratio, never grid-cols-* — YZEN's own .grid
          silently flattens those and the wall collapses to one column. */}
      <div style={{
        flex: 1, display: 'flex', flexWrap: 'wrap', gap: 12,
        padding: 12, alignContent: 'center', justifyContent: 'center',
        overflowY: 'auto',
      }}>
        {shown.map((p) => (
          <Tile key={p.identity} p={p} big={view === 'speaker'}
                local={p === room?.localParticipant}
                showScreen={p === screenSharer}
                canHost={isHost && meeting !== null && p !== room?.localParticipant}
                onMute={() => void hostAction(() => connectApi.mute(authedFetch, meeting!.id, p.identity))}
                onRemove={() => void hostAction(() => connectApi.remove(authedFetch, meeting!.id, p.identity))} />
        ))}
      </div>

      {view === 'speaker' && participants.length > 1 && (
        <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px', overflowX: 'auto' }}>
          {participants.filter((p) => p !== speaker).map((p) => (
            <div key={p.identity} style={{ width: 160, flex: '0 0 auto' }}>
              <Tile p={p} big={false} local={p === room?.localParticipant}
                    showScreen={false} canHost={false} onMute={() => {}} onRemove={() => {}} />
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="d-flex align-items-center justify-content-center gap-2 flex-wrap p-3"
           style={{ background: '#17171d', borderTop: '1px solid #26262f' }}>
        <button type="button" className={`btn ${micOn ? 'btn-light' : 'btn-danger'}`}
                onClick={() => void toggleMic()} aria-pressed={micOn}>
          <i className={micOn ? 'ri-mic-line' : 'ri-mic-off-line'} />
          <span className="ms-1 d-none d-sm-inline">{micOn ? 'Mute' : 'Unmute'}</span>
        </button>

        <button type="button" className={`btn ${camOn ? 'btn-light' : 'btn-danger'}`}
                onClick={() => void toggleCam()} aria-pressed={camOn}>
          <i className={camOn ? 'ri-vidicon-line' : 'ri-vidicon-off-line'} />
          <span className="ms-1 d-none d-sm-inline">{camOn ? 'Stop video' : 'Start video'}</span>
        </button>

        <button type="button" className={`btn ${sharing ? 'btn-primary' : 'btn-light'}`}
                onClick={() => void toggleShare()} aria-pressed={sharing}>
          <i className="ri-computer-line" />
          <span className="ms-1 d-none d-sm-inline">{sharing ? 'Stop sharing' : 'Share'}</span>
        </button>

        <button type="button" className="btn btn-light"
                onClick={() => setView(view === 'gallery' ? 'speaker' : 'gallery')}>
          <i className={view === 'gallery' ? 'ri-layout-grid-line' : 'ri-user-line'} />
          <span className="ms-1 d-none d-sm-inline">{view === 'gallery' ? 'Gallery' : 'Speaker'}</span>
        </button>

        <button type="button" className="btn btn-light" onClick={() => setChatOpen(!chatOpen)}>
          <i className="ri-chat-1-line" />
          <span className="ms-1 d-none d-sm-inline">Chat</span>
        </button>

        <button type="button" className="btn btn-light" onClick={() => setDevicesOpen(!devicesOpen)}>
          <i className="ri-settings-3-line" />
        </button>

        {isHost && meeting && (
          <button type="button" className="btn btn-outline-danger"
                  onClick={() => void hostAction(() => connectApi.end(authedFetch, meeting.id))}>
            End for everyone
          </button>
        )}

        <button type="button" className="btn btn-danger" onClick={leave}>
          <i className="ri-logout-box-r-line" />
          <span className="ms-1 d-none d-sm-inline">Leave</span>
        </button>
      </div>

      {/* Overlays sit at 1200: YZEN's own sticky header and rail claim the
          hundreds, and a panel that renders behind them looks like a click
          that did nothing. */}
      {devicesOpen && (
        <Panel title="Devices" onClose={() => setDevicesOpen(false)}>
          <label className="form-label" htmlFor="cam">Camera</label>
          <select id="cam" className="form-select mb-3"
                  onChange={(e) => void switchDevice('videoinput', e.target.value)}>
            {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
          </select>
          <label className="form-label" htmlFor="mic">Microphone</label>
          <select id="mic" className="form-select"
                  onChange={(e) => void switchDevice('audioinput', e.target.value)}>
            {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
          </select>
          {cams.length === 0 && mics.length === 0 && (
            <div className="text-secondary fs-13 mt-2">
              Device names appear once the browser has granted the camera or microphone.
            </div>
          )}
        </Panel>
      )}

      {chatOpen && (
        <Panel title="Chat" onClose={() => setChatOpen(false)}>
          <div className="text-secondary fs-12 mb-2">
            Messages are not saved. When the meeting ends, this goes with it.
          </div>
          <div style={{ maxHeight: '45vh', overflowY: 'auto' }} className="mb-2">
            {chat.length === 0 && <div className="text-secondary fs-13">Nothing yet.</div>}
            {chat.map((c) => (
              <div key={c.id} className="mb-2">
                <span className="fw-semibold">{c.mine ? 'You' : c.who}</span>
                <div>{c.text}</div>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="input-group">
            <input className="form-control" value={draft} maxLength={2000}
                   onChange={(e) => setDraft(e.target.value)}
                   placeholder="Message everyone" aria-label="Message" />
            <button className="btn btn-primary" type="submit">Send</button>
          </form>
        </Panel>
      )}
    </div>
  );
}

// ===========================================================================
function Panel({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{
      position: 'fixed', right: 12, bottom: 88, width: 320, zIndex: 1200,
      background: '#1c1c24', border: '1px solid #2c2c38', borderRadius: 10, padding: 16,
      boxShadow: '0 10px 40px rgba(0,0,0,.5)',
    }}>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <span className="fw-semibold">{title}</span>
        <button type="button" className="btn btn-sm btn-light" onClick={onClose} aria-label="Close">
          <i className="ri-close-line" />
        </button>
      </div>
      {children}
    </div>
  );
}

// ===========================================================================
function Tile({ p, big, local, showScreen, canHost, onMute, onRemove }: {
  p: LKParticipant;
  big: boolean;
  local: boolean;
  showScreen: boolean;
  canHost: boolean;
  onMute: () => void;
  onRemove: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const source = showScreen ? Track.Source.ScreenShare : Track.Source.Camera;
  const videoPub = p.getTrackPublication(source);
  const audioPub = p.getTrackPublication(Track.Source.Microphone);
  const videoTrack = videoPub?.videoTrack;
  const audioTrack = audioPub?.audioTrack;
  const camOff = !videoTrack || videoPub?.isMuted === true;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoTrack) return;
    videoTrack.attach(el);
    return () => { videoTrack.detach(el); };
  }, [videoTrack]);

  useEffect(() => {
    const el = audioRef.current;
    // Never attach your OWN microphone: the browser plays it straight back and
    // the room howls.
    if (!el || !audioTrack || local) return;
    audioTrack.attach(el);
    return () => { audioTrack.detach(el); };
  }, [audioTrack, local]);

  const name = p.name && p.name.length > 0 ? p.name : p.identity;

  return (
    <div style={{
      position: 'relative',
      // aspect-ratio + a flex basis, never a grid column class.
      flex: big ? '1 1 100%' : '1 1 320px',
      maxWidth: big ? '100%' : 520,
      aspectRatio: '16 / 9',
      background: '#000', borderRadius: 10, overflow: 'hidden',
      outline: p.isSpeaking ? '2px solid #28c76f' : '1px solid #26262f',
    }}>
      <video ref={videoRef} autoPlay playsInline muted={local}
             style={{ width: '100%', height: '100%', objectFit: 'cover',
                      display: camOff ? 'none' : 'block' }} />
      {!local && <audio ref={audioRef} autoPlay />}

      {camOff && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: '#9a9aa8',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%', background: '#26262f',
            display: 'grid', placeItems: 'center', fontSize: 24, fontWeight: 700,
            color: '#f4f4f6',
          }}>
            {name.charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      <div style={{
        position: 'absolute', left: 8, bottom: 8, display: 'flex',
        alignItems: 'center', gap: 6, background: 'rgba(0,0,0,.55)',
        padding: '2px 8px', borderRadius: 6, fontSize: 12,
      }}>
        {audioPub?.isMuted !== false && <i className="ri-mic-off-line" aria-label="Muted" />}
        <span>{local ? `${name} (you)` : name}</span>
      </div>

      {canHost && (
        <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-light" onClick={onMute}>Mute</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
/**
 * A denial is sticky and the prompt never returns, so it earns specific copy
 * rather than a generic failure. Everything else is left to the caller.
 */
function noteBlocked(e: unknown, set: (m: string | null) => void) {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    set('Your browser is blocking the camera or microphone for this site. '
      + 'Click the padlock in the address bar, allow them, then reload — the '
      + 'prompt will not appear again on its own.');
    return;
  }
  if (name === 'NotFoundError') { set('No camera or microphone was found on this device.'); return; }
  if (name === 'NotReadableError') {
    set('Another app is using your camera. Close it and press Start video again.');
    return;
  }
  set(null);
}
