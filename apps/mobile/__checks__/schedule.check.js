// Scheduling a meeting from the phone: what gets sent, and the two ways a time
// can be wrong. The API is the steerable fake in mocks.js.

const { api } = require('./mocks');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const ScheduleMeeting = require('../screens/ScheduleMeeting').default;

const session = { accessToken: 'AT' };
const created = { id: 'new', title: 'Review' };

beforeEach(() => { api.create = jest.fn(async () => created); });

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

test('late at night, today offers nothing and says so instead of rendering a gap', () => {
  const at2330 = new Date();
  at2330.setHours(23, 30, 0, 0);
  jest.useFakeTimers({ now: at2330.getTime(), doNotFake: ['performance'] });
  try {
    const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
    expect(r.getByText(/No times left today/)).toBeTruthy();
    // Tomorrow is still offered, which is the point of saying so.
    expect(r.getByLabelText('Tomorrow')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
