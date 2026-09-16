// Steerable fakes for the native SDK and the Connect API. Every fake here is
// a claim about how the real thing behaves; where that claim came from a
// measurement it is marked. Read README.md before trusting a green.

// Native pieces the screens depend on, replaced with things a test can mockSteer.
const listeners = () => {
  const map = {};
  return {
    on(ev, fn) { (map[ev] ||= []).push(fn); return this; },
    once(ev, fn) { (map[ev] ||= []).push(fn); return this; },
    off(ev, fn) { map[ev] = (map[ev] || []).filter((f) => f !== fn); return this; },
    emit(ev, ...a) { (map[ev] || []).forEach((f) => f(...a)); },
  };
};

const mockSteer = { share: 'started', mic: 'ok' };

class MockLocalParticipant {
  constructor() { Object.assign(this, listeners()); this.identity = 'user:me'; this.name = 'Me'; this.isLocal = true;
    this.trackPublications = new Map(); this.audioTrackPublications = new Map(); this.videoTrackPublications = new Map(); this.sid = 'PA_me'; }
  getTrackPublication() { return undefined; }
  async setMicrophoneEnabled(on) { if (mockSteer.mic === 'refuse') { const e = new Error('NotAllowedError'); throw e; } return on; }
  async setCameraEnabled(on) { return on; }
  async setScreenShareEnabled(on) {
    if (!on) return undefined;
    if (mockSteer.share === 'started') return { trackSid: 'TR_share', source: 'screen_share' };
    // MEASURED, emulator, 9 Sept 2026: refusal resolved undefined.
    if (mockSteer.share === 'undefined') return undefined;
    // MEASURED, Samsung, 9 Sept 2026: refusal THREW with name='Error' and
    // message='NotAllowedError' — the inverted shape.
    if (mockSteer.share === 'throw-refusal') { const e = new Error('NotAllowedError'); e.name = 'Error'; throw e; }
    if (mockSteer.share === 'throw-other') { throw new Error('Something broke'); }
  }
}

// The engine as lib/engineReaper.js reads it. `revive()` is the race READ in
// livekit-client 2.22.3 on 16 Sept: close() marks it closed, then an in-flight
// join() sets _isClosed back to false.
class MockEngine {
  constructor() { this.isClosed = false; this.attemptingReconnect = false; this.closeCalls = 0; this.leaves = 0;
    this.client = { isDisconnected: false, sendLeave: async () => { this.leaves++; } }; }
  async close() { this.closeCalls++; this.isClosed = true; this.client.isDisconnected = true; }
  revive() { this.isClosed = false; this.client.isDisconnected = false; }
}

const mockState = { lastRoom: null, rooms: [] };
class MockRoom {
  constructor() { Object.assign(this, listeners()); this.localParticipant = new MockLocalParticipant(); this.remoteParticipants = new Map(); mockState.lastRoom = this; mockState.rooms.push(this); this.connectCalls = []; this.state = 'disconnected'; }
  async connect(url, token) { this.connectCalls.push({ url, token }); this.engine = new MockEngine(); this.state = 'connected'; this.emit('connectionStateChanged', 'connected'); }
  // As the real one: already disconnected is a no-op; otherwise close the
  // engine, FORGET it, then announce.
  async disconnect() {
    if (this.state === 'disconnected') return;
    if (this.engine) { await this.engine.close(); this.engine = undefined; }
    this.state = 'disconnected';
    this.emit('disconnected', 1);
  }
}

jest.mock('livekit-client', () => ({
  Room: MockRoom,
  RoomEvent: {
    Disconnected: 'disconnected', LocalTrackUnpublished: 'localTrackUnpublished', ConnectionStateChanged: 'connectionStateChanged',
    ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected', Reconnected: 'reconnected',
    ActiveSpeakersChanged: 'activeSpeakersChanged', TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
    DataReceived: 'dataReceived',
    LocalTrackPublished: 'localTrackPublished', AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
  },
  DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, 0: 'UNKNOWN_REASON', 1: 'CLIENT_INITIATED', 2: 'DUPLICATE_IDENTITY' },
  Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' }, Kind: { Audio: 'audio', Video: 'video' } },
  ConnectionState: { Connected: 'connected' },
  LocalParticipant: MockLocalParticipant,
  Participant: class {},
  ParticipantEvent: {},
}));

jest.mock('@livekit/react-native', () => {
  const React = require('react');
  return {
    registerGlobals: () => {},
    AudioSession: {
      startAudioSession: jest.fn(async () => {}), stopAudioSession: jest.fn(async () => {}),
      getAudioOutputs: jest.fn(async () => ['speaker', 'earpiece']), selectAudioOutput: jest.fn(async () => {}),
    },
    VideoView: () => null,
    useRoom: (room) => {
      const [participants, set] = React.useState([]);
      React.useEffect(() => { const h = () => set([room.localParticipant, ...room.remoteParticipants.values()]); room.on('connectionStateChanged', h); room.on('participantConnected', h); return () => {}; }, [room]);
      return { participants };
    },
    useParticipant: (p) => ({ isLocal: !!p.isLocal, isSpeaking: false, cameraPublication: undefined, screenSharePublication: undefined, microphonePublication: undefined }),
  };
});
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// The API: steerable per test.
const mockApi = { join: null, wait: null, list: null, create: null, lobby: null, admit: null, deny: null };
jest.mock('../lib/connect', () => {
  const real = jest.requireActual('../lib/connect');
  return {
    ...real,
    joinMeeting: (...a) => mockApi.join(...a),
    pollWait: (...a) => mockApi.wait(...a),
    listMeetings: (...a) => mockApi.list(...a),
    createMeeting: (...a) => mockApi.create(...a),
    getLobby: (...a) => (mockApi.lobby ? mockApi.lobby(...a) : Promise.resolve([])),
    admitFromLobby: (...a) => mockApi.admit(...a),
    denyFromLobby: (...a) => mockApi.deny(...a),
  };
});

module.exports = { steer: mockSteer, api: mockApi, room: () => mockState.lastRoom, rooms: mockState.rooms, MockEngine };

// PermissionsAndroid has no native module under jest; give it one that says
// yes and remembers what was asked.
const mockPerms = { asked: [] };
jest.mock('react-native/Libraries/PermissionsAndroid/PermissionsAndroid', () => {
  const P = {
    RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
    CAMERA: 'android.permission.CAMERA',
    POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
  };
  return { __esModule: true, default: {
    PERMISSIONS: P,
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    requestMultiple: async (list) => { mockPerms.asked.push(...list); return Object.fromEntries(list.map((p) => [p, 'granted'])); },
    request: async () => 'granted',
    check: async () => true,
  } };
});
module.exports.perms = mockPerms;
