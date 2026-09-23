/**
 * The Connect endpoints this app needs to get into a meeting.
 *
 * Everything goes through `request` in api.js rather than calling fetch here.
 * That file's opening comment is the reason: "four hand-rolled SMTP clients
 * before anyone noticed. One door, from the start." Timeouts, error wording and
 * the cookie-omission rule have one implementation, and this is not the place
 * to grow a second.
 *
 * Contract: docs/CONNECT_API.md, "Endpoints — authenticated" and, for the
 * wait poll, "Endpoints — the guest path".
 */

import { request } from '../api';

/**
 * Meetings I created or am a participant of, soonest first, active ones first.
 * `range` is upcoming | today | past.
 */
export async function listMeetings(token, range = 'upcoming') {
  const data = await request(`/api/connect/meetings?range=${range}&pageSize=10`, {
    method: 'GET',
    token,
  });
  return data?.meetings ?? [];
}

/**
 * Create a meeting. Defaults are the API's: kind 'instant', waitingRoom
 * 'guests', allowGuests true.
 *
 * waitingRoom is left at the default deliberately. 'everyone' would park the
 * host in the lobby too, and a join that returns { status: 'waiting' } instead
 * of a token looks exactly like a broken join.
 *
 * `extra` carries the scheduling fields when there are any — kind 'scheduled',
 * scheduledStart, scheduledEnd, timezone (screens/ScheduleMeeting.js). Omitted
 * entirely for a meeting started now, so that path sends exactly the body it
 * always sent rather than a new one with nulls in it.
 *
 * An EMPTY title is dropped rather than sent as ''. The server names an
 * untitled meeting after its creator ("Priya's meeting"), which only happens if
 * the field is absent or blank — and that naming is better than anything this
 * screen could invent. Sending a blank string would reach the same place, but
 * relying on that is relying on a detail nobody promised.
 */
export async function createMeeting(token, title = 'Meeting', extra = null) {
  const trimmed = (title ?? '').trim();
  return request('/api/connect/meetings', {
    method: 'POST',
    token,
    body: {
      ...(trimmed ? { title: trimmed } : {}),
      kind: 'instant',
      ...(extra ?? {}),
    },
  });
}

/**
 * Mint a LiveKit token for a meeting.
 *
 * TWO 200s, AND THEY MEAN OPPOSITE THINGS — docs/CONNECT_API.md:
 *
 *   { status: 'joined',  token, wsUrl, identity, role }
 *   { status: 'waiting', waitToken }
 *
 * The second is a successful HTTP call that did not get you in. Reading
 * `data.token` without checking `status` yields undefined, and the LiveKit
 * connect then fails with something unrelated to the actual cause. So this
 * returns a discriminated result and never hands back a half-answer.
 *
 * Errors are thrown as ApiError with a `status`: 403 wrong or missing
 * password, 409 locked or ended, 404 not visible. The screen decides what
 * each means to the person; this function does not swallow them.
 *
 * Idempotent per person: rejoining after a drop is the same call, and it mints
 * a fresh token every time. The token's TTL is 10 minutes — a join window, not
 * a session limit.
 */
export async function joinMeeting(token, meetingId, password) {
  const data = await request(`/api/connect/meetings/${meetingId}/join`, {
    method: 'POST',
    token,
    body: password ? { password } : {},
  });

  if (data?.status === 'joined') {
    return {
      kind: 'joined',
      token: data.token,
      wsUrl: data.wsUrl,
      identity: data.identity,
      role: data.role,
    };
  }
  if (data?.status === 'waiting') {
    return {
      kind: 'waiting',
      waitToken: data.waitToken,
      message: 'You are in the waiting room. Someone has to let you in.',
    };
  }
  return {
    kind: 'unexpected',
    message: 'The server answered the join, but not with a status we know.',
    detail: JSON.stringify(data ?? null).slice(0, 200),
  };
}

