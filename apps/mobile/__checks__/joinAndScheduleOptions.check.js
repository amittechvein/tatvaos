// What Amit asked for on his own phone on 19 Sept 2026, held to it:
//   - joining asks first (microphone, camera, loudspeaker) and OBEYS the answer
//   - scheduling offers every setting the web does, and can invite by email
//   - a pasted link or code gets you into somebody else's meeting
//   - a meeting code never reaches the log
// Each check below names the thing that would have to be true for it to fail.

const { steer, api, room } = require('./mocks');
const React = require('react');
const { Alert } = require('react-native');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const Meeting = require('../screens/Meeting').default;
const Meetings = require('../screens/Meetings').default;
const ScheduleMeeting = require('../screens/ScheduleMeeting').default;
const { codeFrom } = jest.requireActual('../lib/connect');
const { loggable } = jest.requireActual('../api');

const session = { accessToken: 'AT' };
const meeting = { id: 'm1', title: 'Standup', status: 'active' };
const joined = { kind: 'joined', token: 'LK', wsUrl: 'wss://x', identity: 'user:me', role: 'participant' };
const CODE = 'AbCdEfGhIjKlMnOpQrSt-_'; // 22 characters, the server's shape

beforeEach(() => { steer.share = 'started'; steer.mic = 'ok'; api.wait = null; jest.useRealTimers(); });

// ── pre-join ───────────────────────────────────────────────────────────────

test('opening a meeting ASKS first: nothing is joined until Join now is pressed', async () => {
  api.join = jest.fn(async () => joined);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);

  expect(r.getByText('Standup')).toBeTruthy();
  expect(r.getByLabelText('Microphone')).toBeTruthy();
  expect(r.getByLabelText('Camera')).toBeTruthy();
  expect(r.getByLabelText('Loudspeaker')).toBeTruthy();
  // The failure this guards: a pre-join screen drawn OVER a join already under way.
  await new Promise((res) => setTimeout(res, 50));
  expect(api.join).not.toHaveBeenCalled();

  fireEvent.press(r.getByLabelText('Join now'));
  await waitFor(() => expect(api.join).toHaveBeenCalledWith('AT', 'm1', undefined));
});

test('the default is MUTED with the camera off, and the room is told nothing else', async () => {
  api.join = jest.fn(async () => joined);
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  fireEvent.press(r.getByLabelText('Join now'));
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());

  const me = room().localParticipant;
  const mic = jest.spyOn(me, 'setMicrophoneEnabled');
  const cam = jest.spyOn(me, 'setCameraEnabled');
  await new Promise((res) => setTimeout(res, 50));
  expect(mic).not.toHaveBeenCalled();
  expect(cam).not.toHaveBeenCalled();
  // Muted, so the button offers to UNmute. 'Mute' here would mean a hot mic.
  expect(r.queryByLabelText('Mute')).toBeNull();
});

test('choosing microphone and camera on joins with both on', async () => {
  api.join = jest.fn(async () => joined);
  const calls = [];
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  fireEvent.press(r.getByLabelText('Microphone'));
  fireEvent.press(r.getByLabelText('Camera'));

  // The Room is made when the session mounts, so the spy goes on the prototype.
  const proto = Object.getPrototypeOf(new (require('livekit-client').Room)().localParticipant);
  const mic = jest.spyOn(proto, 'setMicrophoneEnabled').mockImplementation(async (on) => { calls.push(['mic', on]); return on; });
  const cam = jest.spyOn(proto, 'setCameraEnabled').mockImplementation(async (on) => { calls.push(['cam', on]); return on; });
  try {
    fireEvent.press(r.getByLabelText('Join now'));
    await waitFor(() => expect(calls).toEqual([['mic', true], ['cam', true]]));
    await waitFor(() => expect(r.getByLabelText('Mute')).toBeTruthy());
  } finally { mic.mockRestore(); cam.mockRestore(); }
});

test('choosing the earpiece selects the earpiece, not the loudspeaker', async () => {
  api.join = jest.fn(async () => joined);
  const { AudioSession } = require('@livekit/react-native');
  AudioSession.selectAudioOutput.mockClear?.();
  const r = render(<Meeting session={session} meeting={meeting} onLeave={() => {}} />);
  fireEvent.press(r.getByLabelText('Loudspeaker'));
  fireEvent.press(r.getByLabelText('Join now'));
  await waitFor(() => expect(r.getByText('Only you so far')).toBeTruthy());
  await waitFor(() => expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith('earpiece'));
  expect(AudioSession.selectAudioOutput).not.toHaveBeenCalledWith('speaker');
});

