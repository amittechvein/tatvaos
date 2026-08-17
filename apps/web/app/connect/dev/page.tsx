'use client';

/**
 * Connect Phase 0 — the throwaway media-path test page.
 *
 * DELIBERATELY disposable: this file is deleted the day the real room screen
 * exists. It proves exactly one thing — two browsers, two networks, audio and
 * video both ways through our LiveKit + coturn — and nothing else.
 *
 * House rules it still follows, because they are cheap and the habits matter:
 *  - No AppShell, no useAuth: like the future guest room screen, it must
 *    render with no session at all (brief §6).
 *  - No useSearchParams — the token is pasted, so there is nothing to put in
 *    the URL and no Suspense trap to trip the production build.
 *  - Tokens are minted on the box with infra/scripts/connect-dev-token.sh and
 *    pasted here. No secret ever appears in this page or its bundle.
 *  - Video tiles are flex + aspect-ratio, not grid-cols-* (overrides.css §grid).
 *  - No `any`: eslint.config.mjs extends next/typescript, where
 *    @typescript-eslint/no-explicit-any is an ERROR and therefore a failed
 *    production build. The SDK surface used here is described structurally
 *    below instead.
 *
 * The SDK loads from the CDN as a UMD bundle so package.json and the lockfile
 * — shared files — stay untouched in Phase 0. Phase 1 adds livekit-client as
 * a real dependency, agreed with Core.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

// ---------------------------------------------------------------------------
//  The slice of livekit-client this page actually touches. Structural types,
//  not the real SDK ones: the bundle arrives at runtime from a CDN, so there
//  is nothing to import types from, and a hand-written surface is honest
//  about exactly how much of the SDK Phase 0 depends on.
// ---------------------------------------------------------------------------

type MediaTrackLike = {
  kind: string;
  attach: () => HTMLMediaElement;
  detach: () => HTMLElement[];
};

type PublicationLike = { kind: string; track?: MediaTrackLike | null };

type ParticipantLike = { identity: string };

type LocalParticipantLike = {
  identity: string;
  enableCameraAndMicrophone: () => Promise<void>;
};

/**
 * `never[]` rather than `unknown[]`: parameters are contravariant, so a
 * handler declared `(p: ParticipantLike) => void` is assignable to this,
 * while `unknown[]` would reject every typed handler below.
 */
type RoomHandler = (...args: never[]) => void;

type RoomLike = {
  localParticipant: LocalParticipantLike;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  on: (event: string, handler: RoomHandler) => RoomLike;
};

type RoomOptions = {
  adaptiveStream: boolean;
  dynacast: boolean;
  rtcConfig?: RTCConfiguration;
};

/**
 * Only the events this page subscribes to. Named explicitly rather than
 * Record<string, string> because noUncheckedIndexedAccess would then type
 * every lookup as `string | undefined` and `on()` would refuse it.
 */
type RoomEventNames = {
  ConnectionStateChanged: string;
  ParticipantConnected: string;
  ParticipantDisconnected: string;
  TrackSubscribed: string;
  TrackUnsubscribed: string;
  Disconnected: string;
  LocalTrackPublished: string;
};

type LiveKitSdk = {
  Room: new (options: RoomOptions) => RoomLike;
  RoomEvent: RoomEventNames;
};

declare global {
  interface Window {
    LivekitClient?: LiveKitSdk;
  }
}

const SDK_URL =
  'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js';

const inputStyle: CSSProperties = {
  width: '100%',
  background: '#12151c',
  border: '1px solid #2a2f3a',
  borderRadius: 6,
  color: '#e6e9ef',
  padding: '8px 10px',
  fontSize: 13,
  marginTop: 4,
};

const labelStyle: CSSProperties = { fontSize: 12, color: '#8b93a3' };

