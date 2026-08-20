'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Card } from '@/components/ui/Kit';
import {
  connectApi, PRIVATE_BLURB, RECORDED_BLURB,
  type MeetingMode, type SharePolicy, type WaitingRoom,
} from '@/lib/connect';

// ============================================================================
//  Schedule a meeting
// ============================================================================
//
//  Defaults are the argument this form makes. Every one of them is the safe
//  answer rather than the permissive one, because a person filling in a form
//  quickly accepts whatever is already there:
//
//    guests allowed        ON  — the common case is inviting someone outside
//    waiting room          guests — a leaked link should not be a seat
//    password              empty — the waiting room already covers the risk,
//                          and a password nobody remembers is a support call
//
//  The waiting room defaulting to "guests" rather than "off" is the one that
//  matters. A meeting link is a bearer token; the difference between a link
//  going astray and a stranger sitting silently in a meeting is this field.
// ============================================================================

/** <input type="datetime-local"> wants local wall-clock, not an ISO instant. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStart(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 15), 0, 0);
  return d;
}

export default function NewMeetingPage() {
  const { authedFetch } = useAuth();
  const router = useRouter();

  const start = defaultStart();
  const end = new Date(start.getTime() + 30 * 60_000);

  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(start));
  const [endsAt, setEndsAt] = useState(toLocalInput(end));
  const [waitingRoom, setWaitingRoom] = useState<WaitingRoom>('guests');
  const [allowGuests, setAllowGuests] = useState(true);
  const [password, setPassword] = useState('');
  const [autoRecord, setAutoRecord] = useState(false);
  const [mode, setMode] = useState<MeetingMode>('recorded');
  const [sharePolicy, setSharePolicy] = useState<SharePolicy>('everyone');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (title.trim().length === 0) { setError('Give the meeting a name.'); return; }
    const s = new Date(startsAt);
    const f = new Date(endsAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(f.getTime())) {
      setError('That date does not look right.'); return;
    }
    // Checked here as well as on the server: this one is a typo, and a typo
    // deserves an answer before a round trip.
    if (f <= s) { setError('The meeting has to end after it starts.'); return; }

    setSaving(true);
    try {
      const m = await connectApi.create(authedFetch, {
        title: title.trim(),
        kind: 'scheduled',
        scheduledStart: s.toISOString(),
        scheduledEnd: f.toISOString(),
        // The organiser's zone, sent alongside the instant. Both, deliberately:
        // "9am in Kolkata" and "03:30 UTC" stop being the same thing the moment
        // anybody moves, and a recurring meeting needs the intent, not just the
        // instant. Same reasoning as calendar.events.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        waitingRoom,
        allowGuests,
        password: password.length > 0 ? password : null,
        // A private meeting cannot auto-record; the server refuses the
        // combination and the database makes the row unrepresentable. Sending
        // false rather than relying on the toggle's state means a stale
        // checkbox cannot produce a 400 the person did not ask for.
        autoRecord: mode === 'private' ? false : autoRecord,
        sharePolicy,
        mode,
      });
      router.push(`/connect/meetings/${m.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the meeting.');
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-header-breadcrumb d-flex align-items-center justify-content-between flex-wrap gap-2 my-3">
        <div>
          <h1 className="page-title fw-semibold fs-20 mb-1">Schedule a meeting</h1>
          <ol className="breadcrumb mb-0">
            <li className="breadcrumb-item"><a href="/connect">Connect</a></li>
            <li className="breadcrumb-item active" aria-current="page">New</li>
          </ol>
        </div>
      </div>

      <div className="row">
        <div className="col-xl-7">
          <form onSubmit={submit}>
            <Card>
              {error && <div className="alert alert-danger" role="alert">{error}</div>}

              <div className="mb-3">
                <label className="form-label" htmlFor="title">Name</label>
                <input id="title" className="form-control" value={title} maxLength={200}
                       onChange={(e) => setTitle(e.target.value)}
                       placeholder="Weekly review" autoComplete="off" />
              </div>

              <div className="row">
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="starts">Starts</label>
                  <input id="starts" type="datetime-local" className="form-control"
                         value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="ends">Ends</label>
                  <input id="ends" type="datetime-local" className="form-control"
                         value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </div>
              </div>

              {/* The first choice, because it decides what the rest of
                  this form can even offer. Chosen once — there is no way to
                  change it afterwards, and the form says so rather than
                  letting somebody discover it later. */}
              <div className="mb-3">
                <label className="form-label" htmlFor="mode">Meeting type</label>
                <select id="mode" className="form-select" value={mode}
                        onChange={(e) => setMode(e.target.value as MeetingMode)}>
                  <option value="recorded">Recorded — can be recorded and summarised</option>
                  <option value="private">Private — encrypted, cannot be recorded</option>
                </select>
                <div className="form-text">
                  {mode === 'private' ? PRIVATE_BLURB : RECORDED_BLURB}
                  {' '}This cannot be changed once the meeting is created.
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label" htmlFor="waiting">Waiting room</label>
                <select id="waiting" className="form-select" value={waitingRoom}
                        onChange={(e) => setWaitingRoom(e.target.value as WaitingRoom)}>
                  <option value="off">Off — anyone with the link walks straight in</option>
                  <option value="guests">Guests wait for you to let them in</option>
                  <option value="everyone">Everyone waits, including colleagues</option>
                </select>
                <div className="form-text">
                  A meeting link is a bearer token: whoever holds it can use it. The waiting
                  room is what stands between a link going astray and a stranger in the room.
                </div>
              </div>

              <div className="form-check mb-3">
                <input className="form-check-input" type="checkbox" id="guests"
                       checked={allowGuests} onChange={(e) => setAllowGuests(e.target.checked)} />
                <label className="form-check-label" htmlFor="guests">
                  Let people without a TatvaOS account join
                </label>
                <div className="form-text">
                  Turn this off and only signed-in colleagues can get in, whoever has the link.
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label" htmlFor="share">Who can share their screen</label>
                <select id="share" className="form-select" value={sharePolicy}
                        onChange={(e) => setSharePolicy(e.target.value as SharePolicy)}>
                  <option value="everyone">Everyone</option>
                  <option value="cohost">Only the host and co-hosts</option>
                  <option value="host">Only the host</option>
                </select>
                <div className="form-text">
                  You can change this during the meeting from the People panel.
                </div>
              </div>

              {mode === 'recorded' && (
              <div className="form-check mb-3">
                <input className="form-check-input" type="checkbox" id="autorec"
                       checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} />
                <label className="form-check-label" htmlFor="autorec">
                  Start recording automatically when the meeting starts
                </label>
                <div className="form-text">
                  Audio recording, started when the first person joins. It still needs
                  recording to be switched on for your organisation — if it is off,
                  the meeting simply runs unrecorded.
                </div>
              </div>
              )}

              <div className="mb-3">
                <label className="form-label" htmlFor="password">Password <span className="text-muted fw-normal">(optional)</span></label>
                <input id="password" className="form-control" value={password} type="text"
                       onChange={(e) => setPassword(e.target.value)}
                       autoComplete="off" spellCheck={false} />
                <div className="form-text">
                  Most meetings do not need one — the waiting room already covers a stray link.
                </div>
              </div>

              <div className="d-flex gap-2">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'Creating…' : 'Create meeting'}
                </button>
                <Button href="/connect">Cancel</Button>
              </div>
            </Card>
          </form>
        </div>
      </div>
    </>
  );
}
