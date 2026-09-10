// Meeting screen: one check per answer the API or SDK can give. README.md
// says what these prove and what only a phone can.

const { steer, api, room } = require('./mocks');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');
const Meeting = require('../screens/Meeting').default;

const session = { accessToken: 'AT' };
const meeting = { id: 'm1', title: 'Standup' };
const joined = { kind: 'joined', token: 'LK', wsUrl: 'wss://x', identity: 'user:me', role: 'participant' };

beforeEach(() => { steer.share = 'started'; steer.mic = 'ok'; api.wait = null; jest.useRealTimers(); });

test('direct join: connects with the minted token, mic on, speaker selected', async () => {
  api.join = jest.fn(async () => joined);
  const onLeave = jest.fn();
  const r = render(<Meeting session={session} meeting={meeting} onLeave={onLeave} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  expect(room().connectCalls).toEqual([{ url: 'wss://x', token: 'LK' }]);
  expect(api.join).toHaveBeenCalledWith('AT', 'm1', undefined);
  expect(r.getByLabelText('Mute')).toBeTruthy(); // mic is ON, so the button offers Mute
  const { AudioSession } = require('@livekit/react-native');
  expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith('speaker');
});

test('waiting room: polls, then enters with the token the POLL returned (one-shot)', async () => {
  api.join = jest.fn(async () => ({ kind: 'waiting', waitToken: 'W', message: 'You are in the waiting room. Someone has to let you in.' }));
  let polls = 0;
  api.wait = jest.fn(async () => (++polls < 2 ? { kind: 'waiting' } : { ...joined, token: 'LK-FROM-POLL' }));
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('In the waiting room')).toBeTruthy());
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy(), { timeout: 6000 });
  expect(api.wait).toHaveBeenCalledWith('AT', 'W');
  expect(room().connectCalls).toEqual([{ url: 'wss://x', token: 'LK-FROM-POLL' }]);
}, 10000);

test('waiting room: denied is terminal and named', async () => {
  api.join = jest.fn(async () => ({ kind: 'waiting', waitToken: 'W', message: 'wait' }));
  api.wait = jest.fn(async () => ({ kind: 'denied', message: 'The host did not let you in.' }));
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getAllByText('The host did not let you in.').length).toBeGreaterThan(0), { timeout: 6000 });
  expect(room().connectCalls).toEqual([]);
}, 10000);

test('password: 403 asks, retry sends it, then connects', async () => {
  const err = Object.assign(new Error('Password required'), { status: 403 });
  api.join = jest.fn(async (t, id, pw) => { if (pw === 'hunter2') return joined; throw err; });
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Password needed')).toBeTruthy());
  expect(room().connectCalls).toEqual([]);
  fireEvent.changeText(r.getByLabelText('Meeting password'), 'wrong');
  fireEvent.press(r.getByText('Join'));
  await waitFor(() => expect(r.getByText('That password was not accepted.')).toBeTruthy());
  fireEvent.changeText(r.getByLabelText('Meeting password'), 'hunter2');
  fireEvent.press(r.getByText('Join'));
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  expect(api.join).toHaveBeenLastCalledWith('AT', 'm1', 'hunter2');
});

test('409 locked: the server sentence is shown, nothing connects', async () => {
  api.join = jest.fn(async () => { throw Object.assign(new Error('This meeting is locked.'), { status: 409 }); });
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getAllByText('Could not join: This meeting is locked.').length).toBeGreaterThan(0));
  expect(room().connectCalls).toEqual([]);
});

