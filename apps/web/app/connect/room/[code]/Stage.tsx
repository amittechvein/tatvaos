'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Room, RoomEvent, Track, DisconnectReason,
  type Participant as LKParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { useAuth } from '@/lib/auth';
import { connectApi, type LobbyEntry, type Meeting, type Seat } from '@/lib/connect';
import { CSS, Centre, Spinner, initialOf } from './RoomChrome';

const LOBBY_POLL_MS = 3000;

// ===========================================================================
//  The live meeting
// ===========================================================================
interface ChatLine { id: number; who: string; text: string; mine: boolean }
type PanelKind = 'people' | 'chat' | 'devices' | null;

export default function Stage({ seat, meeting }: { seat: Seat; meeting: Meeting | null }) {
  const { authedFetch } = useAuth();
  const roomRef = useRef<Room | null>(null);

  const [room, setRoom] = useState<Room | null>(null);
  // livekit-client mutates its Room in place; React cannot see that. Every SDK
  // event bumps this, which is the only thing that makes the room's current
  // state reach the screen. The value itself is never read.
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [connState, setConnState] = useState<'connecting' | 'live' | 'reconnecting' | 'over'>('connecting');
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [view, setView] = useState<'gallery' | 'speaker'>('gallery');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [knocking, setKnocking] = useState<LobbyEntry[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [why, setWhy] = useState<DisconnectReason | undefined>(undefined);

  const isHost = meeting?.myRole === 'host' || meeting?.myRole === 'cohost';

  // The SDK handlers are registered once, so they close over the FIRST render's
  // state. `panel` read directly inside one would be permanently null. A ref
  // updated every render is the standard way out.
  const panelRef = useRef<PanelKind>(null);
  panelRef.current = panel;

  // ---------------------------------------------------------------------
  useEffect(() => {
    const r = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = r;
    setRoom(r);

    r.on(RoomEvent.Connected, () => { setConnState('live'); rerender(); })
      // The REASON is kept, not just the fact. Telling somebody the host
      // removed them "you have left the meeting" is a lie they will argue with.
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        setWhy(reason); setConnState('over'); rerender();
      })
      // Reconnecting is NOT an error. Dropping wifi in a lift is ordinary; the
      // SDK re-establishes and the meeting continues. Saying "the meeting
      // ended" here makes people rejoin a call they never left.
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
          // Not unread if they are looking at it. Counting anyway leaves a
          // badge for messages already read the moment the panel closes.
          if (panelRef.current !== 'chat') setUnread((n) => n + 1);
        } catch {
          // Chat is ephemeral and best-effort. A malformed frame from a client
          // we do not control is dropped, never thrown.
        }
      });

    void (async () => {
      try {
        await r.connect(seat.wsUrl, seat.token);
        // Mic and camera are attempted separately and each failure survivable:
        // joining audio-only because the camera is busy is a normal way to
        // attend a meeting.
        try { await r.localParticipant.setMicrophoneEnabled(true); setMicOn(true); }
        catch (e) { noteBlocked(e, setBlocked); }
        try { await r.localParticipant.setCameraEnabled(true); setCamOn(true); }
        catch (e) { noteBlocked(e, setBlocked); }
        rerender();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not connect to the meeting.');
        setConnState('over');
      }
    })();

    return () => { void r.disconnect(); roomRef.current = null; };
  }, [seat.wsUrl, seat.token, rerender]);

  // Device labels are blank until permission exists, so a menu built too early
  // is a list of empty strings.
  useEffect(() => {
    if (!camOn && !micOn) return;
    void (async () => {
      try {
        setCams(await Room.getLocalDevices('videoinput'));
        setMics(await Room.getLocalDevices('audioinput'));
      } catch { /* enumeration can fail; the toggles still work */ }
    })();
  }, [camOn, micOn]);

  // ---------------------------------------------------------------------
  //  The door, from inside the room.
  //
  //  Hosts used to have to leave the meeting and open the meeting page to let
  //  somebody in — which nobody does mid-call, so guests waited until they
  //  gave up. Polled here only while it can matter: a host, in a live meeting,
  //  with a waiting room actually switched on.
  // ---------------------------------------------------------------------
  const lobbyLive = isHost && meeting !== null && meeting.waitingRoom !== 'off'
    && (connState === 'live' || connState === 'reconnecting');

  useEffect(() => {
    if (!lobbyLive || !meeting) { setKnocking([]); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await connectApi.lobby(authedFetch, meeting.id);
        if (alive) setKnocking(r.waiting);
      } catch {
        // A failed poll is not worth a banner — the next is three seconds away,
        // and an error that clears itself teaches people to ignore errors.
      }
    };
    void tick();
    const t = setInterval(() => void tick(), LOBBY_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [lobbyLive, meeting, authedFetch]);

  async function decide(entry: LobbyEntry, admit: boolean) {
    if (!meeting) return;
    setDeciding(entry.requestId);
    try {
      await (admit
        ? connectApi.admit(authedFetch, meeting.id, entry.requestId)
        : connectApi.deny(authedFetch, meeting.id, entry.requestId));
      // Drop it immediately so the card cannot be clicked twice while the next
      // poll is in flight — admitting the same person twice is confusing, and
      // the poll will correct us within three seconds either way.
      setKnocking((k) => k.filter((x) => x.requestId !== entry.requestId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not answer the door.');
    } finally {
      setDeciding(null);
    }
  }

  // ---------------------------------------------------------------------
  // Read fresh every render rather than memoised: the input is a mutable SDK
  // object, so a dependency array could only be a guess about when it changed
  // — and a stale guess shows people who have left.
  const participants: LKParticipant[] = room
    ? [room.localParticipant as LKParticipant, ...Array.from(room.remoteParticipants.values())]
    : [];

  const screenSharer = participants.find(
    (p) => p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack,
  );
  const speaker = screenSharer
    ?? participants.find((p) => p.isSpeaking && p !== room?.localParticipant)
    ?? participants[0];

  // Keyed on identity, not the object: the object is rebuilt every render, so
  // depending on it would pin the view to speaker and undo every click on
  // Gallery on the next frame.
  const sharerId = screenSharer?.identity ?? null;
  useEffect(() => { if (sharerId) setView('speaker'); }, [sharerId]);

  // ---------------------------------------------------------------------
  async function toggleCam() {
    const r = roomRef.current; if (!r) return;
    try { await r.localParticipant.setCameraEnabled(!camOn); setCamOn(!camOn); setBlocked(null); }
    catch (e) { noteBlocked(e, setBlocked); }
  }
  async function toggleMic() {
    const r = roomRef.current; if (!r) return;
    try { await r.localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn); setBlocked(null); }
    catch (e) { noteBlocked(e, setBlocked); }
  }
  async function toggleShare() {
    const r = roomRef.current; if (!r) return;
    try { await r.localParticipant.setScreenShareEnabled(!sharing); setSharing(!sharing); }
    catch { setSharing(false); }  // cancelling the picker throws; that is a decision, not a fault
  }
  async function switchDevice(kind: MediaDeviceKind, deviceId: string) {
    const r = roomRef.current; if (!r) return;
    try { await r.switchActiveDevice(kind, deviceId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not switch device.'); }
  }
  function send(e: React.FormEvent) {
    e.preventDefault();
    const r = roomRef.current;
    const text = draft.trim();
    if (!r || text.length === 0) return;
    void r.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ text })), { reliable: true });
    setChat((c) => [...c, { id: c.length, who: 'You', text, mine: true }]);
    setDraft('');
  }
  async function hostAction(fn: () => Promise<void>) {
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
  }
  async function copyLink() {
    if (!meeting) return;
    try {
      await navigator.clipboard.writeText(meeting.joinUrl);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { setError('Copy the link from the meeting page.'); }
  }
  function openPanel(k: PanelKind) {
    setPanel(panel === k ? null : k);
    if (k === 'chat') setUnread(0);
  }
  function leave() { void roomRef.current?.disconnect(); setConnState('over'); }

  // ---------------------------------------------------------------------
  if (connState === 'over') {
    const { headline, detail, rejoin } = endingFor(why);
    return (
      <Centre>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{headline}</h1>
        {detail && (
          <p style={{ color: '#9b9bab', maxWidth: 420, marginBottom: 16 }}>{detail}</p>
        )}
        {error && <p style={{ color: '#ffb3bb', marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          {rejoin && (
            <button type="button" className="cx-cta" style={{ width: 'auto', padding: '11px 20px' }}
                    onClick={() => window.location.reload()}>Rejoin</button>
          )}
          <Link href="/connect" className="cx-mini" style={{ display: 'grid', placeItems: 'center' }}>
            Back to Connect
          </Link>
        </div>
      </Centre>
    );
  }

  const shown = view === 'speaker' && speaker ? [speaker] : participants;
  const others = view === 'speaker' ? participants.filter((p) => p !== speaker) : [];

  return (
    <>
      <style>{CSS}</style>
      <div className="cx-root">
        <header className="cx-top">
          <div style={{ minWidth: 0 }}>
            <div className="cx-title">{meeting?.title ?? 'Meeting'}</div>
            <div className="cx-meta">
              {connState === 'live' && <span className="cx-dot" aria-hidden="true" />}
              <span>{participants.length} {participants.length === 1 ? 'person' : 'people'}</span>
              {meeting?.locked && <span>· Locked</span>}
            </div>
          </div>
          <div className="cx-ghost">
            {meeting && (
              <button type="button" className="cx-mini" onClick={() => void copyLink()}>
                <i className="ri-link me-1" />{copied ? 'Copied' : 'Copy link'}
              </button>
            )}
          </div>
        </header>

        {connState === 'reconnecting' && (
          <div className="cx-banner cx-banner--warn" role="status">
            <Spinner /> <span className="ms-2">Connection lost — reconnecting. Stay on this page.</span>
          </div>
        )}
        {blocked && <div className="cx-banner cx-banner--bad" role="alert">{blocked}</div>}
        {error && (
          <div className="cx-banner cx-banner--bad" role="alert">
            {error}
            <button type="button" className="cx-x ms-2" aria-label="Dismiss"
                    onClick={() => setError(null)}>×</button>
          </div>
        )}

        <div className="cx-stage">
          {shown.map((p) => (
            <Tile key={p.identity} p={p} big={view === 'speaker'}
                  local={p === room?.localParticipant}
                  showScreen={p === screenSharer}
                  canHost={isHost && meeting !== null && p !== room?.localParticipant}
                  onMute={() => void hostAction(() =>
                    connectApi.mute(authedFetch, meeting?.id ?? '', p.identity))}
                  onRemove={() => void hostAction(() =>
                    connectApi.remove(authedFetch, meeting?.id ?? '', p.identity))} />
          ))}
        </div>

        {others.length > 0 && (
          <div className="cx-strip">
            {others.map((p) => (
              <Tile key={p.identity} p={p} big={false} local={p === room?.localParticipant}
                    showScreen={false} canHost={false} onMute={() => {}} onRemove={() => {}} />
            ))}
          </div>
        )}

        <div className="cx-bar">
          <button type="button" className={`cx-btn ${micOn ? '' : 'is-off'}`}
                  onClick={() => void toggleMic()} aria-pressed={micOn}
                  title={micOn ? 'Mute' : 'Unmute'}>
            <i className={micOn ? 'ri-mic-line' : 'ri-mic-off-line'} />
            {micOn ? 'Mute' : 'Unmute'}
          </button>

          <button type="button" className={`cx-btn ${camOn ? '' : 'is-off'}`}
                  onClick={() => void toggleCam()} aria-pressed={camOn}
                  title={camOn ? 'Stop video' : 'Start video'}>
            <i className={camOn ? 'ri-vidicon-line' : 'ri-vidicon-off-line'} />
            {camOn ? 'Video' : 'Video'}
          </button>

          <button type="button" className={`cx-btn ${sharing ? 'is-on' : ''}`}
                  onClick={() => void toggleShare()} aria-pressed={sharing} title="Share your screen">
            <i className="ri-computer-line" />
            {sharing ? 'Stop' : 'Share'}
          </button>

          <button type="button" className="cx-btn"
                  onClick={() => setView(view === 'gallery' ? 'speaker' : 'gallery')}
                  title="Switch layout">
            <i className={view === 'gallery' ? 'ri-layout-grid-line' : 'ri-user-3-line'} />
            {view === 'gallery' ? 'Gallery' : 'Speaker'}
          </button>

          <span className="cx-btnwrap">
            <button type="button" className={`cx-btn ${panel === 'people' ? 'is-on' : ''}`}
                    onClick={() => openPanel('people')} title="People">
              <i className="ri-group-line" />People
            </button>
            {knocking.length > 0 && <span className="cx-count">{knocking.length}</span>}
          </span>

          <span className="cx-btnwrap">
            <button type="button" className={`cx-btn ${panel === 'chat' ? 'is-on' : ''}`}
                    onClick={() => openPanel('chat')} title="Chat">
              <i className="ri-chat-1-line" />Chat
            </button>
            {unread > 0 && panel !== 'chat' && <span className="cx-count">{unread}</span>}
          </span>

          <button type="button" className={`cx-btn ${panel === 'devices' ? 'is-on' : ''}`}
                  onClick={() => openPanel('devices')} title="Settings">
            <i className="ri-settings-3-line" />Settings
          </button>

          {isHost && meeting && (
            <button type="button" className="cx-btn"
                    onClick={() => void hostAction(() => connectApi.end(authedFetch, meeting.id))}
                    title="End the meeting for everyone">
              <i className="ri-stop-circle-line" />End
            </button>
          )}

          <button type="button" className="cx-btn cx-btn--leave" onClick={leave} title="Leave">
            <i className="ri-logout-box-r-line" />Leave
          </button>
        </div>

        {/* Somebody at the door, over the video. A request that only lives in a
            panel is a person left standing outside. */}
        {knocking.length > 0 && (
          <div className="cx-knocks">
            {knocking.slice(0, 3).map((k) => (
              <div className="cx-knock" key={k.requestId}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="cx-av">{initialOf(k.displayName)}</span>
                  <div className="cx-grow">
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{k.displayName}</div>
                    <div className="cx-sub">
                      {k.isGuest ? 'Guest — wants to join' : 'Wants to join'}
                    </div>
                  </div>
                </div>
                <div className="cx-knock-acts">
                  <button type="button" className="cx-yes" disabled={deciding === k.requestId}
                          onClick={() => void decide(k, true)}>Let in</button>
                  <button type="button" className="cx-no" disabled={deciding === k.requestId}
                          onClick={() => void decide(k, false)}>Turn away</button>
                </div>
              </div>
            ))}
            {knocking.length > 3 && (
              <button type="button" className="cx-mini" onClick={() => openPanel('people')}>
                {knocking.length - 3} more waiting
              </button>
            )}
          </div>
        )}

        {panel === 'people' && (
          <Panel title={`People (${participants.length})`} onClose={() => setPanel(null)}>
            {isHost && knocking.length > 0 && (
              <>
                <div className="cx-sub" style={{ marginBottom: 6 }}>WAITING</div>
                {knocking.map((k) => (
                  <div className="cx-row" key={k.requestId}>
                    <span className="cx-av">{initialOf(k.displayName)}</span>
                    <div className="cx-grow">
                      <div>{k.displayName}</div>
                      <div className="cx-sub">{k.isGuest ? 'Guest' : 'Colleague'}</div>
                    </div>
                    <button type="button" className="cx-pill" disabled={deciding === k.requestId}
                            onClick={() => void decide(k, true)}>Let in</button>
                    <button type="button" className="cx-pill cx-pill--bad" disabled={deciding === k.requestId}
                            onClick={() => void decide(k, false)}>No</button>
                  </div>
                ))}
                <div className="cx-sub" style={{ margin: '16px 0 6px' }}>IN THE MEETING</div>
              </>
            )}
            {participants.map((p) => {
              const nm = p.name && p.name.length > 0 ? p.name : p.identity;
              const muted = p.getTrackPublication(Track.Source.Microphone)?.isMuted !== false;
              return (
                <div className="cx-row" key={p.identity}>
                  <span className="cx-av">{initialOf(nm)}</span>
                  <div className="cx-grow">
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {nm}{p === room?.localParticipant ? ' (you)' : ''}
                    </div>
                    <div className="cx-sub">{muted ? 'Muted' : 'Speaking'}</div>
                  </div>
                  {isHost && meeting && p !== room?.localParticipant && (
                    <>
                      <button type="button" className="cx-pill"
                              onClick={() => void hostAction(() =>
                                connectApi.mute(authedFetch, meeting.id, p.identity))}>Mute</button>
                      <button type="button" className="cx-pill cx-pill--bad"
                              onClick={() => void hostAction(() =>
                                connectApi.remove(authedFetch, meeting.id, p.identity))}>Remove</button>
                    </>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {panel === 'chat' && (
          <Panel title="Chat" onClose={() => setPanel(null)}
                 foot={
                   <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
                     <input className="cx-field" value={draft} maxLength={2000}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder="Message everyone" aria-label="Message" />
                     <button className="cx-cta" style={{ width: 'auto', padding: '10px 16px' }}
                             type="submit">Send</button>
                   </form>
                 }>
            <div className="cx-sub" style={{ marginBottom: 10 }}>
              Messages are not saved. When the meeting ends, this goes with it.
            </div>
            {chat.length === 0 && <div className="cx-sub">Nothing yet.</div>}
            {chat.map((c) => (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: c.mine ? '#8fe6f6' : undefined }}>
                  {c.mine ? 'You' : c.who}
                </div>
                <div style={{ fontSize: 14, wordBreak: 'break-word' }}>{c.text}</div>
              </div>
            ))}
          </Panel>
        )}

        {panel === 'devices' && (
          <Panel title="Settings" onClose={() => setPanel(null)}>
            <label className="cx-label" htmlFor="cx-cam">Camera</label>
            <select id="cx-cam" className="cx-field" style={{ marginBottom: 16 }}
                    onChange={(e) => void switchDevice('videoinput', e.target.value)}>
              {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
            </select>
            <label className="cx-label" htmlFor="cx-mic">Microphone</label>
            <select id="cx-mic" className="cx-field"
                    onChange={(e) => void switchDevice('audioinput', e.target.value)}>
              {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
            </select>
            {cams.length === 0 && mics.length === 0 && (
              <div className="cx-sub" style={{ marginTop: 12 }}>
                Device names appear once the browser has granted the camera or microphone.
              </div>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}

// ===========================================================================
function Panel({ title, onClose, children, foot }: {
  title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode;
}) {
  return (
    <aside className="cx-panel" role="dialog" aria-label={title}>
      <div className="cx-panel-head">
        <span>{title}</span>
        <button type="button" className="cx-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="cx-panel-body">{children}</div>
      {foot && <div className="cx-panel-foot">{foot}</div>}
    </aside>
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
  const name = p.name && p.name.length > 0 ? p.name : p.identity;

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

  return (
    <div className={`cx-tile${big ? ' cx-tile--big' : ''}${p.isSpeaking ? ' is-speaking' : ''}`}>
      <video ref={videoRef} autoPlay playsInline muted={local}
             // Mirrored for yourself only, and never for a shared screen —
             // reading mirrored text is the definition of unusable.
             className={`cx-video${local && !showScreen ? ' cx-video--self' : ''}`}
             style={{ display: camOff ? 'none' : 'block' }} />
      {!local && <audio ref={audioRef} autoPlay />}

      {camOff && (
        <div className="cx-off">
          <div className="cx-initial">{initialOf(name)}</div>
        </div>
      )}

      <div className="cx-name">
        {audioPub?.isMuted !== false && <i className="ri-mic-off-line" aria-label="Muted" />}
        <span>{local ? `${name} (you)` : name}</span>
      </div>

      {canHost && (
        <div className="cx-tileacts">
          <button type="button" className="cx-pill" onClick={onMute}>Mute</button>
          <button type="button" className="cx-pill cx-pill--bad" onClick={onRemove}>Remove</button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
/**
 * Why the meeting ended, in words the person can act on.
 *
 * These are four genuinely different events and they used to share one
 * sentence. Being removed by a host and being told "you have left" is not a
 * wording quibble — it is the product denying something the person watched
 * happen, and the difference decides whether "Rejoin" is an honest offer.
 */
function endingFor(why: DisconnectReason | undefined): {
  headline: string; detail?: string; rejoin: boolean;
} {
  switch (why) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return {
        headline: 'You were removed from the meeting',
        detail: 'The host ended your connection. Ask them if you think that was a mistake.',
        // No Rejoin: the host just decided otherwise, and a button undoing that
        // by one click makes the control meaningless.
        rejoin: false,
      };
    case DisconnectReason.ROOM_DELETED:
      return {
        headline: 'The meeting has ended',
        detail: 'The host ended it for everyone.',
        rejoin: false,
      };
    case DisconnectReason.DUPLICATE_IDENTITY:
      return {
        headline: 'You joined from somewhere else',
        detail: 'This meeting was opened again in another tab or on another device, '
          + 'which takes over the connection. Close the other one and rejoin here.',
        rejoin: true,
      };
    case DisconnectReason.CLIENT_INITIATED:
      return { headline: 'You have left the meeting', rejoin: true };
    default:
      // SERVER_SHUTDOWN, SIGNAL_CLOSE, JOIN_FAILURE, UNKNOWN — from the
      // person's side these are all "it dropped", and rejoining is the answer.
      return {
        headline: 'The meeting disconnected',
        detail: 'The connection to the meeting was lost.',
        rejoin: true,
      };
  }
}

/**
 * A denial is sticky and the prompt never returns, so it earns specific copy
 * rather than a generic failure.
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
    set('Another app is using your camera. Close it and press Video again.');
    return;
  }
  set(null);
}
