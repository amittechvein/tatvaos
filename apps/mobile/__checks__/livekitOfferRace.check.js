// patches/livekit-client@2.22.3.patch, checked against the REAL library code
// (this file does not load mocks.js, so `livekit-client` is what Metro bundles).
//
// 17 Sept 2026, Samsung SM-A356E, 10:12:53: the screen share ended while the
// phone was locked; on unlock livekit started an offer, a reconnect closed the
// peer connection while createOffer was awaited, and the transport's lazy `pc`
// getter built a NEW connection — which was handed the old one's offer and
// refused it: "Local fingerprint does not match identity". The call dropped.
//
// Red without the patch: run this file where node_modules holds an unpatched
// livekit-client and the fingerprint error comes back.

const { Room } = require('livekit-client');

const created = [];
class FakePeerConnection {
  constructor() {
    this.id = created.length;
    this.cert = `CERT-${this.id}`;
    this.signalingState = 'stable';
    this.local = null;
    created.push(this);
    // Anything the library pokes that this fake does not model is a no-op.
    return new Proxy(this, {
      get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('on') ? () => undefined : undefined)),
    });
  }
  async createOffer() {
    await new Promise((r) => setTimeout(r, 20));
    return { type: 'offer', sdp: `v=0\r\na=fingerprint:sha-256 ${this.cert}\r\n` };
  }
  // What libwebrtc does: an offer from another connection's certificate is refused.
  async setLocalDescription(sd) {
    if (!sd.sdp.includes(this.cert)) throw new Error('Local fingerprint does not match identity');
    this.local = sd;
  }
  close() { this.signalingState = 'closed'; }
  getTransceivers() { return []; }
  getSenders() { return []; }
  getReceivers() { return []; }
  createDataChannel() { return { addEventListener() {}, close() {} }; }
  addEventListener() {}
  removeEventListener() {}
}

let warn;
beforeEach(() => {
  created.length = 0;
  global.RTCPeerConnection = FakePeerConnection;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); delete global.RTCPeerConnection; });

async function publisher() {
  const room = new Room();
  room.maybeCreateEngine();
  await room.engine.configure();
  return room.engine.pcManager.publisher;
}

const warnings = () => warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

test('an offer whose connection is closed mid-createOffer is discarded, never applied to a new connection', async () => {
  const transport = await publisher();
  const sent = [];
  transport.onOffer = (offer) => sent.push(offer);

  const offering = transport.createAndSendOffer();
  await new Promise((r) => setTimeout(r, 5)); // createOffer is in flight
  transport.close(); // the reconnect tears the connection down
  await offering;

  expect(warnings()).not.toMatch(/fingerprint does not match/);
  expect(created).toHaveLength(1); // no replacement connection conjured to receive a stale offer
  expect(sent).toHaveLength(0);
  expect(warnings()).toMatch(/\[tatvaos patch\] peer connection was replaced while creating an offer/);
});

test('an undisturbed offer still goes out (the guard does not stop normal negotiation)', async () => {
  const transport = await publisher();
  const sent = [];
  transport.onOffer = (offer) => sent.push(offer);
  await transport.createAndSendOffer();
  expect(sent).toHaveLength(1);
  expect(created[0].local.sdp).toContain('CERT-0');
});
