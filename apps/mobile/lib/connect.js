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
