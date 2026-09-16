// ============================================================================
//  TatvaOS Connect — API client
// ============================================================================
//
//  Speaks docs/CONNECT_API.md and nothing else. Two properties of that
//  contract are load-bearing here and must survive any refactor:
//
//  THE GUEST PATH HAS ONE FAILURE ANSWER. Unknown code, cancelled meeting,
//  guests turned off, suspended organisation — every one is 404 with the same
//  sentence. The UI must NOT try to be more helpful than that: inventing
//  distinct copy per status code would rebuild, in the browser, exactly the
//  oracle the server refuses to be.
//
//  wsUrl IS AN ORIGIN, NOT A PATH. livekit-client appends /rtc/v1 itself; a
//  value ending in /rtc becomes /rtc/rtc/v1 and 401s. Phase 0 lost an evening
//  to this, so the client asserts it rather than trusting it.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The API origin. Declared here rather than beside the guest calls that first
 * needed it, because recordingApi.ticketUrl below also builds a URL from it
 * and a const referenced above its own declaration is a temporal-dead-zone
 * trap waiting for the day somebody calls it during module evaluation.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export type MeetingStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';
export type WaitingRoom = 'off' | 'guests' | 'everyone';
export type MeetingRole = 'host' | 'cohost' | 'participant';
/** Who may share a screen. Enforced server-side in the LiveKit token; the UI
 *  reads it only to decide what to show. */
export type SharePolicy = 'host' | 'cohost' | 'everyone';
/** How many may share AT ONCE — a different question from SharePolicy, which is
 *  WHO. 'single' is enforced server-side through LiveKit grants driven by the
 *  track webhooks (ConnectShareEnforcement); the UI reads it only to say
 *  "Ravi is sharing" instead of offering a button that will be refused. */
export type ShareMode = 'multiple' | 'single';

/**
 * Who may SEND chat. Everyone always READS.
 *
 * Unlike SharePolicy this is NOT enforced server-side. Chat shares one data
 * channel with raised hands, reactions and file transfers, and the only token
 * grant available covers all four — silencing chat by token would also stop
 * somebody raising a hand to ask why. So the client keeps it, in the same way
 * a client already reports its own raised hand honestly. Enough to stop
 * twenty people talking over a presenter; not a security control, and nothing
 * in this codebase should treat it as one.
 */
export type ChatPolicy = 'everyone' | 'cohost' | 'off';

/**
 * What kind of meeting this is, chosen at creation and never changeable.
 *
 * 'private' means the media is encrypted with a key the meeting server does
 * not hold, so recording, transcription and AI notes are impossible rather
 * than merely switched off.
 *
 * ── WORDING RULE, NOT A STYLE PREFERENCE ────────────────────────────────
 * Never render 'private' as plain "end-to-end encrypted". Our API derives
 * the key and hands it out, so the true claim is that the MEETING SERVER
 * cannot see or hear the meeting — not that TatvaOS could never. Say the
 * first; a customer who reads the second and later learns otherwise has
 * been misled. PRIVATE_BLURB below is the sentence to use.
 */
export type MeetingMode = 'recorded' | 'private';

export const PRIVATE_BLURB =
  'Encrypted so the meeting server cannot see or hear it. It cannot be '
  + 'recorded, transcribed or summarised.';

export const RECORDED_BLURB =
  'Can be recorded, transcribed and summarised. Everyone is told, on screen '
  + 'and aloud, whenever recording starts.';