async function inCall() {
  api.join = jest.fn(async () => joined);
  const onLeave = jest.fn();
  const r = render(<Meeting session={session} meeting={meeting} onLeave={onLeave} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  return { r, onLeave };
}

test('share: consent given -> Stop share', async () => {
  const { r } = await inCall();
  fireEvent.press(r.getByLabelText('Share'));
  await waitFor(() => expect(r.getByLabelText('Stop share')).toBeTruthy());
});

test('share: refusal that THROWS with the inverted shape -> REFUSED, not SHARING', async () => {
  steer.share = 'throw-refusal';
  const { r } = await inCall();
  fireEvent.press(r.getByLabelText('Share'));
  await waitFor(() => expect(r.getByText('Screen sharing needs your permission. Nothing was shared.')).toBeTruthy());
  expect(r.queryByLabelText('Stop share')).toBeNull();
});

test('share: refusal that RESOLVES undefined -> REFUSED, not SHARING', async () => {
  steer.share = 'undefined';
  const { r } = await inCall();
  fireEvent.press(r.getByLabelText('Share'));
  await waitFor(() => expect(r.getByText('Screen sharing needs your permission. Nothing was shared.')).toBeTruthy());
  expect(r.queryByLabelText('Stop share')).toBeNull();
});

test('share: a non-refusal failure is reported as a failure, not a refusal', async () => {
  steer.share = 'throw-other';
  const { r } = await inCall();
  fireEvent.press(r.getByLabelText('Share'));
  await waitFor(() => expect(r.getByText('Screen sharing could not start. Nothing was shared.')).toBeTruthy());
});

test('share revoked by the OS (LocalTrackUnpublished) -> button drops back to Share', async () => {
  const { r } = await inCall();
  fireEvent.press(r.getByLabelText('Share'));
  await waitFor(() => expect(r.getByLabelText('Stop share')).toBeTruthy());
  act(() => room().emit('localTrackUnpublished', { source: 'screen_share' }));
  await waitFor(() => expect(r.getByLabelText('Share')).toBeTruthy());
  expect(r.getByText('Screen sharing stopped.')).toBeTruthy();
});

test('mic refused at join: in the call, muted, told why', async () => {
  steer.mic = 'refuse';
  const { r } = await inCall();
  expect(r.getByLabelText('Unmute')).toBeTruthy();
  expect(r.getByText('Your microphone is off: the app was not given permission.')).toBeTruthy();
});

test('leave: disconnects and hands control back once', async () => {
  const { r, onLeave } = await inCall();
  fireEvent.press(r.getByLabelText('Leave'));
  await waitFor(() => expect(onLeave).toHaveBeenCalledTimes(1));
});

test('server-side disconnect while in the call is shown by name', async () => {
  const { r } = await inCall();
  act(() => room().emit('disconnected', 2));
  await waitFor(() => expect(r.getByText('Disconnected')).toBeTruthy());
  expect(r.getByText('Disconnected: DUPLICATE_IDENTITY (2)')).toBeTruthy();
});

test('asks Android for microphone, camera and notifications BEFORE the first join call', async () => {
  const { perms } = require('./mocks');
  perms.asked.length = 0;
  const order = [];
  api.join = jest.fn(async () => { order.push('join'); return joined; });
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  expect(perms.asked).toEqual(expect.arrayContaining([
    'android.permission.RECORD_AUDIO', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS',
  ]));
  expect(order).toEqual(['join']);
});

const hostJoined = { ...joined, role: 'host' };

test('host: a waiting guest is shown, Admit calls the API with the request id, the row goes', async () => {
  api.join = jest.fn(async () => hostJoined);
  api.lobby = jest.fn(async () => [{ requestId: 'r1', displayName: 'Ravi', isGuest: true, requestedAt: 'now' }]);
  api.admit = jest.fn(async () => null);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Ravi (guest)')).toBeTruthy());
  expect(api.lobby).toHaveBeenCalledWith('AT', 'm1');
  fireEvent.press(r.getByLabelText('Admit Ravi'));
  await waitFor(() => expect(api.admit).toHaveBeenCalledWith('AT', 'm1', 'r1'));
  await waitFor(() => expect(r.queryByText('Ravi (guest)')).toBeNull());
});

test('host: Deny calls the deny endpoint, not admit', async () => {
  api.join = jest.fn(async () => hostJoined);
  api.lobby = jest.fn(async () => [{ requestId: 'r2', displayName: 'Vendor', isGuest: true }]);
  api.admit = jest.fn(async () => null);
  api.deny = jest.fn(async () => null);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Vendor (guest)')).toBeTruthy());
  fireEvent.press(r.getByLabelText('Turn away Vendor'));
  await waitFor(() => expect(api.deny).toHaveBeenCalledWith('AT', 'm1', 'r2'));
  expect(api.admit).not.toHaveBeenCalled();
});

test('participant: the lobby is never asked for', async () => {
  api.join = jest.fn(async () => joined); // role: participant
  api.lobby = jest.fn(async () => []);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  await new Promise((res) => setTimeout(res, 300));
  expect(api.lobby).not.toHaveBeenCalled();
});

test('host: a 403 from the lobby stops the polling instead of retrying forever', async () => {
  api.join = jest.fn(async () => hostJoined);
  api.lobby = jest.fn(async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); });
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  await waitFor(() => expect(api.lobby).toHaveBeenCalledTimes(1));
  await new Promise((res) => setTimeout(res, 3500));
  expect(api.lobby).toHaveBeenCalledTimes(1);
}, 10000);

test('invite: hands the meeting joinUrl to the share sheet', async () => {
  const { Share } = require('react-native');
  const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  api.join = jest.fn(async () => joined);
  const withLink = { ...meeting, joinUrl: 'https://connect.tatvaos.com/connect/room/abc' };
  const r = render(<Meeting session={session} meeting={withLink} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  fireEvent.press(r.getByLabelText('Invite'));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  expect(spy.mock.calls[0][0].message).toContain('https://connect.tatvaos.com/connect/room/abc');
  spy.mockRestore();
});

test('invite: no joinUrl, no button', async () => {
  api.join = jest.fn(async () => joined);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  expect(r.queryByLabelText('Invite')).toBeNull();
});