test('Back on the pre-join screen leaves without ever joining', () => {
  api.join = jest.fn(async () => joined);
  const onLeave = jest.fn();
  const r = render(<Meeting session={session} meeting={meeting} onLeave={onLeave} />);
  fireEvent.press(r.getByLabelText('Back'));
  expect(onLeave).toHaveBeenCalled();
  expect(api.join).not.toHaveBeenCalled();
});

// ── scheduling ─────────────────────────────────────────────────────────────

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
function pinTenAm() {
  const tenAm = new Date(); tenAm.setHours(10, 0, 0, 0);
  jest.useFakeTimers({ now: tenAm.getTime(), doNotFake: REAL_TIMERS });
}

test('untouched, scheduling sends the web form’s defaults — every setting, not none', async () => {
  pinTenAm();
  api.create = jest.fn(async () => ({ id: 'new' }));
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][2]).toMatchObject({
    kind: 'scheduled', mode: 'recorded', waitingRoom: 'guests', allowGuests: true,
    chatPolicy: 'everyone', sharePolicy: 'everyone', shareMode: 'multiple',
    autoRecord: false, password: null,
  });
});

test('every option chosen is the option sent', async () => {
  pinTenAm();
  api.create = jest.fn(async () => ({ id: 'new' }));
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Meeting options'));
  fireEvent.press(r.getByLabelText('Waiting room: Everyone waits'));
  fireEvent.press(r.getByLabelText('Who can get in: Colleagues only'));
  fireEvent.press(r.getByLabelText('Who can send chat messages: Nobody'));
  fireEvent.press(r.getByLabelText('Who can share their screen: Host only'));
  fireEvent.press(r.getByLabelText('Screens at once: One at a time'));
  fireEvent.press(r.getByLabelText('Recording: Start it automatically'));
  fireEvent.changeText(r.getByLabelText('Meeting password'), 'open-sesame');
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][2]).toMatchObject({
    waitingRoom: 'everyone', allowGuests: false, chatPolicy: 'off', sharePolicy: 'host',
    shareMode: 'single', autoRecord: true, password: 'open-sesame',
  });
});

test('a private meeting never asks to auto-record, even if that was ticked first', async () => {
  pinTenAm();
  api.create = jest.fn(async () => ({ id: 'new' }));
  const r = render(<ScheduleMeeting session={session} onCreated={() => {}} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Meeting options'));
  fireEvent.press(r.getByLabelText('Recording: Start it automatically'));
  fireEvent.press(r.getByLabelText('Meeting type: Private'));
  expect(r.queryByLabelText('Recording: Start it automatically')).toBeNull(); // the question goes away
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(api.create).toHaveBeenCalled());
  expect(api.create.mock.calls[0][2]).toMatchObject({ mode: 'private', autoRecord: false });
});

test('invitations go AFTER the meeting exists, as typed, to that meeting', async () => {
  pinTenAm();
  const order = [];
  api.create = jest.fn(async () => { order.push('create'); return { id: 'new' }; });
  api.invite = jest.fn(async () => { order.push('invite'); return { added: 2, sent: 2, failed: 0, invalid: [] }; });
  const onCreated = jest.fn();
  const r = render(<ScheduleMeeting session={session} onCreated={onCreated} onBack={() => {}} />);
  fireEvent.changeText(r.getByLabelText('Invite by email'), 'ravi@example.com, meera@example.com');
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(order).toEqual(['create', 'invite']);
  expect(api.invite).toHaveBeenCalledWith('AT', 'new', 'ravi@example.com, meera@example.com');
});

test('nobody typed means nobody is invited — no second call at all', async () => {
  pinTenAm();
  api.create = jest.fn(async () => ({ id: 'new' }));
  api.invite = jest.fn();
  const onCreated = jest.fn();
  const r = render(<ScheduleMeeting session={session} onCreated={onCreated} onBack={() => {}} />);
  fireEvent.press(r.getByLabelText('Schedule this meeting'));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(api.invite).not.toHaveBeenCalled();
});

