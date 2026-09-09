/**
 * The Connect endpoints this app needs to get into a meeting.
 *
 * Everything goes through `request` in api.js rather than calling fetch here.
 * That file's opening comment is the reason: "four hand-rolled SMTP clients
 * before anyone noticed. One door, from the start." Timeouts, error wording and
 * the cookie-omission rule have one implementation, and this is not the place
 * to grow a second.
 *
 * Contract: docs/CONNECT_API.md, "Endpoints — authenticated".
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
 */
export async function createMeeting(token, title = 'Meeting') {
  return request('/api/connect/meetings', {
    method: 'POST',
    token,
    body: { title, kind: 'instant' },
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
