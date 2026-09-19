'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { use, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  connectApi, guestApi, e2eeSupported, DoorClosedError, WrongPasswordError, GUEST_FAILURE,
  PhoneRequiredError, guestPass,
  type Doorstep, type JoinResult, type Meeting, type Seat,
} from '@/lib/connect';
import { Centre, Spinner } from './RoomChrome';
import PreJoin, { type JoinPrefs } from './PreJoin';

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
//  defines its own `.grid` and silently flattens Tailwind's column classes.
//
//  A BROWSER DENIED ONCE STAYS DENIED. Refusing the camera is sticky per
//  origin; the prompt never comes back, so a denial gets specific copy.
//
//  DEPARTED PEOPLE LEAVE BLACK RECTANGLES unless their tile is removed by
//  identity on ParticipantDisconnected.
//
//  wsUrl IS AN ORIGIN — asserted in lib/connect.ts rather than trusted here.
//
//  No useSearchParams in this tree: it forces a Suspense boundary, and
//  forgetting one fails the PRODUCTION build while dev passes.
//
//  ── Why this file carries its own CSS ────────────────────────────────────
//
//  Everywhere else in TatvaOS uses YZEN's Bootstrap, which is styled for
//  light surfaces. This screen is a dark room that fills the viewport and
//  sits outside the shell, so its buttons and panels are its own. The styles
//  are a plain <style> element with a string child — NOT
//  dangerouslySetInnerHTML, which eslint forbids here as an error.
// ============================================================================

// The live meeting is loaded ON DEMAND, and this is the reason:
// livekit-client is ~140 kB and the door needs none of it. A guest arriving
// from a link is the least likely person in the system to be on a fast
// connection — schools and clinics on Indian mobile data — and the first
// thing they see is a name field. Making them wait for a media SDK to render
// a text input is the wrong trade. It downloads while they type.
//
// ssr:false because it touches navigator.mediaDevices on mount; there is
// nothing to prerender in a live video call.
const Stage = dynamic(() => import('./Stage'), {
  ssr: false,
  loading: () => <Centre><Spinner /><p className="mt-3 mb-0">Joining…</p></Centre>,
});

type Phase =
  | { kind: 'resolving' }
  | { kind: 'door'; door: Doorstep; meeting: Meeting | null }
  | { kind: 'waiting'; waitToken: string }
  // The seat is already minted — it is a ten-minute join WINDOW, so the time
  // spent checking a camera here costs nothing. The room does not know about
  // you until Stage connects.
  | { kind: 'prejoin'; seat: Seat; meeting: Meeting | null }
  | { kind: 'live'; seat: Seat; meeting: Meeting | null; prefs: JoinPrefs }
  | { kind: 'denied' }
  // This browser cannot decode an encrypted meeting. Its own phase, not a
  // 'gone', because nothing is wrong with the link — the answer is "open it
  // somewhere else", and that is a different sentence.
  | { kind: 'cannotEncrypt' }
  | { kind: 'gone'; message: string };

