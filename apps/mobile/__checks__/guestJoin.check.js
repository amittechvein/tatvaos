// The guest door: joining a meeting with no TatvaOS account.
//
// Amit, 23 Sept 2026. The server side has existed since August and the web has
// used it all along; these check the APP's half — that it calls the anonymous
// routes WITHOUT a token, tells the server's several refusals apart, and never
// invents a reason the server did not give.

jest.mock('../api', () => ({ request: jest.fn() }));
const { request } = require('../api');
const { doorstep, joinAsGuest, codeFrom, DOOR_CLOSED } = require('../lib/connect');

const fail = (status, message = 'no') => Object.assign(new Error(message), { status });

beforeEach(() => { request.mockReset(); });

describe('the doorstep', () => {
  test('asks the anonymous route and carries NO token', async () => {
    request.mockResolvedValue({ title: 'Standup', state: 'active', passwordRequired: false });
    const d = await doorstep('AAAAAAAAAAAAAAAAAAAAAA');

    expect(d.kind).toBe('open');
    expect(d.title).toBe('Standup');
    const [path, opts] = request.mock.calls[0];
    expect(path).toBe('/api/connect/g/AAAAAAAAAAAAAAAAAAAAAA');
    expect(opts.method).toBe('GET');
    // THE POINT. A guest has no token, and sending one on an anonymous route
    // is how a signed-in person would quietly take a guest seat in their own
    // meeting — no host powers, no way to admit anybody.
    expect(opts.token).toBeUndefined();
  });

  test('reads the flags a guest is owed, defaulting to the safe answer', async () => {
    request.mockResolvedValue({ passwordRequired: true, locked: true, minutesLive: true, state: 'ended' });
    const d = await doorstep('c');
    expect(d).toMatchObject({ passwordRequired: true, locked: true, minutesLive: true, state: 'ended' });

    request.mockResolvedValue({});
    const bare = await doorstep('c');
    expect(bare.passwordRequired).toBe(false);
    expect(bare.locked).toBe(false);
    expect(bare.minutesLive).toBe(false);
    expect(bare.state).toBe('not_started');
  });

  test('404 is the one sentence, not an exception', async () => {
    request.mockRejectedValue(fail(404));
    const d = await doorstep('c');
    expect(d.kind).toBe('closed');
    expect(d.message).toBe(DOOR_CLOSED);
  });

  test('a server that is down is NOT a closed door', async () => {
    // Otherwise a network failure reads as "your link is wrong" and the person
    // retypes a perfectly good code until they give up.
    request.mockRejectedValue(fail(503, 'Cannot reach TatvaOS'));
    await expect(doorstep('c')).rejects.toThrow('Cannot reach TatvaOS');
  });
});

describe('knocking', () => {
  const seat = {
    status: 'joined', token: 'LK', wsUrl: 'wss://connect.tatvaos.com',
    identity: 'guest:1', mode: 'recorded', chatPolicy: 'everyone',
  };

  test('a seat comes back in the same shape the signed-in join uses', async () => {
    request.mockResolvedValue(seat);
    const r = await joinAsGuest('CODE', '  Ravi  ');
    expect(r).toMatchObject({ kind: 'joined', token: 'LK', wsUrl: 'wss://connect.tatvaos.com' });
    // A guest is never host. The server does not say so; this must not guess
    // otherwise, or the app would draw admit/deny controls that cannot work.
    expect(r.role).toBe('participant');
  });

  test('the name is trimmed and sent, still with no token', async () => {
    request.mockResolvedValue(seat);
    await joinAsGuest('CODE', '  Ravi  ');
    const [path, opts] = request.mock.calls[0];
    expect(path).toBe('/api/connect/g/CODE/join');
    expect(opts.method).toBe('POST');
    expect(opts.body).toEqual({ displayName: 'Ravi' });
    expect(opts.token).toBeUndefined();
  });

  test('a password is sent only when there is one', async () => {
    request.mockResolvedValue(seat);
    await joinAsGuest('CODE', 'Ravi', 'hunter2');
    expect(request.mock.calls[0][1].body).toEqual({ displayName: 'Ravi', password: 'hunter2' });

    request.mockClear();
    await joinAsGuest('CODE', 'Ravi', '');
    expect(request.mock.calls[0][1].body).toEqual({ displayName: 'Ravi' });
  });

  test('an empty name never reaches the server', async () => {
    const r = await joinAsGuest('CODE', '   ');
    expect(r.kind).toBe('rejected');
    expect(request).not.toHaveBeenCalled();
  });

  test('a name over 100 characters is refused here too', async () => {
    const r = await joinAsGuest('CODE', 'x'.repeat(101));
    expect(r.kind).toBe('rejected');
    expect(request).not.toHaveBeenCalled();
  });

  test('waiting comes back as waiting, with the token to poll', async () => {
    request.mockResolvedValue({ status: 'waiting', waitToken: 'W123' });
    const r = await joinAsGuest('CODE', 'Ravi');
    expect(r).toMatchObject({ kind: 'waiting', waitToken: 'W123' });
    expect(r.message).toMatch(/waiting room/i);
  });

  test('A WRONG PASSWORD IS NOT A DEAD LINK', async () => {
    // 403 and 404 are different answers and must read differently, or someone
    // with a good code retypes it forever instead of asking for the password.
    request.mockRejectedValue(fail(403, 'That password is not right.'));
    const r = await joinAsGuest('CODE', 'Ravi', 'wrong');
    expect(r.kind).toBe('password');
    expect(r.message).not.toBe(DOOR_CLOSED);
  });

  test('a meeting that is over says so in the server words', async () => {
    request.mockRejectedValue(fail(409, 'That meeting is over.'));
    const r = await joinAsGuest('CODE', 'Ravi');
    expect(r.kind).toBe('closed');
    expect(r.message).toBe('That meeting is over.');
  });

  test('404 stays the one sentence — the app invents no better reason', async () => {
    // The server answers 404 for a bad code, a cancelled meeting, guests
    // switched off for that organisation, AND a full meeting. They are
    // deliberately identical so a stranger cannot probe.
    request.mockRejectedValue(fail(404));
    const r = await joinAsGuest('CODE', 'Ravi');
    expect(r).toEqual({ kind: 'closed', message: DOOR_CLOSED });
  });
});