const buttonStyle: CSSProperties = {
  border: 0,
  borderRadius: 6,
  padding: '9px 18px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export default function ConnectDevPage() {
  const [sdkReady, setSdkReady] = useState(false);
  // The ORIGIN only — no /rtc suffix. livekit-client appends the signalling
  // path itself (createV0RtcUrl appends 'rtc', then 'v1' for the versioned
  // path), so a base ending in /rtc produces /rtc/rtc/v1 and LiveKit answers
  // 401. Caddy's `handle /rtc*` on this hostname covers /rtc, /rtc/v1 and
  // /rtc/v1/validate alike.
  const [wsUrl, setWsUrl] = useState('wss://connect.tatvaos.com');
  const [token, setToken] = useState('');
  const [forceTurn, setForceTurn] = useState(false);
  const [turnUrl, setTurnUrl] = useState('turn:connect.tatvaos.com:3478');
  const [turnUser, setTurnUser] = useState('tatvaos');
  const [turnPass, setTurnPass] = useState('');
  const [connState, setConnState] = useState('disconnected');
  const [lines, setLines] = useState<string[]>([]);

  const roomRef = useRef<RoomLike | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const remoteRef = useRef<HTMLDivElement | null>(null);

  function log(message: string) {
    const stamp = new Date().toISOString().slice(11, 19);
    setLines((prev) => [...prev.slice(-199), `${stamp}  ${message}`]);
  }

  // Deliberately dependency-free: setLines is stable, so this effect runs once
  // and never trips react-hooks/exhaustive-deps.
  useEffect(() => {
    if (window.LivekitClient) {
      setSdkReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.onload = () => setSdkReady(true);
    script.onerror = () =>
      setLines((prev) => [...prev, 'FAILED to load livekit-client from the CDN']);
    document.head.appendChild(script);
  }, []);

  function tile(element: HTMLMediaElement, label: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'flex:1 1 320px;max-width:640px;aspect-ratio:16/9;position:relative;' +
      'background:#12151c;border:1px solid #2a2f3a;border-radius:8px;overflow:hidden';
    element.style.cssText = 'width:100%;height:100%;object-fit:cover';
    const tag = document.createElement('span');
    tag.textContent = label;
    tag.style.cssText =
      'position:absolute;left:8px;bottom:6px;color:#cdd3de;font-size:12px;' +
      'background:rgba(0,0,0,.55);padding:2px 8px;border-radius:4px';
    wrap.append(element, tag);
    return wrap;
  }

  async function join() {
    const lk = window.LivekitClient;
    if (!lk || roomRef.current) return;

    const options: RoomOptions = { adaptiveStream: true, dynacast: true };
    if (forceTurn) {
      // A pass with this box ticked cannot secretly be a direct connection —
      // relay-only is what makes step 3 of the test protocol mean something.
      options.rtcConfig = {
        iceTransportPolicy: 'relay',
        iceServers: [{ urls: [turnUrl], username: turnUser, credential: turnPass }],
      };
      log(`forcing TURN via ${turnUrl}`);
    }

    const room = new lk.Room(options);
    roomRef.current = room;
    const events = lk.RoomEvent;

    room.on(events.ConnectionStateChanged, (state: string) => {
      setConnState(String(state));
      log(`connection: ${String(state)}`);
    });
    room.on(events.ParticipantConnected, (p: ParticipantLike) => log(`joined: ${p.identity}`));
    room.on(events.ParticipantDisconnected, (p: ParticipantLike) => log(`left: ${p.identity}`));
    room.on(
      events.TrackSubscribed,
      (track: MediaTrackLike, _pub: PublicationLike, p: ParticipantLike) => {
        log(`subscribed ${track.kind} from ${p.identity}`);
        const element = track.attach();
        if (track.kind === 'video') remoteRef.current?.appendChild(tile(element, p.identity));
        else document.body.appendChild(element); // audio elements are invisible
      },
    );
    room.on(events.TrackUnsubscribed, (track: MediaTrackLike) => {
      for (const element of track.detach()) {
        const wrap = element.parentElement;
        if (wrap && wrap.parentElement === remoteRef.current) wrap.remove();
        else element.remove();
      }
    });
    room.on(events.Disconnected, () => {
      setConnState('disconnected');
      log('disconnected');
      remoteRef.current?.replaceChildren();
      localRef.current?.replaceChildren();
      roomRef.current = null;
    });
    room.on(events.LocalTrackPublished, (pub: PublicationLike) => {
      if (pub.kind === 'video' && pub.track && localRef.current) {
        localRef.current.replaceChildren(tile(pub.track.attach(), 'you'));
      }
    });

    try {
      log(`connecting to ${wsUrl} …`);
      await room.connect(wsUrl.trim(), token.trim());
      log(`connected as ${room.localParticipant.identity}`);
      await room.localParticipant.enableCameraAndMicrophone();
      log('camera + microphone on');
    } catch (error) {
      log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      roomRef.current = null;
    }
  }

  async function leave() {
    await roomRef.current?.disconnect();
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: '#0b0d12',
        color: '#e6e9ef',
        padding: 20,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            Connect — Phase 0 media test
          </h1>
          <p style={{ color: '#8b93a3', fontSize: 13, margin: '4px 0 0' }}>
            Throwaway page. Paste a token minted on the box, join from two networks, then
            force TURN and do it again. State:{' '}
            <strong style={{ color: connState === 'connected' ? '#3ddc84' : '#e6b45a' }}>
              {connState}
            </strong>
            {sdkReady ? '' : ' — loading SDK…'}
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <label style={{ ...labelStyle, flex: '2 1 320px' }}>
            Signalling URL
            <input
              style={inputStyle}
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
            />
          </label>
          <label style={{ ...labelStyle, flex: '3 1 380px' }}>
            Access token (infra/scripts/connect-dev-token.sh)
            <textarea
              style={{ ...inputStyle, height: 58, resize: 'vertical' }}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label
            style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={forceTurn}
              onChange={(e) => setForceTurn(e.target.checked)}
            />
            Force TURN (relay only)
          </label>

          {forceTurn ? (
            <>
              <label style={{ ...labelStyle, flex: '2 1 240px' }}>
                TURN URL
                <input
                  style={inputStyle}
                  value={turnUrl}
                  onChange={(e) => setTurnUrl(e.target.value)}
                />
              </label>
              <label style={{ ...labelStyle, flex: '1 1 140px' }}>
                TURN user
                <input
                  style={inputStyle}
                  value={turnUser}
                  onChange={(e) => setTurnUser(e.target.value)}
                />
              </label>
              <label style={{ ...labelStyle, flex: '1 1 140px' }}>
                TURN password
                <input
                  type="password"
                  style={inputStyle}
                  value={turnPass}
                  onChange={(e) => setTurnPass(e.target.value)}
                />
              </label>
            </>
          ) : null}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={{
                ...buttonStyle,
                background: '#03b562',
                color: '#fff',
                opacity: sdkReady && token ? 1 : 0.5,
              }}
              disabled={!sdkReady || !token || connState === 'connected'}
              onClick={() => void join()}
            >
              Join
            </button>
            <button
              type="button"
              style={{ ...buttonStyle, background: '#2a2f3a', color: '#e6e9ef' }}
              onClick={() => void leave()}
            >
              Leave
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div
            ref={localRef}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 12, flex: '1 1 320px' }}
          />
          <div
            ref={remoteRef}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 12, flex: '2 1 480px' }}
          />
        </div>

        <pre
          style={{
            background: '#12151c',
            border: '1px solid #2a2f3a',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            color: '#8b93a3',
            maxHeight: 220,
            overflowY: 'auto',
            margin: 0,
          }}
        >
          {lines.join('\n') || 'log output appears here'}
        </pre>
      </div>
    </div>
  );
}
