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

export type MeetingStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';
export type WaitingRoom = 'off' | 'guests' | 'everyone';
export type MeetingRole = 'host' | 'cohost' | 'participant';

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

/** A seat: everything needed to open a LiveKit connection. */
export interface Seat {
  status: 'joined' | 'admitted';
  token: string;
  wsUrl: string;
  identity: string;
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
  scheduledStart: string | null;
  state: 'active' | 'ended' | 'not_started';
  passwordRequired: boolean;
  locked: boolean;
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
}

export type UpdateMeeting = Partial<CreateMeeting & { locked: boolean }>;

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

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const msg = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error?: unknown }).error ?? fallback)
      : fallback;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
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
  mute: (f: AuthedFetch, id: string, identity: string, kind: 'audio' | 'video' = 'audio') =>
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

  end: (f: AuthedFetch, id: string) =>
    f(`/connect/meetings/${id}/end`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Could not end the meeting.'); }),
};

// ---------------------------------------------------------------------------
//  The guest path — no session, no token, no Authorization header.
//
//  Deliberately plain fetch() rather than authedFetch: a guest has no session
//  to attach, and routing these through the authed client would trigger its
//  silent-refresh retry on the 404s this path returns by design.
// ---------------------------------------------------------------------------
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

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
