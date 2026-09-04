'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Centre, initialOf } from './RoomChrome';

// ============================================================================
//  The pre-join screen — see yourself before anybody else does.
// ============================================================================
//
//  Sits between getting a seat and taking it: the token is already minted (it
//  is a JOIN WINDOW of ten minutes, so a minute spent here costs nothing), and
//  the room is not yet aware of you. What people check here: does my camera
//  work, which microphone is live, can I hear anything — the three questions
//  that otherwise get asked out loud to a room full of people.
//
//  DELIBERATELY NO livekit-client. The same reasoning as the door (see
//  page.tsx): this screen must render fast on a bad connection, and plain
//  getUserMedia answers everything it asks. The SDK downloads while you look
//  at yourself.
//
//  Denial is survivable. A browser that refuses the camera still lets you
//  join — attending a meeting you cannot publish to is a normal way to attend
//  a meeting, and the room's own controls already handle a device appearing
//  later. The one thing this screen must never do is stand between a person
//  and the meeting.
// ============================================================================

/** What the person decided at the door, handed to Stage to act on. */
export interface JoinPrefs {
  mic: boolean;
  cam: boolean;
  micId?: string;
  camId?: string;
}

export default function PreJoin({ title, name, onJoin }: {
  title: string;
  /** Shown on the placeholder tile when the camera is off or denied. */
  name: string;
  onJoin: (prefs: JoinPrefs) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);

  // ── THE PREVIEW TAKES THE CAMERA'S SHAPE, NOT 16/9. ──────────────────
  //
  //  The card was a fixed 16/9 box with object-fit:cover in it. A phone held
  //  upright sends about 9/16, so cover filled the width and threw away most
  //  of the height — the first thing a mobile joiner saw was a letterbox slice
  //  of their own face, on the one screen whose entire job is "check how you
  //  look before anybody else sees you".
  //
  //  Measured from the video element rather than from the viewport width: a
  //  tablet in landscape is not a phone, and a phone turned sideways mid-check
  //  should follow. `resize` is what fires on rotation.
  const [shape, setShape] = useState<string | null>(null);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [level, setLevel] = useState(0);
  const [denied, setDenied] = useState(false);
  const [toneOn, setToneOn] = useState(false);

  const stopStream = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, []);

  // Open the devices the person has chosen (or the defaults), preview the
  // camera, and meter the microphone. Re-run whenever the choice changes.
  useEffect(() => {
    let alive = true;
    void (async () => {
      stopStream();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: camId ? { deviceId: { exact: camId } } : true,
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setDenied(false);

        if (videoRef.current) videoRef.current.srcObject = stream;

        // The meter. Not decoration: "is this microphone alive" is the single
        // most common pre-meeting doubt, and a moving bar answers it without
        // anybody having to say "can you hear me" to an empty room.
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 96));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        // Labels are blank until permission exists, which it now does.
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!alive) return;
        setCams(devices.filter((d) => d.kind === 'videoinput'));
        setMics(devices.filter((d) => d.kind === 'audioinput'));
      } catch {
        // A denial is sticky per origin (see page.tsx) — say so once, plainly,
        // and keep the Join button working.
        if (alive) setDenied(true);
      }
    })();
    return () => { alive = false; stopStream(); };
  }, [camId, micId, stopStream]);

  // Watches the element, not the stream, so it also catches a camera swap and
  // a rotation. Registered once; the element outlives every stream it shows.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const read = () => {
      const w = el.videoWidth;
      const h = el.videoHeight;
      // Zeros mean metadata has not arrived. Keeping the last known shape
      // avoids the card snapping to a default and back while a camera starts.
      if (w > 0 && h > 0) setShape(`${w} / ${h}`);
    };
    read();
    el.addEventListener('loadedmetadata', read);
    el.addEventListener('resize', read);
    return () => {
      el.removeEventListener('loadedmetadata', read);
      el.removeEventListener('resize', read);
    };
  }, []);

  // The speaker test: a soft two-note chime from an oscillator — no asset to
  // load, nothing to buffer, works offline. If you hear it, your speakers
  // work; there is nothing else it needs to prove.
  const playTone = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      gain.connect(ctx.destination);
      const note = (freq: number, at: number, dur: number) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + dur);
      };
      note(523.25, 0, 0.28);      // C5
      note(783.99, 0.3, 0.4);     // G5
      setToneOn(true);
      setTimeout(() => { setToneOn(false); void ctx.close().catch(() => undefined); }, 900);
    } catch { setToneOn(false); }
  }, []);

  function join() {
    // The preview's tracks are stopped BEFORE Stage opens its own: two claims
    // on one camera is exactly the "device busy" failure the room already has
    // copy for, and there is no reason to walk into it.
    stopStream();
    onJoin({
      mic: micOn && !denied,
      cam: camOn && !denied,
      micId: micId || undefined,
      camId: camId || undefined,
    });
  }

  return (
    <Centre>
      <div className="cx-card" style={{ maxWidth: 460 }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>Ready to join?</div>
        <div className="cx-sub" style={{ marginBottom: 14 }}>{title}</div>

        {/* The box follows the camera. Capped in CSS so a very tall phone
            camera cannot push the Join button off the bottom of the screen —
            a preview you have to scroll past to join is worse than a cropped
            one. */}
        <div className="cx-preview"
             style={shape !== null ? { aspectRatio: shape } : undefined}>
          {camOn && !denied ? (
            <video ref={videoRef} autoPlay playsInline muted className="cx-preview-video" />
          ) : (
            <div className="cx-preview-off">
              <div className="cx-initial">{initialOf(name)}</div>
            </div>
          )}
          <div className="cx-meter" title="Microphone level" aria-hidden="true">
            <div className="cx-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </div>

        {denied && (
          <div className="cx-banner cx-banner--warn" style={{ borderRadius: 10, margin: '12px 0 0' }}>
            Your browser is blocking the camera or microphone for this site. You can
            still join and listen — use the padlock by the address bar to allow them.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
          <button type="button" className={`cx-btn ${micOn ? '' : 'is-off'}`}
                  onClick={() => setMicOn(!micOn)} aria-pressed={micOn}
                  title={micOn ? 'Join with microphone off' : 'Join with microphone on'}>
            <i className={micOn ? 'ri-mic-line' : 'ri-mic-off-line'} />
            {micOn ? 'Mic on' : 'Mic off'}
          </button>
          <button type="button" className={`cx-btn ${camOn ? '' : 'is-off'}`}
                  onClick={() => setCamOn(!camOn)} aria-pressed={camOn}
                  title={camOn ? 'Join with camera off' : 'Join with camera on'}>
            <i className={camOn ? 'ri-vidicon-line' : 'ri-vidicon-off-line'} />
            {camOn ? 'Cam on' : 'Cam off'}
          </button>
          <button type="button" className={`cx-btn ${toneOn ? 'is-on' : ''}`}
                  onClick={playTone}
                  title="Play a short chime through your speakers">
            <i className="ri-volume-up-line" />
            Test sound
          </button>
        </div>

        {mics.length > 0 && (
          <>
            <label className="cx-label" htmlFor="pj-mic">Microphone</label>
            <select id="pj-mic" className="cx-field" style={{ marginBottom: 10 }}
                    value={micId} onChange={(e) => setMicId(e.target.value)}>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>
              ))}
            </select>
          </>
        )}
        {cams.length > 0 && (
          <>
            <label className="cx-label" htmlFor="pj-cam">Camera</label>
            <select id="pj-cam" className="cx-field" style={{ marginBottom: 14 }}
                    value={camId} onChange={(e) => setCamId(e.target.value)}>
              {cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>
              ))}
            </select>
          </>
        )}

        <button type="button" className="cx-cta" onClick={join}>Join now</button>
      </div>
    </Centre>
  );
}