describe('what people paste', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv';

  test('a whole invitation link gives up its code', () => {
    expect(codeFrom('https://connect.tatvaos.com/connect/room/' + code)).toBe(code);
    expect(codeFrom('https://connect.tatvaos.com/connect/room/' + code + '?x=1#y')).toBe(code);
  });

  test('the bare code works, spaces and all', () => {
    expect(codeFrom('  ' + code + '  ')).toBe(code);
  });

  test('nothing usable is null rather than a round trip', () => {
    expect(codeFrom('')).toBeNull();
    expect(codeFrom(null)).toBeNull();
    expect(codeFrom('hello')).toBeNull();
    expect(codeFrom(code.slice(0, 21))).toBeNull();
  });

  test('CODES ARE CASE-SENSITIVE', () => {
    // 128 bits of base64url. Upper-casing a pasted code breaks half of them.
    expect(codeFrom(code)).toBe(code);
    expect(codeFrom(code.toUpperCase())).toBe(code.toUpperCase());
    expect(codeFrom(code.toUpperCase())).not.toBe(code);
  });
});

describe('a link that opens the app', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv';

  test('both ways in give up the same code', () => {
    // The custom scheme works today; the https one works once Android has
    // verified us against assetlinks.json on that domain.
    expect(codeFrom('tatvaos://room/' + code)).toBe(code);
    expect(codeFrom('https://connect.tatvaos.com/connect/room/' + code)).toBe(code);
  });

  test('the app declares BOTH filters, or Android opens the browser instead', () => {
    // This is the whole feature on the Android side and it lives in config,
    // where nothing else would notice it going missing — an expo prebuild
    // regenerates the manifest from this file.
    const filters = require('../app.json').expo.android.intentFilters;
    expect(Array.isArray(filters)).toBe(true);

    const https = filters.find((f) => f.data?.some((d) => d.scheme === 'https'));
    expect(https).toBeTruthy();
    expect(https.data[0].host).toBe('connect.tatvaos.com');
    // The invitation link the server builds is /connect/room/<code>
    // (ConnectEndpoints.JoinUrlOf). A prefix that does not match it means
    // every invitation keeps opening the browser.
    expect(https.data[0].pathPrefix).toBe('/connect/room');
    // Without autoVerify Android never checks assetlinks.json and never
    // makes us the default handler.
    expect(https.autoVerify).toBe(true);
    expect(https.category).toEqual(expect.arrayContaining(['BROWSABLE', 'DEFAULT']));

    const scheme = filters.find((f) => f.data?.some((d) => d.scheme === 'tatvaos'));
    expect(scheme).toBeTruthy();
    expect(scheme.data[0].host).toBe('room');
  });

  test('the app scheme still matches the one the filter uses', () => {
    expect(require('../app.json').expo.scheme).toBe('tatvaos');
  });
});