export interface Meeting {
  id: string;
  code: string;
  joinUrl: string;
  title: string;
  kind: string;
  status: MeetingStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  timezone: string | null;
  startedAt: string | null;
  endedAt: string | null;
  hasPassword: boolean;
  waitingRoom: WaitingRoom;
  allowGuests: boolean;
  locked: boolean;
  /** A request, not a guarantee: the room_started webhook re-checks the org's
   *  recording flag and the storage gate at the moment the room starts. */
  autoRecord: boolean;
  sharePolicy: SharePolicy;
  /** Absent on an older server; treat that as 'multiple', which is what it did. */
  shareMode?: ShareMode;
  chatPolicy: ChatPolicy;
  /** Capture live captions from participants' browsers, so the meeting gets
   *  attributed minutes. Off by default. This REPLACED paid transcription:
   *  see useCaptions.ts for the sum, and 20260910 for the reasoning. */
  minutesLive: boolean;
  mode: MeetingMode;
  createdByUserId: string | null;
  myRole: MeetingRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingPage {
  meetings: Meeting[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Participant {
  identity: string;
  displayName: string;
  role: MeetingRole;
  isGuest: boolean;
  /** DERIVED from the event log, never a stored flag — see ListParticipantsAsync. */
  connected: boolean;
  firstJoinedAt: string | null;
  lastSeenAt: string | null;
}

export interface LobbyEntry {
  requestId: string;
  displayName: string;
  isGuest: boolean;
  requestedAt: string;
}

/** Somebody a host removed from this meeting, and who therefore cannot rejoin. */
export interface MeetingBlock {
  id: string;
  displayName: string;
  identity: string;
  createdAt: string;
  /** False for a guest: the row is a record of what happened, and stops
   *  nothing — a guest's identity is minted fresh at every door, so the
   *  waiting room is the only thing between them and the meeting. The list
   *  says so rather than showing a block it is not enforcing. */
  enforced: boolean;
}

/** A seat: everything needed to open a LiveKit connection. */
export interface Seat {
  status: 'joined' | 'admitted';
  token: string;
  wsUrl: string;
  identity: string;
  mode?: MeetingMode;
  /** A guest has no meeting row to read, so the rule that decides whether
   *  they may type travels with the seat. Absent on an older server, which
   *  the room reads as 'everyone' — the same answer it had before. */
  chatPolicy?: ChatPolicy;
  /** Present ONLY for a private meeting. It rides this one response and dies
   *  with the tab: never store it, never log it, never put it in a URL. */
  roomKey?: string | null;
}

/** Parked in the waiting room; poll `waitToken` until admitted or denied. */
export interface Waiting {
  status: 'waiting';
  waitToken: string;
}

export type JoinResult = Seat | Waiting;

/** What a code-holder learns at the door, before they are anybody. */
export interface Doorstep {
  title: string;
  /** So the browser can refuse an encrypted meeting it cannot decode before
   *  a token is ever minted. */
  mode: MeetingMode;
  scheduledStart: string | null;
  state: 'active' | 'ended' | 'not_started';
  passwordRequired: boolean;
  locked: boolean;
  /**
   * Whether minutes are being written, told to a guest BEFORE they join.
   *
   * A signed-in colleague sees the switch and the disclosure beside it inside
   * the room. A guest sees neither: they arrive by link, they are not asked
   * anything, and until this they were not told anything either.
   *
   * The word "before" is the whole point. Being told at the door is a choice;
   * being told once you are already in the room and speaking is a notice.
   *
   * Absent on an older server, which the door reads as "do not claim
   * anything" — silence, not a false reassurance.
   */
  minutesLive?: boolean;
}

export interface CreateMeeting {
  title?: string;
  kind?: 'instant' | 'scheduled';
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  timezone?: string | null;
  password?: string | null;
  waitingRoom?: WaitingRoom;
  allowGuests?: boolean;
  autoRecord?: boolean;
  sharePolicy?: SharePolicy;
  shareMode?: ShareMode;
  chatPolicy?: ChatPolicy;
  minutesLive?: boolean;
  /** Chosen once. There is deliberately no way to change it afterwards —
   *  UpdateMeeting below does not carry it, and the database refuses. */
  mode?: MeetingMode;
}

/**
 * What an edit may carry — and `mode` is deliberately NOT in it.
 *
 * This used to be `Partial<CreateMeeting & …>`, which inherited `mode` and so
 * type-checked a call that could never work: the server's UpdateMeetingRequest
 * has no Mode field and the database trigger refuses the change outright, so
 * `update(…, { mode: 'private' })` compiled, sent, and silently did nothing.
 * The comment beside CreateMeeting.mode already claimed this type did not
 * carry it. Now it does not — Omit makes the claim true, and an edit screen
 * that tries to offer the choice fails at the keyboard instead of in
 * production.
 */
export type UpdateMeeting = Partial<Omit<CreateMeeting, 'mode'> & { locked: boolean }>;

// ---------------------------------------------------------------------------
/**
 * The one sentence the guest path ever says. Held here so a screen cannot
 * accidentally render a server message that varies — see the header.
 */
export const GUEST_FAILURE = 'This meeting link does not work.';

/** Thrown when a wrong password is given for a code that IS valid (403). */
export class WrongPasswordError extends Error {
  constructor(message = 'That password is not right.') { super(message); }
}

/** Thrown when the door itself refuses — always the same sentence. */
export class DoorClosedError extends Error {
  constructor(message = GUEST_FAILURE) { super(message); }
}

/**
 * The server's sentence, or ours.
 *
 * ── IT READS `detail` TOO, AND THAT IS NOT COSMETIC. ────────────────────
 * The API says no in two shapes. Most refusals are Results.Json with an
 * `error` field. But every Results.Problem — "Connect is not configured on
 * this server", the recording refusals, several 503s — produces RFC 7807
 * ProblemDetails, where the sentence is in `detail`. This function used to
 * read `error` only, so every one of those carefully written explanations was
 * discarded on arrival and the person saw a generic fallback instead.
 *
 * Nobody noticed because the fallback is always plausible. That is the whole
 * problem with it: "Could not start recording" is true of a server with no
 * spare CPU, a server with no egress at all, and a server that is on fire.
 */
async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const bag = typeof body === 'object' && body !== null
      ? body as { error?: unknown; detail?: unknown }
      : null;
    const said = bag?.error ?? bag?.detail;
    const msg = typeof said === 'string' && said.trim().length > 0 ? said : fallback;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/**
 * Can this browser do encrypted meetings at all?
 *
 * ── ASKED AT THE DOOR, BEFORE A TOKEN IS MINTED. ────────────────────────
 * LiveKit's E2EE needs a secure context, a Worker, and the browser's own
 * media-transform API. Where any of those is missing the meeting simply will
 * not decode — and the failure mode without this check is a black screen and
 * silence, which reads as "TatvaOS is broken", not "your browser is too old".
 *
 * A sentence before a token beats a black screen after one. That is the rule
 * from CONNECT_PHASE_NEXT; this function is where it is enforced.
 *
 * Feature-DETECTED, never sniffed from a user-agent string or a support
 * table: the fleet our guests actually carry is older Android and Firefox,
 * and a table in a document is a claim, while this is the browser answering
 * for itself. Both spellings are checked because browsers disagree about
 * which one they ship — betting on one would fail on half the fleet.
 */
export function e2eeSupported(): boolean {
  if (typeof window === 'undefined') return false;
  // A secure context is required for the transform APIs and for workers to
  // do anything useful with media. localhost counts as secure.
  if (!window.isSecureContext) return false;
  if (typeof Worker === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  const insertable = 'RTCRtpSender' in w
    && typeof (w.RTCRtpSender as { prototype?: Record<string, unknown> })?.prototype
         ?.createEncodedStreams === 'function';
  const scriptTransform = 'RTCRtpScriptTransform' in w;
  return insertable || scriptTransform;
}

/**
 * Can this browser capture a screen at all?
 *
 * ── THE ANSWER ON EVERY PHONE IS NO, AND IT IS NOT OUR DOING. ───────────
 *
 * getDisplayMedia is unimplemented in every mobile browser: Chrome for
 * Android, Safari on iOS, Firefox for Android and Samsung Internet all lack
 * it. It is not a permission the person can grant, a setting they can find,
 * or something a newer version fixes — the API is simply absent, because
 * capturing the screen is an operating-system privilege that iOS and Android
 * hand to installed apps and not to web pages. It is why Zoom and Meet can
 * share a phone screen from their APPS and not from their websites.
 *
 * Feature-detected rather than sniffed, for the same reason as above: the
 * browser answering for itself beats any table we could keep up to date.
 *
 * Note this is checked and EXPLAINED rather than used to hide the button —
 * the opposite of the recording control, which is hidden outright when the
 * server has no egress. The difference is who can act on it: an
 * unconfigured server is nothing a participant can do anything about, while
 * "your phone cannot do this, a computer can" is a fact they can act on in
 * the next minute. Hiding it would leave them hunting for a button everyone
 * tells them exists.
 */
export function screenCaptureSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Guards the mistake Phase 0 actually made.
 *
 * livekit-client appends /rtc/v1 to whatever it is handed. Given
 * "wss://host/rtc" it requests /rtc/rtc/v1 and the server answers 401 — which
 * reads as a bad token and sends you looking in entirely the wrong place.
 */
export function assertOrigin(wsUrl: string): string {
  const trimmed = wsUrl.trim().replace(/\/+$/, '');
  if (/\/rtc$/i.test(trimmed)) {
    throw new Error(
      'wsUrl must be an origin. livekit-client appends /rtc/v1 itself, so a '
      + 'value ending in /rtc produces /rtc/rtc/v1 and a 401.',
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
//  Signed in
// ---------------------------------------------------------------------------
export const connectApi = {
  list: (f: AuthedFetch, range: 'upcoming' | 'today' | 'past', page = 1) =>
    f(`/connect/meetings?range=${range}&page=${page}`)
      .then((r) => json<MeetingPage>(r, 'Could not load your meetings.')),

  get: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}`)
      .then((r) => json<Meeting>(r, 'Could not open that meeting.')),

  /**
   * Resolve a shareable CODE to a meeting, for somebody signed in.
   *
   * A link carries the code; every authenticated route keys on the id. Scoped
   * by RLS to the caller's own organisation, so another tenant's code is 404 —
   * the same answer as a code that never existed. Guests do NOT use this; they
   * use guestApi.doorstep, which applies the guest predicate this omits.
   */
  byCode: (f: AuthedFetch, code: string) =>
    f(`/connect/meetings/by-code/${encodeURIComponent(code)}`)
      .then((r) => json<Meeting>(r, 'That meeting is not here.')),

  create: (f: AuthedFetch, body: CreateMeeting) =>
    f('/connect/meetings', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<Meeting>(r, 'Could not create the meeting.')),

  update: (f: AuthedFetch, id: string, body: UpdateMeeting) =>
    f(`/connect/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then((r) => json<Meeting>(r, 'Could not save that change.')),

  cancel: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not cancel that meeting.'); }),

  participants: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/participants`)
      .then((r) => json<{ participants: Participant[] }>(r, 'Could not load participants.')),

  join: async (f: AuthedFetch, id: string, password?: string): Promise<JoinResult> => {
    const res = await f(`/connect/meetings/${id}/join`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    });
    if (res.status === 403) throw new WrongPasswordError();
    const out = await json<JoinResult>(res, 'Could not join that meeting.');
    if (out.status !== 'waiting') out.wsUrl = assertOrigin(out.wsUrl);
    return out;
  },

  lobby: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/lobby`)
      .then((r) => json<{ waiting: LobbyEntry[] }>(r, 'Could not load the waiting room.')),

  admit: (f: AuthedFetch, id: string, requestId: string) =>
    f(`/connect/meetings/${id}/lobby/${requestId}/admit`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not admit that person.'); }),

  deny: (f: AuthedFetch, id: string, requestId: string) =>
    f(`/connect/meetings/${id}/lobby/${requestId}/deny`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not turn that person away.'); }),

  // --- host controls. Each one reaches LiveKit; a failure here means the
  // person is still in the room, so none of them may be reported optimistically.
  /** 'screen' stops a share without touching the person's camera. */
  mute: (f: AuthedFetch, id: string, identity: string, kind: 'audio' | 'video' | 'screen' = 'audio') =>
    f(`/connect/meetings/${id}/participants/${encodeURIComponent(identity)}/mute`, {
      method: 'POST', body: JSON.stringify({ kind }),
    }).then((r) => { if (!r.ok) throw new Error('Could not mute them. They are still unmuted.'); }),

  remove: (f: AuthedFetch, id: string, identity: string) =>
    f(`/connect/meetings/${id}/participants/${encodeURIComponent(identity)}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not remove them. They are still in the meeting.'); }),

  setRole: (f: AuthedFetch, id: string, identity: string, role: 'cohost' | 'participant') =>
    f(`/connect/meetings/${id}/participants/${encodeURIComponent(identity)}/role`, {
      method: 'PUT', body: JSON.stringify({ role }),
    }).then((r) => { if (!r.ok) throw new Error('Could not change their role.'); }),

  /**
   * Hand the meeting to somebody else — the "Leave and assign a new host"
   * path. Distinct from setRole, which deliberately refuses 'host'. The old
   * host becomes a cohost; the caller should disconnect AFTER this resolves,
   * because a failure here means the meeting still has no other host.
   */
  transferHost: async (f: AuthedFetch, id: string, identity: string) => {
    const r = await f(`/connect/meetings/${id}/host`, {
      method: 'POST', body: JSON.stringify({ identity }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? 'Could not hand the meeting over.');
    }
  },

  end: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/end`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not end the meeting.'); }),

  // --- undoing the two above. Neither reaches LiveKit: reopening a meeting
  // changes a row, and the next person through the door is what makes a room
  // exist again.
  reopen: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/reopen`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not reopen that meeting.'); }),

  blocks: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/blocks`)
      .then((r) => json<MeetingBlock[]>(r, 'Could not load who was removed.')),

  unblock: (f: AuthedFetch, id: string, blockId: string) =>
    f(`/connect/meetings/${id}/blocks/${blockId}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not let that person back in.'); }),
};

// ---------------------------------------------------------------------------
//  Recording, transcripts and notes
//
//  Everything here is signed-in only. A guest can be IN a recorded meeting —
//  and is told so by the room, from LiveKit's own recording flag — but has no
//  route to the file afterwards.
// ---------------------------------------------------------------------------
export type RecordingMode = 'audio' | 'video';

export type RecordingStatus =
  | 'starting' | 'recording' | 'processing' | 'ready' | 'failed' | 'aborted' | 'deleted';

export interface Recording {
  id: string;
  meetingId: string;
  mode: RecordingMode;
  status: RecordingStatus;
  sizeBytes: number;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  transcribe: boolean;
  /** "Keep this one": the retention sweep will not touch this recording
   *  before this instant. Null = the organisation's retention applies. */
  keepUntilAt: string | null;
  error: string | null;
  hasFile: boolean;
  createdAt: string;
}

/**
 * 'unavailable' is NOT a failure — it means nobody configured a transcription
 * service. The screen says so in those words, because "something went wrong"
 * would send somebody looking for a bug that is really an unset variable.
 */
export type TranscriptStatus = 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export interface RecordingListItem {
  recording: Recording;
  transcript: {
    status: TranscriptStatus;
    language: string | null;
    /** The server's own sentence about what went wrong — "the recording was
     *  too large", "an administrator needs to check the key", "the recording
     *  may be silent". Present on 'failed'; null otherwise. Show it INSTEAD
     *  of a generic line, never alongside one. */
    error: string | null;
  } | null;
}

export interface RecordingList {
  /** False when this server has no egress deployed. Distinguishes "recording
   *  is off here" from "nobody has recorded this meeting", which an empty
   *  list cannot. */
  enabled: boolean;
  transcription: boolean;
  /**
   * Absent or null when this server does not do recording sharing at all —
   * an older API, or the feature not deployed yet. The Share control is
   * HIDDEN in that case rather than shown and failing, which is the same rule
   * the Record button already follows when there is no egress: a control that
   * is always there and never works reads as a broken product.
   *
   * OPTIONAL, not just nullable, and the difference is not pedantry: a server
   * that has never heard of sharing omits the field entirely, and a type that
   * promised `ShareCapability | null` would be describing a response nobody
   * sends. Every reader must treat missing and null the same.
   */
  sharing?: ShareCapability | null;
  items: RecordingListItem[];
}

// ---------------------------------------------------------------------------
//  SHARING A RECORDING WITH SOMEBODY WHO WAS NOT IN THE MEETING.
//
//  Four levels, ruled by Core in August 2026, in the order they give away
//  more. THE BASELINE NEVER MOVES: everybody who was in the meeting, and the
//  host, can already read the recording and no share can take that away. A
//  share only ever ADDS a reader.
// ---------------------------------------------------------------------------

export type ShareLevel = 'organisation' | 'named' | 'password' | 'public';

/**
 * What a person is agreeing to, in the words they should read BEFORE they
 * agree to it — not after, and not in a tooltip.
 *
 * `public` is worded exactly as Core specified it and MUST NOT be softened.
 * "Anyone with the link" is how every product in this category describes it
 * and it is how people end up surprised: it sounds like a small circle. The
 * sentence has to name the actual set of people.
 */
export const SHARE_EXPOSURE: Record<ShareLevel, string> = {
  organisation: 'Anyone signed in to your organisation',
  named: 'Only the people you list, wherever they work',
  password: 'Anyone holding this link who also knows the password',
  public: 'Anyone on the internet holding this link',
};

/** One line on what the level is FOR, so the choice is not made on exposure alone. */
export const SHARE_PURPOSE: Record<ShareLevel, string> = {
  organisation: 'For a recording your colleagues may need and you cannot list in advance.',
  named: 'For a named few — a client, an auditor, somebody who missed it.',
  password: 'For sending outside the organisation when you can pass on a password separately.',
  public: 'For a recording that is genuinely meant to be published.',
};

export interface ShareCapability {
  /**
   * The levels this organisation permits. 'public' is ABSENT unless an
   * administrator has switched it on — it is off by default, per
   * organisation, the same shape as Space's public-links kill switch.
   *
   * Read this rather than hardcoding the four: a level missing here must not
   * be offered, and a level added later must appear without a web deploy.
   */
  levels: ShareLevel[];
  /** Default life of a new link, in days. 7 unless the server says otherwise. */
  defaultDays: number;
  /**
   * The longest this particular recording can be shared for — the days left
   * before it is deleted by the retention sweep. Expiry is mandatory on the
   * two link levels and can never outlive the file, so a link that survives
   * the recording is not offered rather than issued and then broken.
   */
  maxDays: number;
}

export interface SharePerson {
  userId: string;
  name: string;
  email: string;
  /**
   * True when they are in a DIFFERENT organisation to the recording. Shown,
   * always — sharing outside your own organisation should never be something
   * you have to work out from a list of email addresses.
   *
   * Whether, not where. The server deliberately does not send the other
   * organisation's NAME: "this person is not one of us" is the fact a host
   * needs, and it is read from the grant rather than from the person's
   * current row, so somebody changing employer later does not quietly rewrite
   * what the host agreed to.
   */
  external: boolean;
}

export interface RecordingShare {
  id: string;
  recordingId: string;
  level: ShareLevel;
  /** The full link to hand somebody. Null for the two levels that have no
   *  link — those are reached by signing in, not by holding a URL. */
  url: string | null;
  hasPassword: boolean;
  /** Null only for the levels where expiry is optional; never null on
   *  'password' or 'public'. */
  expiresAt: string | null;
  /** 'named' only, empty otherwise. */
  people: SharePerson[];
  /** How many times somebody who was NOT in the meeting has opened it.
   *  Participants are not counted — they are the baseline, not a share. */
  opens: number;
  createdAt: string;
  createdBy: string;
}

export interface NewShare {
  level: ShareLevel;
  /** Required for 'password' and 'public'. Must be <= capability.maxDays. */
  days?: number;
  /** 'password' only. Same rules as a meeting password: 4 to 100 characters. */
  password?: string;
  /** 'named' only. TatvaOS accounts; cross-organisation is allowed. */
  userIds?: string[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Reserved. Always null today: a room-composite recording is one mixed
   *  stream and there is nothing in it to attribute. */
  speaker: string | null;
}

export interface SpeakerTime { name: string; seconds: number; turns: number }

/** Who actually attended. Present for every ended meeting — this comes from
 *  the API's own participant rows and the media server's event log, so it
 *  exists whether or not anything was ever recorded. */
export interface Attendee {
  identity: string;
  name: string;
  guest: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  seconds: number;
  joins: number;
}

export interface MeetingNotes {
  status: 'queued' | 'running' | 'ready' | 'failed';
  /** 'digest' was assembled from the transcript on the server with no model
   *  involved; 'model' was written by a language model. The UI says which. */
  kind: 'digest' | 'model';
  model: string | null;
  summary: string | null;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  speakers: SpeakerTime[];
  attendance: Attendee[];
  /** Whether there was a transcript to work from. Lets the screen say "this
   *  meeting was not recorded" — normal — rather than implying a failure. */
  hadTranscript: boolean;
  /** Whether a READY recording existed when the notes were written. With
   *  hadTranscript this picks one of three true sentences — "no transcript"
   *  alone cannot say WHY there is none. */
  hadRecording: boolean;
  error: string | null;
  generatedAt: string | null;
}

export interface NotesPayload {
  recordingEnabled: boolean;
  transcriptionConfigured: boolean;
  notesModelConfigured: boolean;
  transcript: {
    status: TranscriptStatus;
    language: string | null;
    provider: string | null;
    error: string | null;
    text: string | null;
    segments: TranscriptSegment[];
  } | null;
  notes: MeetingNotes | null;
}

export const recordingApi = {
  list: (f: AuthedFetch, meetingId: string) =>
    f(`/connect/meetings/${meetingId}/recordings`)
      .then((r) => json<RecordingList>(r, 'Could not load the recordings.')),

  /**
   * Audio by default, everywhere, and not as a shortcut: LiveKit prices a
   * video room composite at 4 CPU against 1 for audio, on a box that is also
   * running the SFU.
   */
  start: (f: AuthedFetch, meetingId: string, mode: RecordingMode = 'audio', transcribe = true) =>
    f(`/connect/meetings/${meetingId}/recordings`, {
      method: 'POST', body: JSON.stringify({ mode, transcribe }),
    }).then((r) => json<Recording>(r, 'Could not start recording.')),

  stop: (f: AuthedFetch, meetingId: string, recordingId: string) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/stop`, { method: 'POST' })
      .then((r) => json<Recording>(r, 'Could not stop the recording.')),

  remove: (f: AuthedFetch, meetingId: string, recordingId: string) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not delete that recording.'); }),

  /**
   * Downloading takes TWO steps, and the reason is worth knowing before
   * anybody "simplifies" it back.
   *
   * This app holds the access token in memory and sends it as an
   * Authorization header — see the top of lib/auth.tsx. A plain <a href> is a
   * NAVIGATION: the browser sends cookies and nothing else, so a link to an
   * authorised route arrives with no header and answers 401. The first
   * version of this was exactly that link, and the download could never have
   * worked.
   *
   * So: ask for a signed ticket with a real authorised request, then let the
   * browser navigate to a URL carrying it. Same shape as every object store's
   * pre-signed URL.
   */
  /**
   * "Keep this one" — exempt a recording from the retention sweep for a
   * further 30/90/180/365 days, or pass null to clear the hold and let the
   * organisation's retention apply again. Host only, like delete.
   */
  keep: (f: AuthedFetch, meetingId: string, recordingId: string,
         days: 30 | 90 | 180 | 365 | null) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/keep`, {
      method: 'PUT', body: JSON.stringify({ days }),
    }).then((r) => json<Recording>(r, 'Could not change how long that recording is kept.')),

  ticket: (f: AuthedFetch, meetingId: string, recordingId: string) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/ticket`)
      .then((r) => json<{ ticket: string }>(r, 'Could not prepare that download.')),

  /** Where the ticket is spent. Anonymous by necessity; the signature is the
   *  control, and the server re-checks every permission behind it. */
  ticketUrl: (ticket: string) =>
    `${API}/connect/recordings/file?t=${encodeURIComponent(ticket)}`,

  /** Ask, then go. One call for the button to make. */
  download: async (f: AuthedFetch, meetingId: string, recordingId: string) => {
    const { ticket } = await recordingApi.ticket(f, meetingId, recordingId);
    // assign, not open: the response carries Content-Disposition: attachment,
    // so the browser downloads it and stays where it is. window.open would
    // flash a blank tab that some blockers eat.
    window.location.assign(recordingApi.ticketUrl(ticket));
  },

  // ── SHARING ────────────────────────────────────────────────────────────
  //
  //  Four calls, deliberately not five. Changing a link's expiry or password
  //  is REVOKE AND CREATE, not an edit, because a link whose password changed
  //  under it is a link somebody still holds and believes in. Revoking says
  //  that out loud; editing hides it.
  //
  //  The exception is the named list, which is genuinely a membership and
  //  where add-and-remove is the honest verb.

  shares: (f: AuthedFetch, meetingId: string, recordingId: string) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/shares`)
      .then((r) => json<{ shares: RecordingShare[] }>(r, 'Could not load who this is shared with.')),

  share: (f: AuthedFetch, meetingId: string, recordingId: string, body: NewShare) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/shares`, {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => json<RecordingShare>(r, 'Could not share that recording.')),

  /** Ends a share for good. The row is kept so "who could see this, and when
   *  did that stop" still has an answer after an incident. */
  unshare: (f: AuthedFetch, meetingId: string, recordingId: string, shareId: string) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/shares/${shareId}`, {
      method: 'DELETE',
    }).then((r) => { if (!r.ok) throw new Error('Could not stop that share.'); }),

  /** 'named' shares only: replace the whole list of people. */
  shareWith: (f: AuthedFetch, meetingId: string, recordingId: string,
              shareId: string, userIds: string[]) =>
    f(`/connect/meetings/${meetingId}/recordings/${recordingId}/shares/${shareId}/people`, {
      method: 'PUT', body: JSON.stringify({ userIds }),
    }).then((r) => json<RecordingShare>(r, 'Could not change who this is shared with.')),

  notes: (f: AuthedFetch, meetingId: string) =>
    f(`/connect/meetings/${meetingId}/notes`)
      .then((r) => json<NotesPayload>(r, 'Could not load the notes.')),

  regenerate: (f: AuthedFetch, meetingId: string) =>
    f(`/connect/meetings/${meetingId}/notes/regenerate`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not ask for the notes again.'); }),
};

// ---------------------------------------------------------------------------
//  Minutes of meeting, and the chat that goes into them.
// ---------------------------------------------------------------------------

export interface StoredChatLine {
  displayName: string;
  isGuest: boolean;
  body: string;
  sentAt: string;
}

export const minutesApi = {
  /**
   * Keep one chat line.
   *
   * Best effort, ALWAYS. The line has already been delivered over LiveKit's
   * data channel by the time this runs — this is the copy that makes it part
   * of the record. If it fails, the meeting is unaffected and the minutes are
   * one line short; if this were allowed to throw into the send path, a
   * flapping API would break chat itself. Never awaited by the UI.
   */
  storeChat: (
    f: AuthedFetch, meetingId: string,
    line: { clientId: string; identity: string; body: string; sentAt: string },
  ) => f(`/connect/meetings/${meetingId}/chat`, {
    method: 'POST', body: JSON.stringify(line),
  }).then(() => undefined).catch(() => undefined),

  chat: (f: AuthedFetch, meetingId: string) =>
    f(`/connect/meetings/${meetingId}/chat`)
      .then((r) => json<{ lines: StoredChatLine[] }>(r, 'Could not load the chat.')),

  /**
   * Download the minutes.
   *
   * Fetched WITH the Authorization header and saved as a blob — deliberately
   * not the signed-ticket dance a recording download needs. That exists
   * because a recording is hundreds of megabytes and wants range requests
   * from a real navigation; this is a few kilobytes of HTML, and fetching it
   * keeps the whole thing inside one authorised request with no signed URL to
   * leak into a browser history.
   */
  download: async (f: AuthedFetch, meetingId: string, format: 'html' | 'txt' = 'html') => {
    const r = await f(`/connect/meetings/${meetingId}/minutes?format=${format}`);
    if (!r.ok) {
      const detail = await r.json().catch(() => null) as { error?: string } | null;
      throw new Error(detail?.error ?? 'Could not download the minutes.');
    }
    const blob = await r.blob();
    // The server names the file; the client only has to honour it.
    const name = fileNameFrom(r.headers.get('content-disposition'))
      ?? `Minutes.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoked on the next tick, not immediately: Safari has not started
    // reading the blob when click() returns, and revoking first gives a
    // download of zero bytes with no error anywhere.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  /**
   * The minutes as plain text, to be READ rather than saved.
   *
   * txt and not html, and that is a security decision rather than a taste
   * one: rendering server HTML in this page would need dangerouslySetInnerHTML,
   * which eslint forbids everywhere except the one audited file that shows
   * mail bodies. Text renders as text, so there is nothing to escape and no
   * exception to argue for. The line breaks are the document's own; CSS
   * preserves them.
   */
  read: async (f: AuthedFetch, meetingId: string): Promise<string> => {
    const r = await f(`/connect/meetings/${meetingId}/minutes?format=txt`);
    if (!r.ok) {
      const detail = await r.json().catch(() => null) as { error?: string } | null;
      throw new Error(detail?.error ?? 'Could not open the minutes.');
    }
    return r.text();
  },

  email: (f: AuthedFetch, meetingId: string) =>
    f(`/connect/meetings/${meetingId}/minutes/email`, { method: 'POST' })
      .then(async (r) => {
        const body = await r.json().catch(() => null) as
          { sent?: boolean; recipients?: number; error?: string } | null;
        if (!r.ok || body?.sent !== true) {
          throw new Error(body?.error ?? 'Could not send the minutes.');
        }
        return body.recipients ?? 0;
      }),
};

/**
 * The filename out of a Content-Disposition header.
 *
 * Prefers filename*= (RFC 5987, percent-encoded UTF-8) over plain filename=,
 * because the plain one cannot carry the em dash or a title in Hindi and the
 * server sends both forms for exactly that reason.
 */
function fileNameFrom(header: string | null): string | null {
  if (!header) return null;

  // noUncheckedIndexedAccess is on, so a capture group is string | undefined
  // even when the regex guarantees it. The compiler is right to insist: a
  // regex that matched with an empty group is exactly how this returns the
  // string "undefined" as a filename.
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star !== undefined) {
    try { return decodeURIComponent(star); } catch { /* fall through to plain */ }
  }

  return /filename="?([^";]+)"?/i.exec(header)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
//  The guest path — no session, no token, no Authorization header.
//
//  Deliberately plain fetch() rather than authedFetch: a guest has no session
//  to attach, and routing these through the authed client would trigger its
//  silent-refresh retry on the 404s this path returns by design.
// ---------------------------------------------------------------------------
async function guestJson<T>(res: Response): Promise<T> {
  // 404 is the door saying no, for every reason it might say no. It is never
  // elaborated on here, because the whole point is that the reasons are
  // indistinguishable from outside.
  if (res.status === 404) throw new DoorClosedError();
  if (res.status === 403) throw new WrongPasswordError();
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const msg = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error?: unknown }).error ?? GUEST_FAILURE)
      : GUEST_FAILURE;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const guestApi = {
  doorstep: (code: string) =>
    fetch(`${API}/connect/g/${encodeURIComponent(code)}`)
      .then((r) => guestJson<Doorstep>(r)),

  join: async (code: string, displayName: string, password?: string): Promise<JoinResult> => {
    const res = await fetch(`${API}/connect/g/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, password: password ?? null }),
    });
    const out = await guestJson<JoinResult>(res);
    if (out.status !== 'waiting') out.wsUrl = assertOrigin(out.wsUrl);
    return out;
  },

  /** Polled every couple of seconds while parked. */
  wait: async (waitToken: string): Promise<JoinResult | { status: 'denied' }> => {
    const res = await fetch(`${API}/connect/g/wait/${encodeURIComponent(waitToken)}`);
    const out = await guestJson<JoinResult | { status: 'denied' }>(res);
    if (out.status === 'admitted') out.wsUrl = assertOrigin(out.wsUrl);
    return out;
  },
};

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

/** A meeting code, grouped so it can be read aloud down a phone. */
export function prettyCode(code: string): string {
  return code.replace(/(.{4})/g, '$1 ').trim();
}

export function whenLabel(m: Meeting): string {
  if (m.status === 'active') return 'Happening now';
  if (m.status === 'ended') return m.endedAt ? `Ended ${timeLabel(m.endedAt)}` : 'Ended';
  if (m.status === 'cancelled') return 'Cancelled';
  if (!m.scheduledStart) return 'Any time';
  return timeLabel(m.scheduledStart);
}

/** Bytes as a person reads them. Binary units, because that is what the
 *  storage pool is measured in. */
export function sizeLabel(bytes: number): string {
  if (bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A duration in milliseconds as h:mm:ss / m:ss. */
export function durationLabel(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
