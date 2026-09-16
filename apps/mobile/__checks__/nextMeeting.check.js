// Which meeting the dashboard card shows. See lib/nextMeeting.js for why the
// phone chooses rather than taking the first row the server returns.

const { pickNextMeeting, describeWhen } = require('../lib/nextMeeting');

const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();

test('a live meeting beats an earlier scheduled one nobody opened — the server-order trap', () => {
  // The exact order ListMeetingsAsync produces today: sorted by start time only,
  // so the stale scheduled meeting comes first and the live instant one second.
  const list = [
    { id: 'stale', title: 'Missed review', status: 'scheduled', scheduledStart: at(-60) },
    { id: 'live', title: 'Standup', status: 'active', scheduledStart: null, startedAt: at(-5), createdAt: at(-6) },
  ];
  expect(pickNextMeeting(list)?.id).toBe('live');
});

test('with nothing live, the soonest scheduled meeting — whatever order it arrives in', () => {
  const list = [
    { id: 'later', status: 'scheduled', scheduledStart: at(180) },
    { id: 'soon', status: 'scheduled', scheduledStart: at(20) },
    { id: 'tomorrow', status: 'scheduled', scheduledStart: at(1440) },
  ];
  expect(pickNextMeeting(list)?.id).toBe('soon');
});

test('of two live meetings, the one that started first', () => {
  const list = [
    { id: 'second', status: 'active', startedAt: at(-2) },
    { id: 'first', status: 'active', startedAt: at(-30) },
  ];
  expect(pickNextMeeting(list)?.id).toBe('first');
});

test('an instant meeting that is not live gets no card', () => {
  expect(pickNextMeeting([{ id: 'made-earlier', status: 'scheduled', scheduledStart: null, createdAt: at(-40) }])).toBeNull();
});

test('ended, cancelled and unreadable times are never chosen', () => {
  const list = [
    { id: 'ended', status: 'ended', scheduledStart: at(10) },
    { id: 'cancelled', status: 'cancelled', scheduledStart: at(15) },
    { id: 'garbled', status: 'scheduled', scheduledStart: 'not a date' },
  ];
  expect(pickNextMeeting(list)).toBeNull();
});

test('no list at all is no card, not a crash', () => {
  expect(pickNextMeeting(undefined)).toBeNull();
  expect(pickNextMeeting(null)).toBeNull();
  expect(pickNextMeeting([])).toBeNull();
});

// describeWhen — the card and the Connect list share it.

test('live and instant meetings are described, not dated', () => {
  expect(describeWhen({ status: 'active', scheduledStart: at(-30) })).toBe('Happening now');
  expect(describeWhen({ status: 'scheduled', scheduledStart: null })).toBe('Instant meeting');
  expect(describeWhen({ status: 'scheduled', scheduledStart: 'not a date' })).toBe('');
});

test('today and tomorrow are calendar days, not the next 24 hours', () => {
  // 11 pm. A meeting at 11:45 tonight is today; one at 12:15 is tomorrow even
  // though it is under an hour away. A "within 24 hours" shortcut gets the
  // second one wrong, and at that hour the difference is the whole point.
  const now = new Date(2026, 8, 15, 23, 0);
  const tonight = new Date(2026, 8, 15, 23, 45).toISOString();
  const pastMidnight = new Date(2026, 8, 16, 0, 15).toISOString();
  const nextWeek = new Date(2026, 8, 22, 9, 0).toISOString();
  expect(describeWhen({ status: 'scheduled', scheduledStart: tonight }, now)).toMatch(/^Today, /);
  expect(describeWhen({ status: 'scheduled', scheduledStart: pastMidnight }, now)).toMatch(/^Tomorrow, /);
  const later = describeWhen({ status: 'scheduled', scheduledStart: nextWeek }, now);
  expect(later).not.toMatch(/^(Today|Tomorrow)/);
  expect(later).not.toBe('');
});
