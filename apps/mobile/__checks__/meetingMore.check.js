// The "More" sheet in a meeting: people, chat, recording, settings.
//
// Amit, 23 Sept 2026. The sheet draws what the meeting screen knows and calls
// back for every action. These hold who sees which control — the web room is
// the reference — and that a tap reaches the right callback with the right
// identity, because a mute sent for the wrong person is the failure nobody
// would report as "the app is broken".

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const React = require('react');
const { render, fireEvent } = require('@testing-library/react-native');
const { Alert } = require('react-native');
const MeetingMore = require('../screens/MeetingMore').default;
const { personOf } = require('../screens/MeetingMore');

const me = { identity: 'user:u1#dev', name: 'Amit', isLocal: true, isMicrophoneEnabled: true };
const ravi = { identity: 'user:u2#dev', name: 'Ravi', isLocal: false, isMicrophoneEnabled: false, isCameraEnabled: true };
const guest = { identity: 'guest:g1', name: 'Priya', isLocal: false, isMicrophoneEnabled: true };

const mount = (over = {}) => render(
  <MeetingMore visible onClose={() => {}} role="participant" participants={[me, ravi, guest]} {...over} />,
);

beforeEach(() => jest.spyOn(Alert, 'alert').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test('personOf drops the device tag, so two phones are one person', () => {
  expect(personOf('user:u1#phone')).toBe('user:u1');
  expect(personOf('guest:g1')).toBe('guest:g1');
  expect(personOf(undefined)).toBe('');
});

describe('people', () => {
  test('everyone is listed, you are marked, hands come first', () => {
    const r = mount({ hands: new Set(['guest:g1']) });
    expect(r.getByText('3 IN THE MEETING')).toBeTruthy();
    expect(r.getByText('Amit (you)')).toBeTruthy();
    const labels = r.getAllByLabelText(/hand raised|, you|muted|Ravi|Priya/).map((n) => n.props.accessibilityLabel);
    expect(labels[0]).toMatch(/^Priya.*hand raised/);
  });

  test('raise hand calls back, and reads as Lower once raised', () => {
    const onToggleHand = jest.fn();
    const r = mount({ onToggleHand });
    fireEvent.press(r.getByLabelText('Raise hand'));
    expect(onToggleHand).toHaveBeenCalled();
    const r2 = mount({ myHand: true });
    expect(r2.getByLabelText('Lower hand')).toBeTruthy();
  });

  test('a participant gets NO options on anybody, and no host row', () => {
    const r = mount({ role: 'participant' });
    expect(r.queryByLabelText(/Options for/)).toBeNull();
    expect(r.queryByLabelText('Mute everyone')).toBeNull();
    expect(r.queryByLabelText('End meeting for everyone')).toBeNull();
  });

  test('a host gets options on everyone but themselves, plus Mute all and End', () => {
    const r = mount({ role: 'host' });
    expect(r.getByLabelText('Options for Ravi')).toBeTruthy();
    expect(r.getByLabelText('Options for Priya')).toBeTruthy();
    expect(r.queryByLabelText('Options for Amit')).toBeNull();
    expect(r.getByLabelText('Mute everyone')).toBeTruthy();
    expect(r.getByLabelText('End meeting for everyone')).toBeTruthy();
  });

  test('the options offered fit the person: a guest cannot be made co-host', () => {
    fireEvent.press(mount({ role: 'host' }).getByLabelText('Options for Priya'));
    const forGuest = Alert.alert.mock.calls.at(-1)[2].map((b) => b.text);
    expect(forGuest).not.toContain('Make co-host');
    expect(forGuest).toContain('Remove from meeting');

    fireEvent.press(mount({ role: 'host' }).getByLabelText('Options for Ravi'));
    const forRavi = Alert.alert.mock.calls.at(-1)[2].map((b) => b.text);
    expect(forRavi).toContain('Make co-host');
    // Ravi is muted already: no "Mute microphone"; camera is on: offered.
    expect(forRavi).not.toContain('Mute microphone');
    expect(forRavi).toContain('Turn camera off');
  });

  test('a co-host may mute and remove but NOT change roles (host only, like the server)', () => {
    fireEvent.press(mount({ role: 'cohost' }).getByLabelText('Options for Ravi'));
    const texts = Alert.alert.mock.calls.at(-1)[2].map((b) => b.text);
    expect(texts).not.toContain('Make co-host');
    expect(texts).toContain('Remove from meeting');
  });

  test('MUTE REACHES THE RIGHT IDENTITY', () => {
    const onMute = jest.fn();
    fireEvent.press(mount({ role: 'host', onMute, participants: [me, guest] }).getByLabelText('Options for Priya'));
    const mute = Alert.alert.mock.calls.at(-1)[2].find((b) => b.text === 'Mute microphone');
    mute.onPress();
    expect(onMute).toHaveBeenCalledWith('guest:g1', 'audio');
  });
});

describe('chat', () => {
  const open = (over) => {
    const r = mount(over);
    fireEvent.press(r.getByLabelText('Chat'));
    return r;
  };

  test('lines are shown, yours on your side; sending calls back with the trimmed text', () => {
    const onSendChat = jest.fn();
    const r = open({ chat: [{ cid: 'a', name: 'Ravi', text: 'नमस्ते', mine: false }, { cid: 'b', name: 'You', text: 'hi', mine: true }], onSendChat });
    expect(r.getByLabelText('Ravi: नमस्ते')).toBeTruthy();
    expect(r.getByLabelText('You: hi')).toBeTruthy();
    fireEvent.changeText(r.getByLabelText('Message'), '  ok 👍  ');
    fireEvent.press(r.getByLabelText('Send message'));
    expect(onSendChat).toHaveBeenCalledWith('ok 👍');
  });

  test('chat policy is honoured on the phone, as the server does not enforce it', () => {
    expect(open({ chatPolicy: 'off' }).queryByLabelText('Message')).toBeNull();
    expect(open({ chatPolicy: 'off' }).getByText(/Chat is off/)).toBeTruthy();
    expect(open({ chatPolicy: 'cohost', role: 'participant' }).queryByLabelText('Message')).toBeNull();
    expect(open({ chatPolicy: 'cohost', role: 'cohost' }).getByLabelText('Message')).toBeTruthy();
    expect(open({ chatPolicy: 'everyone', role: 'participant' }).getByLabelText('Message')).toBeTruthy();
  });

  test('unread count shows on the Chat tab until it is opened', () => {
    const r = mount({ unreadChat: 3 });
    expect(r.getByText('3')).toBeTruthy();
    fireEvent.press(r.getByLabelText('Chat'));
    expect(r.queryByText('3')).toBeNull();
  });
});

describe('recording', () => {
  const open = (over) => {
    const r = mount(over);
    fireEvent.press(r.getByLabelText('Record'));
    return r;
  };

  test('a participant cannot start it and is told who can', () => {
    const r = open({ role: 'participant' });
    expect(r.queryByLabelText('Start recording')).toBeNull();
    expect(r.getByText(/Only the host can record/)).toBeTruthy();
  });

  test('a host sees Start, with the notice the web shows first', () => {
    const onStartRecording = jest.fn();
    const r = open({ role: 'host', onStartRecording });
    fireEvent.press(r.getByLabelText('Start recording'));
    // Confirmed first, then started.
    const ok = Alert.alert.mock.calls.at(-1)[2].find((b) => b.text === 'Start');
    ok.onPress();
    expect(onStartRecording).toHaveBeenCalledWith('video');
  });

  test('while running, a host sees Stop and nothing else', () => {
    const onStopRecording = jest.fn();
    const r = open({ role: 'host', recording: { enabled: true, live: { id: 'r1' }, active: true }, onStopRecording });
    expect(r.queryByLabelText('Start recording')).toBeNull();
    fireEvent.press(r.getByLabelText('Stop recording'));
    expect(onStopRecording).toHaveBeenCalled();
  });

  test('a private meeting, or an organisation without recording, offers nothing', () => {
    expect(open({ role: 'host', mode: 'private' }).getByText(/private meeting cannot be recorded/)).toBeTruthy();
    expect(open({ role: 'host', recording: { enabled: false, live: null, active: false } }).getByText(/not switched on/)).toBeTruthy();
  });
});

describe('settings', () => {
  test('the tab exists for a host or co-host only', () => {
    expect(mount({ role: 'participant' }).queryByLabelText('Settings')).toBeNull();
    expect(mount({ role: 'cohost' }).getByLabelText('Settings')).toBeTruthy();
  });

  test('a choice patches exactly that setting', () => {
    const onPatchSetting = jest.fn();
    const r = mount({ role: 'host', onPatchSetting, settings: { sharePolicy: 'everyone', chatPolicy: 'everyone', waitingRoom: 'guests' } });
    fireEvent.press(r.getByLabelText('Settings'));
    fireEvent.press(r.getByLabelText('Who can share their screen: Host only'));
    expect(onPatchSetting).toHaveBeenCalledWith({ sharePolicy: 'host' });
    fireEvent.press(r.getByLabelText('Waiting room: Off'));
    expect(onPatchSetting).toHaveBeenCalledWith({ waitingRoom: 'off' });
    fireEvent(r.getByLabelText('Lock the meeting'), 'valueChange', true);
    expect(onPatchSetting).toHaveBeenCalledWith({ locked: true });
  });
});