// ── THE GUEST DOOR ─────────────────────────────────────────────────────────
//  Amit, 23 Sept 2026: somebody with no TatvaOS account should be able to join
//  a meeting from the app, by following the link they were sent or by typing
//  the code.
//
//  Nothing here is new on the server. The web has used this path since August
//  (apps/web/app/connect/room/[code]/page.tsx); the app simply never called
//  it. Three anonymous routes under /api/connect/g, and NO token goes to any
//  of them — `request` leaves the Authorization header off when it is given
//  none, which is the whole reason these can be written here rather than
//  around api.js.
//
//  SENDING A TOKEN WOULD BE THE BUG. These routes are AllowAnonymous and a
//  guest has nothing to send; a signed-in person who lands here should go
//  through the authenticated join instead, or they get a guest seat with no
//  host powers in their own meeting.
//
//  One failure sentence, deliberately. The server answers 404 for a code that
//  does not exist, a meeting that is cancelled, an organisation with guests
//  switched off, AND a meeting that has hit its guest ceiling — all identical,
//  so a stranger cannot probe for which meetings are real. So the app must not
//  invent a more specific reason than it was given.
// ───────────────────────────────────────────────────────────────────────────

/** The one sentence the server gives for every closed door. */
export const DOOR_CLOSED = 'This meeting link does not work.';

/**
 * What is behind a code, before anyone gives their name. Free, anonymous, and
 * it writes nothing — so it is safe to call the moment a code is typed.
 *
 * { title, state, scheduledStart, passwordRequired, locked, minutesLive, mode }
 * `state` is active | ended | not_started.
 */
export async function doorstep(code) {
  try {
    const d = await request(`/api/connect/g/${encodeURIComponent(code)}`, { method: 'GET' });
    return {
      kind: 'open',
      title: d?.title ?? '',
      state: d?.state ?? 'not_started',
      scheduledStart: d?.scheduledStart ?? null,
      passwordRequired: d?.passwordRequired === true,
      locked: d?.locked === true,
      // Guests are told when a meeting is captioned live, in the same place
      // the web tells them. Not a detail to drop on a smaller screen.
      minutesLive: d?.minutesLive === true,
      mode: d?.mode ?? 'recorded',
    };
  } catch (e) {
    if (e?.status === 404) return { kind: 'closed', message: DOOR_CLOSED };
    throw e;
  }
}

/**
 * Knock, with a name. Answers in the same two shapes the authenticated join
 * uses, so the meeting screen cannot tell the difference once it holds a seat.
 *
 * A guest identity is minted FRESH at every door (the server says so), so
 * there is nothing here worth storing to resume a seat later.
 */
