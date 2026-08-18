'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { use, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  connectApi, guestApi, DoorClosedError, WrongPasswordError, GUEST_FAILURE,
  type Doorstep, type JoinResult, type Meeting, type Seat,
} from '@/lib/connect';
import { Centre, Spinner } from './RoomChrome';

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
  | { kind: 'live'; seat: Seat; meeting: Meeting | null }
  | { kind: 'denied' }
  | { kind: 'gone'; message: string };

const WAIT_POLL_MS = 2500;

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { user, loading: authLoading, authedFetch } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });

  useEffect(() => {
    if (authLoading) return;
    let alive = true;

    const run = async () => {
      try {
        if (user) {
          // Signed in: resolve the code to a meeting, then take the seat the
          // authenticated route mints — carrying their real identity and role.
          // Routing a colleague through the guest door would make them a guest
          // in their own organisation's meeting.
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
            : { kind: 'live', seat: res, meeting });
        }}
        onGone={(m) => setPhase({ kind: 'gone', message: m })}
      />
    );
  }

  return <Stage seat={phase.seat} meeting={phase.meeting} />;
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

