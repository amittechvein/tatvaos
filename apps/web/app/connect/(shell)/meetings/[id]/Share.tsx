'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Empty } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Field } from '../../ConnectSkin';
import {
  SHARE_EXPOSURE, SHARE_PURPOSE, recordingApi, timeLabel,
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
    try {
      await recordingApi.share(authedFetch, meetingId, recording.id, {
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
    : adding === 'password' ? password.length >= 4 && password.length <= 100
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
      <p className="fs-13 text-muted mb-3">
        Everybody who was in the meeting can already open this recording, and
        so can the host. Sharing only ever adds people to that — it never takes
        anybody away.
      </p>

      {error && <div className="alert alert-danger py-2 fs-13">{error}</div>}

      {/* ── WHAT ALREADY EXISTS ────────────────────────────────────────── */}
      {shares === null ? (
        <p className="fs-13 text-muted">Loading…</p>
      ) : shares.length === 0 ? (
        <Empty
          title="Not shared with anybody outside the meeting"
          hint="The people who were in it can already watch. Add a way in below if somebody else needs to."
        />
      ) : (
        <div className="mb-4">
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
          <h3 className="fs-14 fw-semibold mb-2">Give somebody else a way in</h3>
          {offered.filter((l) => !taken.has(l)).length === 0 ? (
            <p className="fs-13 text-muted">
              Every way of sharing this recording is already set up above.
            </p>
          ) : (
            <div className="d-grid gap-2">
              {offered.filter((l) => !taken.has(l)).map((l) => (
                <button key={l} type="button" className="cx-choice text-start"
                        onClick={() => setAdding(l)}>
                  <b>{TITLE[l]}</b>
                  <span className="cx-note">{SHARE_PURPOSE[l]}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <h3 className="fs-14 fw-semibold mb-2">{TITLE[adding]}</h3>

          {/* THE SENTENCE THAT MATTERS, AT THE MOMENT OF THE DECISION.
              Not in a tooltip, not after the link is made. The 'public'
              wording is Core's and is not to be softened: "anyone with the
              link" sounds like a small circle and is not one. */}
          <Exposure level={adding} />

          <div className="d-grid gap-3 mt-3">
            {adding === 'named' && (
              <Field
                label="Who"
                htmlFor="cx-share-people"
                hint="TatvaOS accounts, one per line. They can be in another organisation."
                why={
                  <>
                    Only people who already have a TatvaOS account, for now.
                    An address that is not one is refused rather than turned
                    into an invitation, because an invitation is a different
                    thing to build and a half-built one silently drops people.
                  </>
                }
              >
                <textarea id="cx-share-people" className="cx-field" rows={3}
                          value={emails} onChange={(e) => setEmails(e.target.value)}
                          placeholder={'priya@example.com\nrahul@example.com'} />
              </Field>
            )}

            {adding === 'password' && (
              <Field
                label="Password"
                htmlFor="cx-share-pass"
                hint="4 to 100 characters. Send it separately from the link."
                why={
                  <>
                    Stored the same way a meeting password is — hashed, never
                    readable, not even by us. That also means it cannot be
                    shown back to you later: if you forget it, revoke the link
                    and make a new one.
                  </>
                }
              >
                <input id="cx-share-pass" className="cx-field" type="text"
                       autoComplete="off"
                       value={password} onChange={(e) => setPassword(e.target.value)} />
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
                <select id="cx-share-days" className="cx-field" value={days}
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
                </select>
              </Field>
            )}
          </div>

          <div className="d-flex gap-2 mt-3">
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
    return <p className="fs-13 text-muted mb-0">{SHARE_EXPOSURE[level]}.</p>;
  }
  return (
    <div className={`alert py-2 fs-13 mb-0 ${level === 'public' ? 'alert-danger' : 'alert-warning'}`}>
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
    </div>
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
    <div className="cx-shared">
      <div className="d-flex align-items-start gap-2">
        <div className="flex-grow-1">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <b className="fs-14">{TITLE[share.level]}</b>
            {share.level === 'public' && <Badge tone="danger">Public</Badge>}
            {share.hasPassword && <Badge tone="neutral">Password</Badge>}
          </div>

          <div className="fs-12 text-muted mt-1">
            {SHARE_EXPOSURE[share.level]}.
            {share.expiresAt !== null && <> Stops working {timeLabel(share.expiresAt)}.</>}
          </div>

          {/* Named people, and — separately and always — the ones who are not
              colleagues. Sharing outside your own organisation should never be
              something you have to work out from a list of addresses. */}
          {share.level === 'named' && share.people.length > 0 && (
            <div className="fs-12 mt-1">
              {share.people.map((p) => p.name).join(', ')}
              {outside.length > 0 && (
                <div className="text-warning-emphasis mt-1">
                  {outside.length === 1
                    ? `${outside[0]!.name} is outside your organisation.`
                    : `${outside.length} of these people are outside your organisation.`}
                </div>
              )}
            </div>
          )}

          {/* Opened, by people who were not in the meeting. Participants are
              not counted — they are the baseline, and counting them would
              make every share look used. */}
          <div className="fs-12 text-muted mt-1">
            {share.opens === 0
              ? 'Not opened yet by anybody outside the meeting.'
              : share.opens === 1
                ? 'Opened once by somebody outside the meeting.'
                : `Opened ${share.opens} times by people outside the meeting.`}
          </div>

          {share.url !== null && (
            <input className="cx-field cx-linkbox mt-2" readOnly value={share.url}
                   onFocus={(e) => e.currentTarget.select()}
                   aria-label="The share link" />
          )}
        </div>

        <div className="d-flex flex-column gap-2">
          {share.url !== null && (
            <Button variant="ghost" className="btn-sm" onClick={onCopy} disabled={busy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          )}
          <Button variant="ghost" className="btn-sm text-danger"
                  disabled={busy} onClick={onRevoke}>
            Stop sharing
          </Button>
        </div>
      </div>
    </div>
  );
}