test('an invitation that did not go is SAID, and the meeting is still handed back', async () => {
  pinTenAm();
  api.create = jest.fn(async () => ({ id: 'new' }));
  api.invite = jest.fn(async () => ({ added: 1, sent: 0, failed: 1, invalid: ['ravi@'], note: '1 invitation could not be sent: mailbox full' }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const onCreated = jest.fn();
  try {
    const r = render(<ScheduleMeeting session={session} onCreated={onCreated} onBack={() => {}} />);
    fireEvent.changeText(r.getByLabelText('Invite by email'), 'ravi@, meera@example.com');
    fireEvent.press(r.getByLabelText('Schedule this meeting'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    const [title, body, buttons] = alert.mock.calls[0];
    expect(title).toBe('Meeting scheduled');
    expect(body).toContain('ravi@');
    expect(body).toContain('mailbox full');
    // Not moved on behind the person's back: only once they have read it.
    expect(onCreated).not.toHaveBeenCalled();
    buttons[0].onPress();
    expect(onCreated).toHaveBeenCalledWith({ id: 'new' });
  } finally { alert.mockRestore(); }
});

// ── join with a code or link ───────────────────────────────────────────────

test('codeFrom: a whole link, a bare code, and things that are neither', () => {
  expect(codeFrom(`https://connect.tatvaos.com/connect/room/${CODE}`)).toBe(CODE);
  expect(codeFrom(`  https://connect.tatvaos.com/connect/room/${CODE}?from=mail#x \n`)).toBe(CODE);
  expect(codeFrom(CODE)).toBe(CODE);
  expect(codeFrom('')).toBeNull();
  expect(codeFrom('see you at 5')).toBeNull();
  expect(codeFrom('https://connect.tatvaos.com/connect/room/too-short')).toBeNull();
  expect(codeFrom(`${CODE}x`)).toBeNull(); // 23 characters is not a code
});

test('a pasted link finds the meeting and goes to join it', async () => {
  api.list = jest.fn(async () => []);
  api.byCode = jest.fn(async () => ({ id: 'theirs', title: 'Parents’ evening', status: 'active' }));
  const onJoin = jest.fn();
  const r = render(<Meetings session={session} onJoin={onJoin} onBack={() => {}} onSchedule={() => {}} />);
  fireEvent.press(r.getByLabelText('Join with a code or link'));
  fireEvent.changeText(r.getByLabelText('Meeting link or code'), `https://connect.tatvaos.com/connect/room/${CODE}`);
  fireEvent.press(r.getByLabelText('Find this meeting'));
  await waitFor(() => expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ id: 'theirs' })));
  expect(api.byCode).toHaveBeenCalledWith('AT', CODE);
});

test('something that is not a link is answered on the spot, without asking the server', async () => {
  api.list = jest.fn(async () => []);
  api.byCode = jest.fn();
  const onJoin = jest.fn();
  const r = render(<Meetings session={session} onJoin={onJoin} onBack={() => {}} onSchedule={() => {}} />);
  fireEvent.press(r.getByLabelText('Join with a code or link'));
  fireEvent.changeText(r.getByLabelText('Meeting link or code'), 'the meeting at five');
  fireEvent.press(r.getByLabelText('Find this meeting'));
  await waitFor(() => expect(r.getByText(/does not look like a meeting link/)).toBeTruthy());
  expect(api.byCode).not.toHaveBeenCalled();
  expect(onJoin).not.toHaveBeenCalled();
});

test('a meeting that has ended is said to have ended, not joined', async () => {
  api.list = jest.fn(async () => []);
  api.byCode = jest.fn(async () => ({ id: 'old', status: 'ended' }));
  const onJoin = jest.fn();
  const r = render(<Meetings session={session} onJoin={onJoin} onBack={() => {}} onSchedule={() => {}} />);
  fireEvent.press(r.getByLabelText('Join with a code or link'));
  fireEvent.changeText(r.getByLabelText('Meeting link or code'), CODE);
  fireEvent.press(r.getByLabelText('Find this meeting'));
  await waitFor(() => expect(r.getByText('That meeting has ended.')).toBeTruthy());
  expect(onJoin).not.toHaveBeenCalled();
});

test('no such meeting is said in plain words', async () => {
  api.list = jest.fn(async () => []);
  api.byCode = jest.fn(async () => { const e = new Error('Not found.'); e.status = 404; throw e; });
  const r = render(<Meetings session={session} onJoin={() => {}} onBack={() => {}} onSchedule={() => {}} />);
  fireEvent.press(r.getByLabelText('Join with a code or link'));
  fireEvent.changeText(r.getByLabelText('Meeting link or code'), CODE);
  fireEvent.press(r.getByLabelText('Find this meeting'));
  await waitFor(() => expect(r.getByText(/No meeting was found for that link/)).toBeTruthy());
});

// ── the log ────────────────────────────────────────────────────────────────

test('a meeting code never reaches the log line; everything else still does', () => {
  expect(loggable(`/api/connect/meetings/by-code/${CODE}`)).toBe('/api/connect/meetings/by-code/<code>');
  expect(loggable(`/api/connect/meetings/by-code/${CODE}?x=1`)).toBe('/api/connect/meetings/by-code/<code>?x=1');
  expect(loggable(`/api/connect/meetings/by-code/${CODE}`)).not.toContain(CODE);
  expect(loggable('/api/connect/meetings/m1/join')).toBe('/api/connect/meetings/m1/join');
});