const WAIT_POLL_MS = 2500;

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { user, loading: authLoading, authedFetch } = useAuth();

  // ── WHY THIS IS AN ID AND NOT THE USER OBJECT. ──────────────────────────
  //
  // This is the dependency of the effect below, and it decides how long a
  // meeting can last.
  //
  // An access token lives fifteen minutes. When it expires the auth provider
  // silently refreshes and calls setUser() with a freshly PARSED object —
  // same person, same values, new identity. Any effect depending on `user`
  // therefore re-ran on a timer: this one re-resolved the code, minted a
  // second seat, and put the phase back to 'prejoin'. From the person's side
  // they were dropped out of a live meeting onto the join screen at around
  // the fifteen-minute mark, with no message, and had to rejoin — and it
  // would happen again fifteen minutes later, forever.
  //
  // It only ever hit SIGNED-IN people; a guest has no session to refresh,
  // which is why the attendance for the meeting that found this shows the
  // host with "rejoined 1×" and the guest sitting through it unbroken.
  //
  // The identity of the signed-in person is what this effect actually cares
  // about, and an id is a string: it is equal to itself across a refresh, so
  // the effect stays put. Do not "simplify" this back to `user`.
  const userId = user?.id ?? null;
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });

  useEffect(() => {
    if (authLoading) return;
    let alive = true;

    const run = async () => {
      try {
        if (userId) {
          // Signed in: resolve the code to a meeting, then take the seat the
          // authenticated route mints — carrying their real identity and role.
          // Routing a colleague through the guest door would make them a guest
          // in their own organisation's meeting.
          const meeting = await connectApi.byCode(authedFetch, code);
          // BEFORE the token. A private meeting on a browser without the
          // media-transform APIs would join, publish nothing anyone can
          // decode, and look broken.
          if (meeting.mode === 'private' && !e2eeSupported()) {
            if (alive) setPhase({ kind: 'cannotEncrypt' });
            return;
          }
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
                  // A signed-in caller reaches the door through byCode, not
                  // through the guest doorstep, so this object is assembled
                  // from the meeting row. The mode has to come with it, or
                  // the two paths would describe the same meeting
                  // differently — and the compiler caught exactly that.
                  mode: meeting.mode,
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
            : { kind: 'prejoin', seat: res, meeting });
          return;
        }

        const door = await guestApi.doorstep(code);
        if (!alive) return;
        if (door.mode === 'private' && !e2eeSupported()) {
          setPhase({ kind: 'cannotEncrypt' });
          return;
        }
        setPhase({ kind: 'door', door, meeting: null });
      } catch (e) {
        if (!alive) return;
        if (e instanceof DoorClosedError) { setPhase({ kind: 'gone', message: GUEST_FAILURE }); return; }
        setPhase({ kind: 'gone', message: e instanceof Error ? e.message : GUEST_FAILURE });
      }
    };

    void run();
    return () => { alive = false; };
    // userId, NOT user — see the note where it is derived. authedFetch is
    // stable (its own dependency chain bottoms out at a ref and an empty
    // callback), so nothing else in this array moves during a meeting.
  }, [authLoading, userId, authedFetch, code]);

  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const token = phase.waitToken;
    let alive = true;

    const tick = async () => {
      try {
        const res = await guestApi.wait(token);
        if (!alive) return;
        if (res.status === 'denied') { setPhase({ kind: 'denied' }); return; }
        if (res.status !== 'waiting') setPhase({ kind: 'prejoin', seat: res, meeting: null });
      } catch (e) {
        if (!alive) return;
        // A 404 is the token spent, expired, or never valid — one answer for
        // all three, so this cannot be probed.
        if (e instanceof DoorClosedError) setPhase({ kind: 'gone', message: GUEST_FAILURE });
      }
    };

    void tick();
    const t = setInterval(() => void tick(), WAIT_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [phase]);

  if (authLoading || phase.kind === 'resolving') {
    return <Centre><Spinner /><p className="mt-3 mb-0">Opening the meeting…</p></Centre>;
  }

  if (phase.kind === 'gone') {
    return (
      <Centre>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{phase.message}</h1>
        <p style={{ color: '#9b9bab', maxWidth: 420, marginBottom: 20 }}>
          Check the link with whoever invited you — it may have been cancelled,
          or the code may have a typo.
        </p>
        <Link href="/connect" className="cx-mini">Back to Connect</Link>
      </Centre>
    );
  }

  if (phase.kind === 'cannotEncrypt') {
    return (
      <Centre>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
          This browser cannot open a private meeting
        </h1>
        <p style={{ color: '#9b9bab', maxWidth: 460, marginBottom: 8 }}>
          This meeting is encrypted so that even the meeting server cannot see or
          hear it. Your browser does not support the encryption it uses, so it
          would not be able to decode anyone.
        </p>
        <p style={{ color: '#9b9bab', maxWidth: 460 }}>
          A recent Chrome, Edge or Safari will open it. Nothing is wrong with
          your link.
        </p>
      </Centre>
    );
  }

  if (phase.kind === 'denied') {
    return (
      <Centre>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>You were not let in</h1>
        <p style={{ color: '#9b9bab', maxWidth: 420 }}>
          The host turned down this request. If that was a mistake, ask them to send the link again.
        </p>
      </Centre>
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <Centre>
        <Spinner />
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '18px 0 8px' }}>Waiting to be let in</h1>
        <p style={{ color: '#9b9bab', maxWidth: 420 }}>
          The host has been told you are here. Keep this page open — you will join automatically.
        </p>
      </Centre>
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
            : { kind: 'prejoin', seat: res, meeting });
        }}
        onGone={(m) => setPhase({ kind: 'gone', message: m })}
      />
    );
  }

  if (phase.kind === 'prejoin') {
    const seat = phase.seat;
    const meeting = phase.meeting;
    return (
      <PreJoin
        title={meeting?.title ?? 'Meeting'}
        name={user?.displayName ?? 'You'}
        onJoin={(prefs) => setPhase({ kind: 'live', seat, meeting, prefs })}
      />
    );
  }

  return <Stage seat={phase.seat} meeting={phase.meeting} prefs={phase.prefs} />;
}

