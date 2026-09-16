'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Card } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import {
  connectApi, PRIVATE_BLURB, RECORDED_BLURB,
  type ChatPolicy, type MeetingMode, type SharePolicy, type WaitingRoom,
} from '@/lib/connect';
import { Choice, Field, SumRow } from '../ConnectSkin';

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

const WAITING_LABEL: Record<WaitingRoom, string> = {
  off: 'Off — nobody waits',
  guests: 'Guests wait',
  everyone: 'Everyone waits',
};

const CHAT_LABEL: Record<ChatPolicy, string> = {
  everyone: 'Everyone',
  cohost: 'Host and co-hosts',
  off: 'Closed',
};

const SHARE_LABEL: Record<SharePolicy, string> = {
  everyone: 'Everyone',
  cohost: 'Host and co-hosts',
  host: 'Host only',
};

/**
 * The meeting's time, as a sentence, for the summary panel.
 *
 * Returns a dash rather than a guess while the fields are mid-edit — a
 * datetime input is briefly unparseable on nearly every keystroke, and a
 * panel that flashes "Invalid Date" at somebody typing is worse than one that
 * waits.
 */
function whenSummary(from: string, to: string): string {
  const s = new Date(from);
  const f = new Date(to);
  if (Number.isNaN(s.getTime()) || Number.isNaN(f.getTime())) return '—';

  const day = s.toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
  const at = (d: Date) => d.toLocaleTimeString(undefined,
    { hour: 'numeric', minute: '2-digit' });

  const mins = Math.round((f.getTime() - s.getTime()) / 60_000);
  if (mins <= 0) return `${day}, ${at(s)} — ends before it starts`;

  const rest = mins % 60;
  const length = mins >= 60
    ? `${Math.floor(mins / 60)} h${rest > 0 ? ` ${rest} min` : ''}`
    : `${mins} min`;
  return `${day}, ${at(s)} – ${at(f)} · ${length}`;
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
  const [chatPolicy, setChatPolicy] = useState<ChatPolicy>('everyone');
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
        chatPolicy,
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
      <PageHeader
        title="Schedule a meeting"
        breadcrumb={[{ label: 'Connect', href: '/connect' }, { label: 'New' }]}
        className="my-4"
      />

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <form onSubmit={submit}>
            <Card>
              {error && <Alert tone="danger">{error}</Alert>}

              <Field label="Name" htmlFor="title"
                     hint="What people see in their calendar and at the top of the meeting.">
                <Input id="title" value={title} maxLength={200}
                       onChange={(e) => setTitle(e.target.value)}
                       placeholder="Weekly review" autoComplete="off" />
              </Field>

              <Field label="When" hint="Your own time zone. Everyone else sees it in theirs.">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="cx-sublab" htmlFor="starts">Starts</label>
                    <Input id="starts" type="datetime-local"
                           value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                  </div>
                  <div>
                    <label className="cx-sublab" htmlFor="ends">Ends</label>
                    <Input id="ends" type="datetime-local"
                           value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                  </div>
                </div>
              </Field>

              {/* The first choice, because it decides what the rest of this
                  form can even offer — and the only one that can never be
                  changed afterwards, which is why it says so on the card
                  rather than in a paragraph somebody may not read. */}
              <Field label="Meeting type"
                     why={<>{mode === 'private' ? PRIVATE_BLURB : RECORDED_BLURB}</>}>
                <div className="cx-choices cx-choices--2">
                  <Choice name="mode" value="recorded" current={mode} onPick={setMode}
                          title="Recorded"
                          note="Can be recorded, transcribed and summarised. Everyone is told when recording starts." />
                  <Choice name="mode" value="private" current={mode} onPick={setMode}
                          title="Private"
                          note="Audio and video are encrypted. It cannot be recorded." />
                </div>
                <div className="mt-1 text-xs text-ink-muted">This cannot be changed once the meeting is created.</div>
              </Field>

              <Field label="Waiting room"
                     why={'A meeting link is a bearer token: whoever holds it can use it. '
                       + 'The waiting room is what stands between a link going astray and a '
                       + 'stranger in the room. Guests wait is the safe default — colleagues '
                       + 'walk in, anybody from outside knocks first.'}>
                <div className="cx-choices cx-choices--3">
                  <Choice name="waiting" value="off" current={waitingRoom} onPick={setWaitingRoom}
                          title="Off" note="Anyone with the link walks straight in." />
                  <Choice name="waiting" value="guests" current={waitingRoom} onPick={setWaitingRoom}
                          title="Guests wait" note="You let people from outside in." />
                  <Choice name="waiting" value="everyone" current={waitingRoom} onPick={setWaitingRoom}
                          title="Everyone waits" note="Colleagues knock too." />
                </div>
              </Field>

              <Field label="Who can get in"
                     why={'This is about accounts, not about the link. Turn it to colleagues '
                       + 'only and somebody outside the organisation is refused even if they '
                       + 'are holding a working link.'}>
                <div className="cx-choices cx-choices--2">
                  <Choice name="guests" value="yes" current={allowGuests ? 'yes' : 'no'}
                          onPick={() => setAllowGuests(true)}
                          title="Anyone with the link"
                          note="Including people with no TatvaOS account." />
                  <Choice name="guests" value="no" current={allowGuests ? 'yes' : 'no'}
                          onPick={() => setAllowGuests(false)}
                          title="Colleagues only"
                          note="Signed-in accounts, and nobody else." />
                </div>
              </Field>

              <Field label="Who can send chat messages"
                     hint="Everyone can read, whichever you choose. Changeable during the meeting."
                     why={'Chat, raised hands, reactions and files all travel the same '
                       + 'channel, and the only permission the media server offers covers '
                       + 'all four — closing chat by force would also stop somebody raising '
                       + 'a hand to ask why. So this is kept by the app rather than enforced '
                       + 'by the server: it is what stops a room of twenty talking over a '
                       + 'presenter, not a lock.'}>
                <div className="cx-choices cx-choices--3 cx-choices--tight">
                  <Choice name="chat" value="everyone" current={chatPolicy} onPick={setChatPolicy}
                          title="Everyone" />
                  <Choice name="chat" value="cohost" current={chatPolicy} onPick={setChatPolicy}
                          title="Host and co-hosts" />
                  <Choice name="chat" value="off" current={chatPolicy} onPick={setChatPolicy}
                          title="Nobody" />
                </div>
              </Field>

              <Field label="Who can share their screen"
                     hint="Changeable during the meeting, from the People panel.">
                <div className="cx-choices cx-choices--3 cx-choices--tight">
                  <Choice name="share" value="everyone" current={sharePolicy} onPick={setSharePolicy}
                          title="Everyone" />
                  <Choice name="share" value="cohost" current={sharePolicy} onPick={setSharePolicy}
                          title="Host and co-hosts" />
                  <Choice name="share" value="host" current={sharePolicy} onPick={setSharePolicy}
                          title="Host only" />
                </div>
              </Field>

              {mode === 'recorded' && (
                <Field label="Recording"
                       why={'Audio only, started when the first person joins. It still needs '
                         + 'recording to be switched on for your organisation — if it is off, '
                         + 'the meeting simply runs unrecorded.'}>
                  <div className="cx-choices cx-choices--2 cx-choices--tight">
                    <Choice name="autorec" value="no" current={autoRecord ? 'yes' : 'no'}
                            onPick={() => setAutoRecord(false)}
                            title="I will start it myself" />
                    <Choice name="autorec" value="yes" current={autoRecord ? 'yes' : 'no'}
                            onPick={() => setAutoRecord(true)}
                            title="Start it automatically" />
                  </div>
                </Field>
              )}

              <Field label="Password" htmlFor="password"
                     hint="Optional. Most meetings do not need one."
                     why={'The waiting room already covers a stray link, and a password '
                       + 'nobody can remember becomes a support call five minutes before '
                       + 'the meeting.'}>
                <Input id="password" value={password} type="text"
                       onChange={(e) => setPassword(e.target.value)}
                       autoComplete="off" spellCheck={false} />
              </Field>

              <div className="flex gap-2">
                <Button variant="primary" type="submit" disabled={saving}>
                  {saving ? 'Creating…' : 'Create meeting'}
                </Button>
                <Button href="/connect">Cancel</Button>
              </div>
            </Card>
          </form>
        </div>

        {/* The form is a list of settings. This is the thing they make. */}
        <div className="xl:col-span-5">
          <Card title="What you are creating" className="cx-sum">
            <div className={`cx-sum-title${title.trim().length > 0 ? '' : ' is-empty'}`}>
              {title.trim().length > 0 ? title.trim() : 'Untitled meeting'}
            </div>
            <div className="cx-sum-when">{whenSummary(startsAt, endsAt)}</div>

            <ul className="cx-sum-list">
              <SumRow k="Type" v={mode === 'private' ? 'Private — encrypted' : 'Recorded'} />
              <SumRow k="Who can get in"
                      v={allowGuests ? 'Anyone with the link' : 'Colleagues only'} />
              {/* Marked, not blocked. Off is a real answer for a meeting whose
                  link never leaves one room — it is just the one setting worth
                  seeing before pressing Create. */}
              <SumRow k="Waiting room" v={WAITING_LABEL[waitingRoom]}
                      warn={waitingRoom === 'off'} />
              <SumRow k="Screen sharing" v={SHARE_LABEL[sharePolicy]} />
              <SumRow k="Chat" v={CHAT_LABEL[chatPolicy]}
                      warn={chatPolicy === 'off'} />
              {mode === 'recorded' && (
                <SumRow k="Recording"
                        v={autoRecord ? 'Starts automatically' : 'Started by hand'} />
              )}
              <SumRow k="Password" v={password.length > 0 ? 'Set' : 'None'} />
            </ul>

            <div className="cx-sum-note">
              The link and the code are made when you press Create meeting.
              Nothing reaches anybody until you send them.
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
