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
 *  - Tokens are minted on the box with the LiveKit CLI (docs/CONNECT_PHASE0.md)
 *    and pasted here. No secret ever appears in this page or its bundle.
 *  - Video tiles are flex + aspect-ratio, not grid-cols-* (overrides.css §grid).
 *
 * The SDK loads from the CDN as a UMD bundle so package.json and the lockfile
 * — shared files — stay untouched in Phase 0. Phase 1 adds livekit-client as
 * a real dependency, agreed with Core.
 */

import { useEffect, useRef, useState } from 'react';

declare global {
  // The UMD bundle attaches itself here.
  interface Window { LivekitClient?: any }
}

const SDK_URL =
  'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js';

export default function ConnectDevPage() {
  const [sdkReady, setSdkReady] = useState(false);
  const [wsUrl, setWsUrl] = useState('wss://connect.tatvaos.com/rtc');
  const [token, setToken] = useState('');
  const [forceTurn, setForceTurn] = useState(false);
  const [turnUrl, setTurnUrl] = useState('turn:connect.tatvaos.com:3478');
  const [turnUser, setTurnUser] = useState('');
  const [turnPass, setTurnPass] = useState('');
  const [connState, setConnState] = useState('disconnected');
  const [lines, setLines] = useState<string[]>([]);

  const roomRef = useRef<any>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const remoteRef = useRef<HTMLDivElement | null>(null);

  const log = (m: string) =>
    setLines((l) => [...l.slice(-199), `${new Date().toISOString().slice(11, 19)}  ${m}`]);

  useEffect(() => {
    if (window.LivekitClient) { setSdkReady(true); return; }
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.onload = () => setSdkReady(true);
    s.onerror = () => log('FAILED to load livekit-client from the CDN');
    document.head.appendChild(s);
    return () => { void 0; };
  }, []);

  function tile(el: HTMLMediaElement, label: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'flex:1 1 320px;max-width:640px;aspect-ratio:16/9;position:relative;' +
      'background:#12151c;border:1px solid #2a2f3a;border-radius:8px;overflow:hidden';
    el.style.cssText = 'width:100%;height:100%;object-fit:cover';
    const tag = document.createElement('span');
    tag.textContent = label;
    tag.style.cssText =
      'position:absolute;left:8px;bottom:6px;color:#cdd3de;font-size:12px;' +
      'background:rgba(0,0,0,.55);padding:2px 8px;border-radius:4px';
    wrap.append(el, tag);
    return wrap;
  }

  async function join() {
    const lk = window.LivekitClient;
    if (!lk || roomRef.current) return;
    const opts: any = { adaptiveStream: true, dynacast: true };
    if (forceTurn) {
      // A pass with this box ticked cannot secretly be a direct connection —
      // relay-only is what makes step 3 of the test protocol mean something.
      opts.rtcConfig = {
        iceTransportPolicy: 'relay',
        iceServers: [{ urls: [turnUrl], username: turnUser, credential: turnPass }],
      };
      log(`forcing TURN via ${turnUrl}`);
    }
    const room = new lk.Room(opts);
    roomRef.current = room;

    room
      .on(lk.RoomEvent.ConnectionStateChanged, (s: any) => {
        setConnState(String(s));
        log(`connection: ${String(s)}`);
      })
      .on(lk.RoomEvent.ParticipantConnected, (p: any) => log(`joined: ${p.identity}`))
      .on(lk.RoomEvent.ParticipantDisconnected, (p: any) => log(`left: ${p.identity}`))
      .on(lk.RoomEvent.TrackSubscribed, (track: any, _pub: any, p: any) => {
        log(`subscribed ${track.kind} from ${p.identity}`);
        const el = track.attach();
        if (track.kind === 'video') remoteRef.current?.appendChild(tile(el, p.identity));
        else document.body.appendChild(el); // audio elements are invisible
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track: any) => {
        track.detach().forEach((el: HTMLElement) => {
          (el.parentElement?.parentElement === remoteRef.current
            ? el.parentElement
            : el
          )?.remove();
        });
      })
      .on(lk.RoomEvent.Disconnected, () => {
        setConnState('disconnected');
        log('disconnected');
        if (remoteRef.current) remoteRef.current.replaceChildren();
        if (localRef.current) localRef.current.replaceChildren();
        roomRef.current = null;
      })
      .on(lk.RoomEvent.LocalTrackPublished, (pub: any) => {
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
    } catch (e) {
      log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      roomRef.current = null;
    }
  }

  async function leave() {
    await roomRef.current?.disconnect();
  }

  const input =
    'width:100%;background:#12151c;border:1px solid #2a2f3a;border-radius:6px;' +
    'color:#e6e9ef;padding:8px 10px;font-size:13px';
  const btn =
    'border:0;border-radius:6px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer';

  return (
    <div style={{ minHeight: '100dvh', background: '#0b0d12', color: '#e6e9ef', padding: 20, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Connect — Phase 0 media test</h1>
          <p style={{ color: '#8b93a3', fontSize: 13, margin: '4px 0 0' }}>
            Throwaway page. Paste a CLI-minted token, join from two networks, then force TURN and do it again.
            State: <strong style={{ color: connState === 'connected' ? '#3ddc84' : '#e6b45a' }}>{connState}</strong>
            {sdkReady ? '' : ' — loading SDK…'}
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <label style={{ flex: '2 1 320px', fontSize: 12, color: '#8b93a3' }}>
            Signalling URL
            <input style={{ ...styleOf(input), marginTop: 4 }} value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} />
          </label>
          <label style={{ flex: '3 1 380px', fontSize: 12, color: '#8b93a3' }}>
            Access token (lk token create … — see docs/CONNECT_PHASE0.md)
            <textarea style={{ ...styleOf(input), marginTop: 4, height: 58, resize: 'vertical' }} value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={forceTurn} onChange={(e) => setForceTurn(e.target.checked)} />
            Force TURN (relay only)
          </label>
          {forceTurn && (
            <>
              <label style={{ flex: '2 1 240px', fontSize: 12, color: '#8b93a3' }}>
                TURN URL
                <input style={{ ...styleOf(input), marginTop: 4 }} value={turnUrl} onChange={(e) => setTurnUrl(e.target.value)} />
              </label>
              <label style={{ flex: '1 1 140px', fontSize: 12, color: '#8b93a3' }}>
                TURN user
                <input style={{ ...styleOf(input), marginTop: 4 }} value={turnUser} onChange={(e) => setTurnUser(e.target.value)} />
              </label>
              <label style={{ flex: '1 1 140px', fontSize: 12, color: '#8b93a3' }}>
                TURN password
                <input type="password" style={{ ...styleOf(input), marginTop: 4 }} value={turnPass} onChange={(e) => setTurnPass(e.target.value)} />
              </label>
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...styleOf(btn), background: '#03b562', color: '#fff', opacity: sdkReady && token ? 1 : 0.5 }}
              disabled={!sdkReady || !token || connState === 'connected'}
              onClick={() => void join()}
            >
              Join
            </button>
            <button style={{ ...styleOf(btn), background: '#2a2f3a', color: '#e6e9ef' }} onClick={() => void leave()}>
              Leave
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div ref={localRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, flex: '1 1 320px' }} />
          <div ref={remoteRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, flex: '2 1 480px' }} />
        </div>

        <pre style={{ background: '#12151c', border: '1px solid #2a2f3a', borderRadius: 8, padding: 12, fontSize: 12, color: '#8b93a3', maxHeight: 220, overflowY: 'auto', margin: 0 }}>
          {lines.join('\n') || 'log output appears here'}
        </pre>
      </div>
    </div>
  );
}

/** Parse a css string into a style object — keeps the inline styles above terse. */
function styleOf(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[prop] = decl.slice(i + 1).trim();
  }
  return out;
}
