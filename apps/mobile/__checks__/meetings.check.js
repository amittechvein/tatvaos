// Meetings list: load, empty vs failed, start-now, join.

const { api } = require('./mocks');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const Meetings = require('../screens/Meetings').default;
const session = { accessToken: 'AT' };

test('lists meetings and joins the one tapped', async () => {
  api.list = jest.fn(async () => [{ id: 'a', title: 'Standup', status: 'active' }, { id: 'b', title: 'Review', scheduledStart: '2026-09-10T09:00:00Z' }]);
  const onJoin = jest.fn();
  const r = render(<Meetings session={session} onJoin={onJoin} onBack={() => {}} />);
  await waitFor(() => expect(r.getByText('Standup')).toBeTruthy());
  expect(r.getByText('Happening now')).toBeTruthy();
  fireEvent.press(r.getByLabelText('Join Review'));
  expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
});

test('empty list and failed load are told apart', async () => {
  api.list = jest.fn(async () => []);
  const r = render(<Meetings session={session} onJoin={() => {}} onBack={() => {}} />);
  await waitFor(() => expect(r.getByText(/Nothing scheduled/)).toBeTruthy());
  expect(r.queryByText(/Could not load/)).toBeNull();

  api.list = jest.fn(async () => { throw new Error('boom'); });
  const r2 = render(<Meetings session={session} onJoin={() => {}} onBack={() => {}} />);
  await waitFor(() => expect(r2.getByText(/Could not load your meetings/)).toBeTruthy());
});

test('start now creates and joins', async () => {
  api.list = jest.fn(async () => []);
  api.create = jest.fn(async () => ({ id: 'new', title: 'Meeting' }));
  const onJoin = jest.fn();
  const r = render(<Meetings session={session} onJoin={onJoin} onBack={() => {}} />);
  await waitFor(() => expect(r.getByText(/Nothing scheduled/)).toBeTruthy());
  fireEvent.press(r.getByLabelText('Start a meeting now'));
  await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' })));
  expect(api.create).toHaveBeenCalledWith('AT', 'Meeting');
});