// ===========================================================================
//  The door
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

  // ── A guest proves a mobile number (Amit, 19 Sept 2026). ─────────────────
  //  Only for a guest (meeting === null) and only when the door said so.
  //  Two ways through: a PASS this browser was handed last time - direct
  //  entry, nothing to type - or the number and the code texted to it. The
  //  pass is tried first and, if the server will not have it, forgotten: the
  //  page then asks for the number, and says why, instead of failing twice.
  const needsPhone = meeting === null && door.phoneRequired === true;
  const [pass, setPass] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (!needsPhone) return;
    const kept = guestPass.read(code);
    if (kept) {
      setPass(kept.pass);
      if (kept.name) setName((n) => (n.length > 0 ? n : kept.name));
    }
  }, [needsPhone, code]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function sendCode() {
    setError(null);
    if (phone.replace(/\D/g, '').length < 10) { setError('Give your 10-digit mobile number.'); return; }
    setSending(true);
    try {
      const out = await guestApi.requestCode(code, phone);
      setSentTo(out.sentTo);
      setResendIn(45);
      // The operator's testing mode only: the code comes back instead of a text.
      if (out.devCode) setOtp(out.devCode);
    } catch (err) {
      if (err instanceof DoorClosedError) { onGone(GUEST_FAILURE); return; }
      setError(err instanceof Error ? err.message : 'The code could not be sent.');
    } finally {
      setSending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (meeting === null && name.trim().length === 0) {
      setError('Tell people who you are.');
      return;
    }
    if (needsPhone && pass === null && (sentTo === null || otp.trim().length === 0)) {
      setError(sentTo === null ? 'Verify your mobile number first: send yourself a code.' : 'Type the code from the text message.');
      return;
    }
    setBusy(true);
    try {
      const res = meeting
        ? await connectApi.join(authedFetch, meeting.id, password || undefined)
        : await guestApi.join(code, name.trim(), password || undefined,
            needsPhone ? (pass !== null ? { pass } : { phone, otp: otp.trim() }) : undefined);
      // Kept for coming back. Refreshed on every entry so it cannot run out
      // in the middle of a long meeting.
      if (meeting === null && res.guestPass) guestPass.write(code, res.guestPass, name.trim());
      onSeat(res, meeting);
    } catch (err) {
      // The pass was not accepted (expired, or this browser's storage is from
      // another time). Forget it and ask for the number - once, in words.
      if (err instanceof PhoneRequiredError) {
        guestPass.clear(code);
        setPass(null);
        setError('Please verify your mobile number to come back in.');
        setBusy(false);
        return;
      }
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
    <Centre>
      <div className="cx-card">
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{
            width: 54, height: 54, borderRadius: 16, margin: '0 auto 12px',
            display: 'grid', placeItems: 'center', background: 'rgba(0,184,217,.16)',
            border: '1px solid rgba(0,184,217,.4)',
          }}>
            <i className="ri-vidicon-line" style={{ fontSize: 24, color: '#8fe6f6' }} />
          </div>
          <div style={{ fontSize: 19, fontWeight: 600 }}>{door.title}</div>
          <div style={{ color: '#9b9bab', fontSize: 13, marginTop: 4 }}>
            {door.state === 'active' ? 'Happening now'
              : door.state === 'ended' ? 'This meeting has ended'
                : 'Not started yet'}
          </div>
        </div>

        {door.locked && (
          <div className="cx-banner cx-banner--warn" style={{ borderRadius: 10, marginBottom: 14 }}>
            This meeting is locked. Nobody new can join right now.
          </div>
        )}

        {/* ── WHAT HAPPENS TO YOUR VOICE, BEFORE YOU DECIDE TO JOIN. ─────
            Shown only to a guest — `meeting === null` is the same test the
            name field uses below. A signed-in colleague already has the
            switch and its disclosure inside the room; a guest has neither,
            and arrives by a link having been asked nothing.

            Deliberately NOT a warning colour. Nothing is wrong, and a red
            box at somebody's first sight of the product says "danger" about
            an ordinary feature. It is a fact, stated where a fact is still
            useful — which is before the Join button, not after it.

            Deliberately NOT a checkbox either. Amit ruled against a consent
            queue and he was right about the queue; the part of that decision
            worth keeping is that people are TOLD, not that they are stopped.
            Someone who does not want to be minuted can close the tab, which
            is a real choice and the only one they had any way to make. */}
        {door.minutesLive === true && meeting === null && (
          <div style={{
            borderRadius: 10, marginBottom: 14, padding: '11px 13px',
            background: 'rgba(255,255,255,.05)',
            border: '1px solid rgba(255,255,255,.12)',
            fontSize: 13, lineHeight: 1.55, color: '#c9c9d6',
          }}>
            <b style={{ color: '#e8e8f0' }}>Notes are being written from what is said.</b>
            <div style={{ marginTop: 4 }}>
              Your browser turns your own speech into text and sends that audio
              to Google to do it. What you say becomes part of the meeting
              notes, with your name on it.
            </div>
          </div>
        )}

        <form onSubmit={submit}>
          {meeting === null && (
            <div style={{ marginBottom: 14 }}>
              <label className="cx-label" htmlFor="cx-name">Your name</label>
              <input id="cx-name" className="cx-field" value={name} maxLength={100}
                     onChange={(e) => setName(e.target.value)} autoComplete="name"
                     placeholder="Ravi Kumar" />
              <div className="cx-sub" style={{ marginTop: 6 }}>
                Everyone in the meeting will see this.
              </div>
            </div>
          )}

          {needsPhone && pass !== null && (
            <div className="cx-sub" style={{ marginBottom: 14 }}>
              Welcome back. Your number is already verified for this meeting on this device.{' '}
              <button type="button" onClick={() => { guestPass.clear(code); setPass(null); }}
                      style={{ background: 'none', border: 'none', padding: 0, color: '#8fe6f6',
                               cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}>
                Not you?
              </button>
            </div>
          )}

          {needsPhone && pass === null && (
            <div style={{ marginBottom: 14 }}>
              <label className="cx-label" htmlFor="cx-phone">Your mobile number</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="cx-phone" className="cx-field" value={phone} inputMode="tel"
                       autoComplete="tel" placeholder="98765 43210" maxLength={20}
                       onChange={(e) => { setPhone(e.target.value); setSentTo(null); setOtp(''); }} />
                <button type="button" className="cx-pill" style={{ whiteSpace: 'nowrap' }}
                        disabled={sending || resendIn > 0 || door.locked || door.state === 'ended'}
                        onClick={() => void sendCode()}>
                  {sending ? 'Sending…' : resendIn > 0 ? `Resend in ${resendIn}s` : sentTo ? 'Resend code' : 'Send code'}
                </button>
              </div>
              <div className="cx-sub" style={{ marginTop: 6 }}>
                An Indian mobile number. We text it a code so you are counted once,
                however often you rejoin. The number itself is not kept and nobody
                in the meeting sees it.
              </div>

              {sentTo !== null && (
                <div style={{ marginTop: 12 }}>
                  <label className="cx-label" htmlFor="cx-otp">Code from the text message</label>
                  <input id="cx-otp" className="cx-field" value={otp} inputMode="numeric"
                         autoComplete="one-time-code" maxLength={6} placeholder="6 digits"
                         onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                  <div className="cx-sub" style={{ marginTop: 6 }}>
                    Sent to {sentTo}. It works once, for ten minutes.
                  </div>
                </div>
              )}
            </div>
          )}

          {door.passwordRequired && (
            <div style={{ marginBottom: 14 }}>
              <label className="cx-label" htmlFor="cx-pw">Meeting password</label>
              <input id="cx-pw" className="cx-field" type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
          )}

          {error && (
            <div className="cx-banner cx-banner--bad" style={{ borderRadius: 10, marginBottom: 14 }}>
              {error}
            </div>
          )}

          <button className="cx-cta" type="submit"
                  disabled={busy || door.locked || door.state === 'ended'}>
            {busy ? 'Joining…' : 'Join meeting'}
          </button>
        </form>
      </div>
    </Centre>
  );
}

