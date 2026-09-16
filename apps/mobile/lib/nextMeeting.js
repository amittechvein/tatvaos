/**
 * Which meeting the dashboard's "next meeting" card shows.
 *
 * CHOSEN HERE, NOT TAKEN FROM THE TOP OF THE LIST, AND THAT IS DELIBERATE.
 *
 * docs/CONNECT_API.md says `range=upcoming` "includes active meetings first",
 * and the comment inside ListMeetingsAsync (apps/api/Modules/Connect/Endpoints/
 * ConnectEndpoints.cs) says "Live meetings first". The query under both does
 * not: it orders by `ScheduledStart ?? CreatedAt` and nothing else. Read
 * 15 Sept 2026 against 3aa25bd. So a scheduled meeting nobody opened, due an
 * hour ago and still inside the server's grace window, sorts ABOVE an instant
 * meeting that is live right now. Taking row 0 would put the dead meeting on
 * the card and hide the live one — no error, no log, just the wrong meeting.
 *
 * If the server is ever fixed, this still gives the same answer; it does not
 * depend on the order it is handed.
 *
 * Rules, in order:
 *   1. A live meeting (status 'active') wins. If there are several, the one
 *      that started first.
 *   2. Otherwise the soonest scheduled meeting. The server has already decided
 *      how late a meeting may be and still count as upcoming; the phone does
 *      not keep a second copy of that window.
 *   3. An instant meeting that is not live does not get the card. It has no
 *      time to show, and "a meeting you made earlier that nobody joined" is not
 *      what someone opens the app for. It stays in Connect's own list.
 *
 * Pure, so __checks__/nextMeeting.check.js can drive every branch without a
 * phone or a server.
 */
export function pickNextMeeting(meetings) {
  if (!Array.isArray(meetings)) return null;

  const time = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? null : t;
  };
  const began = (m) => time(m.startedAt) ?? time(m.scheduledStart) ?? time(m.createdAt) ?? 0;

  const live = meetings
    .filter((m) => m?.status === 'active')
    .sort((a, b) => began(a) - began(b));
  if (live.length) return live[0];

  const scheduled = meetings
    .filter((m) => m?.status === 'scheduled' && time(m.scheduledStart) !== null)
    .sort((a, b) => time(a.scheduledStart) - time(b.scheduledStart));
  return scheduled[0] ?? null;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * When a meeting is, in words — for the dashboard card AND the Connect list.
 *
 * One implementation for both (house rule 10). Until 15 Sept 2026 this lived
 * inside screens/Meetings.js as `when()`; the card needed the same sentence,
 * and two copies of "Happening now" would drift the first time either changed.
 *
 * Device-local time, like the rest of the app. `now` is a parameter so the
 * checks can pin "today" and "tomorrow" without mocking the clock.
 */
export function describeWhen(m, now = new Date()) {
  if (m?.status === 'active') return 'Happening now';
  if (!m?.scheduledStart) return 'Instant meeting';
  const d = new Date(m.scheduledStart);
  if (Number.isNaN(d.getTime())) return '';

  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}
