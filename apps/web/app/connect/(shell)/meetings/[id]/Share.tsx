'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Empty } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { Modal } from '@/components/ui/Modal';
import { Input, Select, Textarea } from '@/components/ui/Form';
import { Field } from '../../ConnectSkin';
import {
  SHARE_EXPOSURE, SHARE_PURPOSE, SHARE_TONE, recordingApi, timeLabel,
  type Recording, type RecordingShare, type ShareCapability, type ShareLevel,
} from '@/lib/connect';

// ============================================================================
//  Sharing a recording with somebody who was not in the meeting.
// ============================================================================
//
//  THE THING THIS SCREEN IS FOR IS NOT "MAKE A LINK". It is making sure the
//  person pressing the button knows who will be able to watch. Every other
//  decision here follows from that.
//
//  ── WHAT THE BASELINE IS, AND WHY IT IS SAID OUT LOUD. ──────────────────
//
//  Everybody who was in the meeting, plus the host, can already open this
//  recording. No share adds them and no share can remove them. That is stated
//  at the top of the dialog rather than assumed, because the alternative is a
//  host who thinks "Only the people I list" means the list is exhaustive and
//  is wrong about who has seen a recording of their own meeting.
//
//  ── THE ORDER OF THE FOUR. ──────────────────────────────────────────────
//
//  Least exposure first, always, and never re-sorted by "most used". A list
//  that puts the widest option where the eye lands first is a list that gets
//  mis-clicked, and this is the one screen in Connect where a mis-click
//  cannot be taken back.
//
//  ── WHY THERE IS NO EDIT. ───────────────────────────────────────────────
//
//  Changing a link's password or expiry is Revoke and then Share again. It
//  is a step more work and it is the honest shape: somebody is holding the
//  old link and believes in it, and "revoked" says that where "updated" hides
//  it. The one exception is the named list, which is a membership rather than
//  a secret, and where adding and removing is what is really happening.
//
//  ── WHAT THIS FILE DELIBERATELY DOES NOT DO. ────────────────────────────
//
//  It never decides whether somebody may read a recording. Every question of
//  that kind is answered by the server, per request, against the share row —
//  including on each range request of a playback. This is the screen that
//  creates the row and says what it means. It is not the control.
// ============================================================================

/**
 * Least exposure first. Not sorted, not configurable — see the header.
 * A level the organisation has not enabled is simply absent from
 * capability.levels and never rendered.
 */
const ORDER: ShareLevel[] = ['organisation', 'named', 'password', 'public'];

/** The server's rule (ConnectShareEndpoints.MinSharePassword), repeated so
 *  the Share button can say no before a round trip. The server decides. */
const MIN_SHARE_PASSWORD = 8;

/**
 * A password nobody has to invent: 12 characters from an alphabet with no
 * look-alikes (no 0/O, 1/l/I), so it survives being read out on a phone call —
 * which is how a host sends it "by a different route to the link".
 * crypto.getRandomValues, never Math.random.
 */
function suggestPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

const TITLE: Record<ShareLevel, string> = {
  organisation: 'People in my organisation',
  named: 'Only the people I list',
  password: 'Anyone with the link and a password',
  public: 'Anyone with the link',
};

