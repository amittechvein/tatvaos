// Dashboard next-meeting card: which meeting, Join, and the four states told
// apart. The API is the steerable fake in mocks.js; see README.md for what a
// render check here can and cannot prove.

const { api } = require('./mocks');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const NextMeetingCard = require('../components/NextMeetingCard').default;
const session = { accessToken: 'AT' };

const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
const stale = { id: 'stale', title: 'Missed review', status: 'scheduled', scheduledStart: at(-60) };
const live = { id: 'live', title: 'Standup', status: 'active', scheduledStart: null, startedAt: at(-5) };

test('shows the live meeting, not the stale one the server sorts above it, and Join hands it over', async () => {
  api.list = jest.fn(async () => [stale, live]);
  const onJoin = jest.fn();
  const r = render(<NextMeetingCard session={session} onJoin={onJoin} onOpenConnect={() => {}} />);
  await waitFor(() => expect(r.getByText('Standup')).toBeTruthy());
  expect(r.getByText('LIVE NOW')).toBeTruthy();
  expect(r.getByText('Happening now')).toBeTruthy();
  expect(r.queryByText('Missed review')).toBeNull();
  fireEvent.press(r.getByLabelText('Join Standup'));
  expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ id: 'live' }));
  expect(api.list).toHaveBeenCalledWith('AT', 'upcoming');
});

test('while the first answer is out, it says it is checking', () => {
  api.list = jest.fn(() => new Promise(() => {}));
  const r = render(<NextMeetingCard session={session} onJoin={() => {}} onOpenConnect={() => {}} />);
  expect(r.getByText(/Checking your meetings/)).toBeTruthy();
});

test('nothing coming up and could-not-check are different sentences', async () => {
  api.list = jest.fn(async () => []);
  const onOpenConnect = jest.fn();
  const r = render(<NextMeetingCard session={session} onJoin={() => {}} onOpenConnect={onOpenConnect} />);
  await waitFor(() => expect(r.getByText(/No meetings coming up/)).toBeTruthy());
  expect(r.queryByText(/Could not check/)).toBeNull();
  fireEvent.press(r.getByLabelText('Open Connect'));
  expect(onOpenConnect).toHaveBeenCalledTimes(1);

  api.list = jest.fn(async () => { throw new Error('boom'); });
  const r2 = render(<NextMeetingCard session={session} onJoin={() => {}} onOpenConnect={() => {}} />);
  await waitFor(() => expect(r2.getByText(/Could not check your meetings/)).toBeTruthy());
  expect(r2.queryByText(/No meetings coming up/)).toBeNull();
});

test('Try again really asks again, and the card recovers', async () => {
  api.list = jest.fn(async () => { throw new Error('boom'); });
  const r = render(<NextMeetingCard session={session} onJoin={() => {}} onOpenConnect={() => {}} />);
  await waitFor(() => expect(r.getByText(/Could not check your meetings/)).toBeTruthy());
  api.list = jest.fn(async () => [live]);
  fireEvent.press(r.getByLabelText('Try again'));
  await waitFor(() => expect(r.getByText('Standup')).toBeTruthy());
  expect(api.list).toHaveBeenCalledTimes(1);
});
