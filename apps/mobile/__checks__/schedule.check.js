// Scheduling a meeting from the phone: what gets sent, and the two ways a time
// can be wrong. The API is the steerable fake in mocks.js.

const { api } = require('./mocks');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const ScheduleMeeting = require('../screens/ScheduleMeeting').default;

const session = { accessToken: 'AT' };
const created = { id: 'new', title: 'Review' };

// THE CLOCK IS PINNED TO 10:00 TODAY. Found at 21:39 on 16 Sept 2026: these
// checks read the real time, and after the last slot of the evening "today"
// has no times — so four of them failed every night and passed every day, a
// check whose answer depends on when you run it. Only Date is faked; timers
// stay real so waitFor behaves exactly as it does elsewhere.
const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];

beforeEach(() => {
  api.create = jest.fn(async () => created);
  const tenAm = new Date();
  tenAm.setHours(10, 0, 0, 0);
  jest.useFakeTimers({ now: tenAm.getTime(), doNotFake: REAL_TIMERS });
});
afterEach(() => { jest.useRealTimers(); });

test('sends kind scheduled, a future start, and an end the chosen length later', async () => {
  const onCreated = jest.fn();
  const r = render(<ScheduleMeeting session={session} onCreated={onCreated} onBack={() => {}} />);

  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());

  const [token, title, extra] = api.create.mock.calls[0];
  expect(token).toBe('AT');
  expect(title).toBe('');                       // blank: the server names it after the creator
  expect(extra.kind).toBe('scheduled');

  const start = new Date(extra.scheduledStart);
  const end = new Date(extra.scheduledEnd);
  expect(start.getTime()).toBeGreaterThan(Date.now());
  expect(end.getTime() - start.getTime()).toBe(30 * 60000);   // the default length
  expect(extra.scheduledStart).toMatch(/Z$/);                  // ISO, in UTC

  expect(onCreated).toHaveBeenCalledWith(created);
});

test('the title is sent when there is one, and the length chosen changes the end', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.changeText(r.getByLabelText('Meeting title'), '  Review  ');
  fireEvent.press(r.getByLabelText('90 minutes'));
  fireEvent.press(r.getByLabelText('Schedule this meeting'));

  await waitFor(() => expect(api.create).toHaveBeenCalled());
  const [, title, extra] = api.create.mock.calls[0];
  expect(title).toBe('Review');                                // trimmed
  expect(new Date(extra.scheduledEnd) - new Date(extra.scheduledStart)).toBe(90 * 60000);
});

test('a time that passes while the screen is open is refused, not sent', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);

  // The screen was left open for two days. The slot it is holding is in the
  // past now, and the server would accept it without complaint.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 86400000;
  try {
    fireEvent.press(r.getByLabelText('Schedule this meeting'));
    await waitFor(() => expect(r.getByText(/That time has passed/)).toBeTruthy());
    expect(api.create).not.toHaveBeenCalled();
  } finally {
    Date.now = realNow;
  }
});

test('the server’s own sentence is shown when it refuses, and nothing is handed back', async () => {
  const onCreated = jest.fn();
  api.create = jest.fn(async () => { const e = new Error('That title is too long.'); e.status = 400; throw e; });
  const r = render(<ScheduleMeeting session={session} onCreated={onCreated} onBack={() => {}} />);

  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(r.getByText('That title is too long.')).toBeTruthy());
  expect(onCreated).not.toHaveBeenCalled();
});

test('late at night the screen opens on tomorrow morning, ready to schedule', async () => {
  const at2330 = new Date();
  at2330.setHours(23, 30, 0, 0);
  jest.useFakeTimers({ now: at2330.getTime(), doNotFake: REAL_TIMERS });
  try {
    const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
    // Not 11.30 tonight and not midnight: a time somebody would actually pick.
    expect(r.getByText('Tomorrow, 9:00 am · 30 minutes')).toBeTruthy();
    expect(r.queryByText(/already passed/)).toBeNull();
    fireEvent.press(r.getByLabelText('Schedule this meeting'));
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    const start = new Date(api.create.mock.calls[0][2].scheduledStart);
    expect(start.getHours()).toBe(9);
    expect(start.getDate()).toBe(new Date(at2330.getTime() + 86400000).getDate());
  } finally {
    jest.useRealTimers();
  }
});

// ── date and time are SELECTED, not read off a list (Amit, 19 Sept 2026) ────

test('at ten in the morning it opens on today at 10:30 — the next half hour, ten minutes clear', () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  expect(r.getByText('Today, 10:30 am · 30 minutes')).toBeTruthy();
  expect(r.getByLabelText('Time').props.accessibilityValue).toEqual({ text: '10:30 am' });
  expect(r.getByLabelText('Date').props.accessibilityValue.text).toMatch(/^Today · /);
});

test('the time sheet sets any five minutes of the day, and only on Done', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Time'));
  fireEvent.press(r.getByLabelText('Hour 4'));
  fireEvent.press(r.getByLabelText('Minute 15'));
  fireEvent.press(r.getByLabelText('PM'));
  // Chosen in the sheet, not yet in the field: closing without Done must change nothing.
  expect(r.getByText('Today, 10:30 am · 30 minutes')).toBeTruthy();
  fireEvent.press(r.getByLabelText('Use this time'));
  expect(r.getByText('Today, 4:15 pm · 30 minutes')).toBeTruthy();

  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  const start = new Date(api.create.mock.calls[0][2].scheduledStart);
  expect([start.getHours(), start.getMinutes()]).toEqual([16, 15]);
});

test('12 am is midnight and 12 pm is noon — the hour everybody gets wrong', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Time'));
  fireEvent.press(r.getByLabelText('Hour 12'));
  fireEvent.press(r.getByLabelText('Minute 00'));
  fireEvent.press(r.getByLabelText('PM'));
  fireEvent.press(r.getByLabelText('Use this time'));
  expect(r.getByText('Today, 12:00 pm · 30 minutes')).toBeTruthy();
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(new Date(api.create.mock.calls[0][2].scheduledStart).getHours()).toBe(12);
});

test('the calendar reaches next month, and the day picked is the day sent', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  const target = new Date(); target.setDate(1); target.setMonth(target.getMonth() + 1); target.setDate(12);
  const label = target.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  fireEvent.press(r.getByLabelText('Date'));
  fireEvent.press(r.getByLabelText('Next month'));
  fireEvent.press(r.getByLabelText(label));

  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  const start = new Date(api.create.mock.calls[0][2].scheduledStart);
  expect([start.getFullYear(), start.getMonth(), start.getDate()])
    .toEqual([target.getFullYear(), target.getMonth(), target.getDate()]);
  expect([start.getHours(), start.getMinutes()]).toEqual([10, 30]); // the time was not disturbed
});

test('yesterday cannot be picked, and the calendar does not go back past this month', () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Date'));
  expect(r.getByLabelText('Previous month')).toBeDisabled();
  const y = new Date(); y.setDate(y.getDate() - 1);
  // On the 1st, yesterday is in a month the calendar will not show at all.
  if (y.getMonth() === new Date().getMonth()) {
    const label = y.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    expect(r.getByLabelText(label)).toBeDisabled();
  }
});

test('a time earlier today is said to have passed at once, and refused if pressed anyway', async () => {
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Time'));
  fireEvent.press(r.getByLabelText('Hour 8'));
  fireEvent.press(r.getByLabelText('AM'));
  fireEvent.press(r.getByLabelText('Use this time'));
  expect(r.getByText(/already passed today/)).toBeTruthy();

  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(r.getByText(/That time has passed/)).toBeTruthy());
  expect(api.create).not.toHaveBeenCalled();
});