export function ShareDialog({
  meetingId, recording, capability, onClose,
}: {
  meetingId: string;
  recording: Recording;
  capability: ShareCapability;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();

  const [shares, setShares] = useState<RecordingShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The share being composed, if any. Null means "looking at what exists".
  const [adding, setAdding] = useState<ShareLevel | null>(null);
  const [days, setDays] = useState(capability.defaultDays);
  const [password, setPassword] = useState('');
  const [emails, setEmails] = useState('');

  // Which link was just copied, so the button can say so for a moment. A
  // copy that gives no feedback is a copy people do three times.
  const [copied, setCopied] = useState<string | null>(null);

  // Named people who have access but could not be emailed. The share worked;
  // this is the sentence telling the host to send the link themselves.
  const [mailNote, setMailNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await recordingApi.shares(authedFetch, meetingId, recording.id);
      setShares(r.shares);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load who this is shared with.');
    }
  }, [authedFetch, meetingId, recording.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Levels this organisation permits, in the fixed order. A level the server
  // did not list is not offered — that is how the fourth one stays off until
  // an administrator turns it on.
  const offered = ORDER.filter((l) => capability.levels.includes(l));

  // One live share per level. A second link at the same level is two links
  // with different expiries and one of them forgotten.
  const taken = new Set((shares ?? []).map((s) => s.level));

  const reset = () => {
    setAdding(null);
    setDays(capability.defaultDays);
    setPassword('');
    setEmails('');
  };

  async function create() {
    if (adding === null) return;
    setBusy(true);
    setError(null);
    setMailNote(null);
    try {
      const made = await recordingApi.share(authedFetch, meetingId, recording.id, {
        level: adding,
        days: adding === 'password' || adding === 'public' ? days : undefined,
        password: adding === 'password' ? password : undefined,
        // The server resolves addresses to accounts and refuses anything it
        // cannot find, so an unknown address is a sentence rather than a
        // silent no-op. Splitting on both commas and newlines because people
        // paste from both.
        userIds: adding === 'named'
          ? emails.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
          : undefined,
      });
      setMailNote(made.mailNote ?? null);
      reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not share that recording.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(share: RecordingShare) {
    setBusy(true);
    setError(null);
    try {
      await recordingApi.unshare(authedFetch, meetingId, recording.id, share.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop that share.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(share: RecordingShare) {
    if (share.url === null) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(share.id);
    } catch {
      // Clipboard access can be refused, and a link nobody can copy is
      // useless — so it goes on screen selectable instead of failing quietly.
      setError('Could not copy automatically. The link is shown above — select it and copy.');
    }
  }

  const valid = adding === null ? false
    : adding === 'password' ? password.length >= MIN_SHARE_PASSWORD && password.length <= 100
    : adding === 'named' ? emails.trim().length > 0
    : true;

  return (
    <Modal
      title="Share this recording"
      subtitle={recording.mode === 'video' ? 'Video recording' : 'Audio recording'}
      size="lg"
      onClose={onClose}
      footer={<Button variant="ghost" onClick={onClose}>Done</Button>}
    >
      {/* THE BASELINE, FIRST, ALWAYS. Somebody choosing "only the people I
          list" must not be left thinking that list is everyone who can see
          this. Not a warning — nothing is wrong — so it is stated plainly
          rather than in a coloured box. */}
      <p className="text-[0.8125rem] text-ink-muted mb-4">
        Everybody who was in the meeting can already open this recording, and
        so can the host. Sharing only ever adds people to that — it never takes
        anybody away.
      </p>

      {error && <Alert tone="danger" className="py-2 text-[0.8125rem]">{error}</Alert>}
      {mailNote && <Alert tone="warn" className="py-2 text-[0.8125rem]">{mailNote}</Alert>}

      {/* ── WHAT ALREADY EXISTS ────────────────────────────────────────── */}
      {shares === null ? (
        <p className="text-[0.8125rem] text-ink-muted">Loading…</p>
      ) : shares.length === 0 ? (
        <Empty
          title="Not shared with anybody outside the meeting"
          hint="The people who were in it can already watch. Add a way in below if somebody else needs to."
        />
      ) : (
        <div className="mb-6">
          {shares.map((s) => (
            <ExistingShare key={s.id} share={s} busy={busy}
                           copied={copied === s.id}
                           onCopy={() => void copy(s)}
                           onRevoke={() => void revoke(s)} />
          ))}
        </div>
      )}

      {/* ── ADDING ONE ─────────────────────────────────────────────────── */}
      {adding === null ? (
        <>
          <h3 className="text-[0.875rem] font-semibold mb-2">Give somebody else a way in</h3>
          {offered.filter((l) => !taken.has(l)).length === 0 ? (
            <p className="text-[0.8125rem] text-ink-muted">
              Every way of sharing this recording is already set up above.
            </p>
          ) : (
            <div className="grid gap-2">
              {/* COLOUR-CODED BY EXPOSURE (Amit, 26 Sept: the options were
                  white cards on a white pop-up). Blue → green → amber → red,
                  least exposure first, the same colour the share keeps once
                  it exists. The words still carry the meaning; the colour is
                  there so the eye finds the red one before the finger does. */}
              {offered.filter((l) => !taken.has(l)).map((l) => (
                <button key={l} type="button"
                        className={`flex w-full items-start gap-3 rounded-card border border-line p-3 text-start
                                    transition hover:shadow-card focus-visible:outline-none
                                    focus-visible:ring-2 focus-visible:ring-brand-500/40 ${SHARE_TONE[l].card}`}
                        onClick={() => setAdding(l)}>
                  <i className={`${SHARE_TONE[l].icon} ${SHARE_TONE[l].accent} mt-0.5 text-lg leading-none`}
                     aria-hidden="true" />
                  <span className="grow">
                    <span className="flex items-center gap-2">
                      <b className="text-[0.875rem] text-ink">{TITLE[l]}</b>
                      <LevelPill level={l} />
                    </span>
                    <span className="mt-0.5 block text-[0.75rem] text-ink-muted">{SHARE_PURPOSE[l]}</span>
                  </span>
                  <i className="ri-arrow-right-s-line mt-0.5 text-lg leading-none text-ink-faint" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {/* Said, rather than the option silently missing: a host looking for
              "anyone with the link" should learn it is the organisation's
              decision and who makes it, not assume the product cannot. */}
          {!capability.levels.includes('public') && (
            <p className="text-[0.75rem] text-ink-muted mt-3 mb-0">
              Links that anyone can open without a password are switched off
              for your organisation. An administrator can allow them under
              Organisation&nbsp;→&nbsp;Sharing.
            </p>
          )}
        </>
      ) : (
        <>
          <h3 className="mb-2 flex items-center gap-2 text-[0.875rem] font-semibold">
            <i className={`${SHARE_TONE[adding].icon} ${SHARE_TONE[adding].accent} text-lg leading-none`}
               aria-hidden="true" />
            {TITLE[adding]}
            <LevelPill level={adding} />
          </h3>

          {/* THE SENTENCE THAT MATTERS, AT THE MOMENT OF THE DECISION.
              Not in a tooltip, not after the link is made. The 'public'
              wording is Core's and is not to be softened: "anyone with the
              link" sounds like a small circle and is not one. */}
          <Exposure level={adding} />

          <div className="grid gap-4 mt-4">
            {adding === 'named' && (
              <Field
                label="Who"
                htmlFor="cx-share-people"
                hint="TatvaOS accounts, one per line. They can be in another organisation. Each of them is emailed a link from your mailbox."
                why={
                  <>
                    Only people who already have a TatvaOS account, for now.
                    An address that is not one is refused rather than turned
                    into an invitation, because an invitation is a different
                    thing to build and a half-built one silently drops people.
                  </>
                }
              >
                {/* The kit's controls, NOT className="cx-field". cx-field is
                    the band AROUND a form row in ConnectSkin, never an input
                    style; used on the control it left these unstyled — a
                    borderless box, white-on-white, and in dark mode a white
                    slab with the text invisible inside it (Amit, 26 Sept). */}
                <Textarea id="cx-share-people" rows={3}
                          value={emails} onChange={(e) => setEmails(e.target.value)}
                          placeholder={'priya@example.com\nrahul@example.com'} />
              </Field>
            )}

            {adding === 'password' && (
              <Field
                label="Password"
                htmlFor="cx-share-pass"
                hint={`At least ${MIN_SHARE_PASSWORD} characters. Copy it now — it cannot be shown again. Send it separately from the link.`}
                why={
                  <>
                    Longer than a meeting password on purpose: a meeting
                    password guards an hour, and this guards a recording for
                    weeks. It is stored hashed, never readable, not even by us,
                    so it cannot be shown back to you later. After ten wrong
                    tries in an hour the link pauses for everybody, and you
                    will see that here.
                  </>
                }
              >
                <div className="flex gap-2">
                  <Input id="cx-share-pass" className="grow font-mono" type="text"
                         autoComplete="off" spellCheck={false}
                         value={password} onChange={(e) => setPassword(e.target.value)} />
                  <Button variant="secondary" size="sm" type="button"
                          onClick={() => setPassword(suggestPassword())}>
                    Suggest one
                  </Button>
                </div>
              </Field>
            )}

            {(adding === 'password' || adding === 'public') && (
              <Field
                label="Stops working after"
                htmlFor="cx-share-days"
                hint={capability.maxDays <= 0
                  ? 'This recording is about to be deleted, so a link cannot outlast it.'
                  : `At most ${capability.maxDays} ${capability.maxDays === 1 ? 'day' : 'days'} — the recording itself is deleted then.`}
                why={
                  <>
                    A link has to expire. The common way for a recording to
                    leak is not a mistake at this screen — it is a link that
                    was right in March and still worked in November.
                  </>
                }
              >
                <Select id="cx-share-days" value={days}
                        onChange={(e) => setDays(Number(e.target.value))}>
                  {[1, 7, 30, 90].filter((d) => d <= capability.maxDays).map((d) => (
                    <option key={d} value={d}>
                      {d === 1 ? '1 day' : `${d} days`}
                      {d === capability.defaultDays ? ' (usual)' : ''}
                    </option>
                  ))}
                  {capability.maxDays > 0 && ![1, 7, 30, 90].includes(capability.maxDays) && (
                    <option value={capability.maxDays}>
                      {capability.maxDays} days — as long as the recording lasts
                    </option>
                  )}
                </Select>
              </Field>
            )}
          </div>

          <div className="flex gap-2 mt-4">
            <Button variant="primary" disabled={busy || !valid}
                    onClick={() => void create()}>
              {busy ? 'Working…' : 'Share'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={reset}>Cancel</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * Who this actually reaches, said once, plainly, before the button is pressed.
 *
 * The two wider levels get a coloured box; the two narrower ones get a plain
 * line. That is not decoration — a warning that appears on all four is a
 * warning that means nothing on any of them.
 */
function Exposure({ level }: { level: ShareLevel }) {
  const loud = level === 'public' || level === 'password';
  if (!loud) {
    return <p className="text-[0.8125rem] text-ink-muted mb-0">{SHARE_EXPOSURE[level]}.</p>;
  }
  return (
    <Alert tone={level === 'public' ? 'danger' : 'warn'} className="py-2 text-[0.8125rem] mb-0">
      <b>{SHARE_EXPOSURE[level]}.</b>
      {level === 'public' && (
        <>
          {' '}
          A link can be forwarded, and it works for whoever holds it — there is
          no sign-in and no way to tell who has watched. Use this only for a
          recording that is meant to be published.
        </>
      )}
      {level === 'password' && (
        <>
          {' '}
          Send the password by a different route to the link. Both in the same
          email is one forwarded email away from being no password at all.
        </>
      )}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
function ExistingShare({ share, busy, copied, onCopy, onRevoke }: {
  share: RecordingShare;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const outside = share.people.filter((p) => p.external);

  return (
    <div className={`mb-2.5 rounded-card border border-line p-3.5 last:mb-0 ${SHARE_TONE[share.level].card}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2 flex-wrap">
            <i className={`${SHARE_TONE[share.level].icon} ${SHARE_TONE[share.level].accent} text-lg leading-none`}
               aria-hidden="true" />
            <b className="text-[0.875rem] text-ink">{TITLE[share.level]}</b>
            <LevelPill level={share.level} />
          </div>

          <div className="text-[0.75rem] text-ink-muted mt-1">
            {SHARE_EXPOSURE[share.level]}.
            {share.expiresAt !== null && <> Stops working {timeLabel(share.expiresAt)}.</>}
          </div>

          {/* Named people, and — separately and always — the ones who are not
              colleagues. Sharing outside your own organisation should never be
              something you have to work out from a list of addresses. */}
          {share.level === 'named' && share.people.length > 0 && (
            <div className="text-[0.75rem] mt-1">
              {share.people.map((p) => p.name).join(', ')}
              {outside.length > 0 && (
                <div className="mt-1 font-medium text-warn">
                  {outside.length === 1
                    ? `${outside[0]!.name} is outside your organisation.`
                    : `${outside.length} of these people are outside your organisation.`}
                </div>
              )}
            </div>
          )}

          {/* Somebody guessing the password. Said beside THIS share, because
              it is this link that has leaked or is being tried, and the host's
              remedy — stop it and make a new one — is the button next to it. */}
          {share.passwordPausedUntil ? (
            <div className="mt-1 rounded-md bg-danger/10 px-2 py-1.5 text-[0.75rem] font-medium text-danger">
              Someone has been guessing this link&rsquo;s password. Stop it and
              share a new link to let your viewers back in — otherwise it stays
              paused for everybody until {timeLabel(share.passwordPausedUntil)}.
            </div>
          ) : share.wrongPasswords24h > 0 && (
            <div className="mt-1 text-[0.75rem] font-medium text-warn">
              {share.wrongPasswords24h === 1
                ? 'One wrong password was tried on this link in the last day.'
                : `${share.wrongPasswords24h} wrong passwords were tried on this link in the last day.`}
            </div>
          )}

          {/* Opened, by people who were not in the meeting. Participants are
              not counted — they are the baseline, and counting them would
              make every share look used. */}
          <div className="text-[0.75rem] text-ink-muted mt-1">
            {share.opens === 0
              ? 'Not opened yet by anybody outside the meeting.'
              : share.opens === 1
                ? 'Opened once by somebody outside the meeting.'
                : `Opened ${share.opens} times by people outside the meeting.`}
          </div>

          {share.url !== null && (
            <Input className="mt-2 font-mono text-[12px]" readOnly value={share.url}
                   onFocus={(e) => e.currentTarget.select()}
                   aria-label="The share link" />
          )}
        </div>

        {/* Two buttons that look like buttons. Both were ghost buttons —
            grey text on the card, no edge — and the danger class lost to the
            ghost variant's own colour, so "Stop sharing" was grey too. */}
        <div className="flex shrink-0 gap-2 sm:flex-col">
          {share.url !== null && (
            <Button variant="secondary" size="sm" onClick={onCopy} disabled={busy}>
              <i className={copied ? 'ri-check-line' : 'ri-file-copy-line'} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          )}
          <Button variant="secondary" size="sm"
                  className="!border-danger/40 !text-danger hover:!bg-danger/10"
                  disabled={busy} onClick={onRevoke}>
            <i className="ri-close-circle-line" aria-hidden="true" />
            Stop sharing
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The level's colour and a short word — on the choice, the heading of the
 *  form, and every existing share, so the three always agree. */
function LevelPill({ level }: { level: ShareLevel }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${SHARE_TONE[level].badge}`}>
      {SHARE_TONE[level].word}
    </span>
  );
}