export async function joinAsGuest(code, displayName, password) {
  const name = String(displayName ?? '').trim();
  // The server's own bounds, checked here so an empty name costs no round trip.
  if (name.length < 1 || name.length > 100) {
    return { kind: 'rejected', message: 'Give a name between 1 and 100 characters.' };
  }

  let data;
  try {
    data = await request(`/api/connect/g/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: password ? { displayName: name, password } : { displayName: name },
    });
  } catch (e) {
    // Each of these is a DIFFERENT answer from the server and is passed on as
    // its own sentence: a wrong password is 403 and must not read as a dead
    // link, or people retype a good code forever.
    if (e?.status === 404) return { kind: 'closed', message: DOOR_CLOSED };
    if (e?.status === 403) return { kind: 'password', message: 'That password is not right.' };
    if (e?.status === 409) return { kind: 'closed', message: e.message };
    if (e?.status === 400) return { kind: 'rejected', message: e.message };
    throw e;
  }

  if (data?.status === 'joined') {
    return {
      kind: 'joined',
      token: data.token,
      wsUrl: data.wsUrl,
      identity: data.identity,
      mode: data.mode,
      chatPolicy: data.chatPolicy,
      roomKey: data.roomKey ?? null,
      role: 'participant',       // a guest is never host; the server never says otherwise
    };
  }
  if (data?.status === 'waiting') {
    return {
      kind: 'waiting',
      waitToken: data.waitToken,
      message: 'You are in the waiting room. Someone has to let you in.',
    };
  }
  return {
    kind: 'unexpected',
    message: 'The server answered the join, but not with a status we know.',
    detail: JSON.stringify(data ?? null).slice(0, 200),
  };
}

/**
 * One poll of the waiting room. The API says every 2 seconds; the limiter
 * allows it. Answers, per docs/CONNECT_API.md:
 *
 *   { status: 'waiting' }
 *   { status: 'admitted', token, wsUrl, identity }   one-shot: the first poll
 *                                                    that collects it wins
 *   { status: 'denied' }
 *   404                                              expired (30 min) or cancelled
 *
 * 'admitted' is one-shot on the server, so the caller must USE the token it
 * gets back from this call, not poll again to be sure. Polling again gets 404.
 */
export async function pollWait(token, waitToken) {
  let data;
  try {
    data = await request(`/api/connect/g/wait/${waitToken}`, { method: 'GET', token });
  } catch (e) {
    if (e?.status === 404) {
      return { kind: 'gone', message: 'The waiting-room request expired or was cancelled.' };
    }
    throw e;
  }
  if (data?.status === 'waiting') return { kind: 'waiting' };
  if (data?.status === 'admitted') {
    return {
      kind: 'joined',
      token: data.token,
      wsUrl: data.wsUrl,
      identity: data.identity,
      role: data.role ?? 'participant',
    };
  }
  if (data?.status === 'denied') {
    return { kind: 'denied', message: 'The host did not let you in.' };
  }
  return {
    kind: 'unexpected',
    message: 'The server answered the wait poll, but not with a status we know.',
    detail: JSON.stringify(data ?? null).slice(0, 200),
  };
}

/**
 * Waiting room, host side — docs/CONNECT_API.md "Waiting room — host side".
 * Host or cohost only; the API answers 403 for anyone else, and the screen
 * uses that 403 to stop asking rather than guessing from the role.
 *
 *   GET  /meetings/{id}/lobby                 -> { waiting: [ { requestId, displayName, isGuest, requestedAt } ] }
 *   POST /meetings/{id}/lobby/{rid}/admit     -> 204
 *   POST /meetings/{id}/lobby/{rid}/deny      -> 204
 *
 * Phase 1 has no push for this; the web polls, so does the phone.
 */
export async function getLobby(token, meetingId) {
  const data = await request(`/api/connect/meetings/${meetingId}/lobby`, { method: 'GET', token });
  return data?.waiting ?? [];
}

export function admitFromLobby(token, meetingId, requestId) {
  return request(`/api/connect/meetings/${meetingId}/lobby/${requestId}/admit`, { method: 'POST', token });
}

export function denyFromLobby(token, meetingId, requestId) {
  return request(`/api/connect/meetings/${meetingId}/lobby/${requestId}/deny`, { method: 'POST', token });
}

/**
 * Invite people to a meeting by email. `emails` is whatever the person typed:
 * the server parses commas, spaces, new lines and "Name <a@b>" itself, so this
 * sends ONE string in a list, exactly as the web's new-meeting page does, and
 * there is one parser on the platform rather than two that drift.
 *
 * Answers { added, sent, failed, invalid, alreadyInvited, note, warning }.
 * A 200 is not "everybody was mailed": read `failed`, `invalid` and `note`.
 */
export function inviteToMeeting(token, meetingId, emails) {
  return request(`/api/connect/meetings/${meetingId}/invitations`, {
    method: 'POST',
    token,
    body: { emails: [emails] },
  });
}

/**
 * What somebody pastes when they were sent a meeting: the whole link, or just
 * the code at its end. Null when there is nothing usable in it, so the caller
 * can say so without asking the server about an empty string.
 *
 *   https://connect.tatvaos.com/connect/room/<22 characters>?x=1  ->  the 22 characters
 *   <22 characters>                                               ->  the same
 */
export function codeFrom(pasted) {
  const raw = String(pasted ?? '').trim();
  if (!raw) return null;
  const inLink = raw.match(/\/room\/([^/?#\s]+)/i);
  const code = (inLink ? inLink[1] : raw).trim();
  // The server's own shape (ConnectCodes.Shape): 22 characters of base64url.
  // Checked here so a mistyped code is answered at once, in plain words,
  // instead of costing a round trip that comes back as a bare 404.
  return /^[A-Za-z0-9_-]{22}$/.test(code) ? code : null;
}

/** The meeting a code belongs to. 404 when there is none, in the server's words. */
export function getMeetingByCode(token, code) {
  return request(`/api/connect/meetings/by-code/${encodeURIComponent(code)}`, { token });
}

// ── IN THE ROOM: WHAT "MORE" NEEDS ─────────────────────────────────────────
//  Amit, 23 Sept 2026: "mobile app give more option by using more option
//  able to check chat, people, recording on/off, advance setting". Every
//  route below already exists for the web room (ConnectEndpoints.cs,
//  ConnectRecordingEndpoints.cs, ConnectMinutesEndpoints.cs). Nothing new
//  on the server. Host/cohost-only routes answer 403 to anyone else, in the
//  server's own words, which the screen shows rather than second-guesses.
//
//  Chat, raised hands and reactions do NOT go through here: they are
//  LiveKit data messages between the phones (screens/Meeting.js). Only the
//  copy of a chat line kept for the minutes is a request.
// ───────────────────────────────────────────────────────────────────────────

/** Everyone the server knows in this meeting, with roles. Host/cohost only. */
export async function listParticipants(token, meetingId) {
  const d = await request(`/api/connect/meetings/${meetingId}/participants`, { method: 'GET', token });
  return Array.isArray(d?.participants) ? d.participants : [];
}

/** Mute somebody's mic, camera or screen share. kind: audio | video | screen. */
export function muteParticipant(token, meetingId, identity, kind = 'audio') {
  return request(`/api/connect/meetings/${meetingId}/participants/${encodeURIComponent(identity)}/mute`,
    { token, body: { kind } });
}

/** Remove somebody. A signed-in person is also kept from rejoining. */
export function removeParticipant(token, meetingId, identity) {
  return request(`/api/connect/meetings/${meetingId}/participants/${encodeURIComponent(identity)}`,
    { method: 'DELETE', token });
}

/** Host only. role: cohost | participant. Guests are refused by the server. */
export function setParticipantRole(token, meetingId, identity, role) {
  return request(`/api/connect/meetings/${meetingId}/participants/${encodeURIComponent(identity)}/role`,
    { method: 'PUT', token, body: { role } });
}

/** who: guests | everyone. Hosts, cohosts and the caller are never muted. */
export function muteAll(token, meetingId, who = 'everyone') {
  return request(`/api/connect/meetings/${meetingId}/mute-all`, { token, body: { who } });
}

/** End the meeting for everyone in it. Host/cohost. */
export function endMeeting(token, meetingId) {
  return request(`/api/connect/meetings/${meetingId}/end`, { token, body: {} });
}

/**
 * Recordings. `enabled` false means the organisation cannot record at all —
 * the control is hidden, not shown and refused. The live row, if any, is the
 * one whose status is starting or recording; that is what Stop needs.
 */
export async function listRecordings(token, meetingId) {
  const d = await request(`/api/connect/meetings/${meetingId}/recordings`, { method: 'GET', token });
  const items = Array.isArray(d?.items) ? d.items : [];
  const live = items.map((i) => i?.recording).find((r) => r && (r.status === 'starting' || r.status === 'recording')) ?? null;
  return { enabled: d?.enabled !== false, live };
}

/** Everyone in the room is told; it cannot be paused. mode: audio | video. */
export function startRecording(token, meetingId, mode = 'video') {
  return request(`/api/connect/meetings/${meetingId}/recordings`, { token, body: { mode, transcribe: false } });
}

export function stopRecording(token, meetingId, recordingId) {
  return request(`/api/connect/meetings/${meetingId}/recordings/${recordingId}/stop`, { token, body: {} });
}

/**
 * Advanced settings, host/cohost. Any subset of:
 *   { sharePolicy, shareMode, minutesLive, chatPolicy, waitingRoom, locked }
 * The server applies what it can and answers the meeting as it now is.
 */
export function patchMeeting(token, meetingId, patch) {
  return request(`/api/connect/meetings/${meetingId}`, { method: 'PATCH', token, body: patch });
}

/**
 * Keep a copy of a chat line for the minutes. Fire-and-forget on the web too.
 * clientId MUST be a GUID or the server refuses it; duplicates are ignored.
 */
export function storeChatLine(token, meetingId, { clientId, identity, body, sentAt }) {
  return request(`/api/connect/meetings/${meetingId}/chat`, { token, body: { clientId, identity, body, sentAt } });
}

/** A history of the chat, up to 500 lines. Anyone in the meeting may read it. */
export async function loadChat(token, meetingId) {
  const d = await request(`/api/connect/meetings/${meetingId}/chat`, { method: 'GET', token });
  return Array.isArray(d?.lines) ? d.lines : [];
}
