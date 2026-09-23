// Signing in with a mobile number and a one-time code.
//
// Amit, 23 Sept 2026: "give option to login with mobile no via otp". Same two
// routes the web's Mobile OTP tab uses. These check the app's half against the
// server's real answers, including the two that look like something else:
// a 200 that sent no code, and a 200 that is not a sign-in.

jest.mock('expo-secure-store', () => {
  const store = {};
  return {
    __store: store,
    getItemAsync: jest.fn(async (k) => (k in store ? store[k] : null)),
    setItemAsync: jest.fn(async (k, v) => { store[k] = v; }),
    deleteItemAsync: jest.fn(async (k) => { delete store[k]; }),
  };
});

const SecureStore = require('expo-secure-store');
const { requestOtp, loginWithOtp } = require('../api');

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

let calls;
beforeEach(() => {
  for (const k of Object.keys(SecureStore.__store)) delete SecureStore.__store[k];
  calls = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const answer = (...replies) => {
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, init });
    return replies.shift();
  });
};
const bodyOf = (i) => JSON.parse(calls[i].init.body);

describe('asking for a code', () => {
  test('posts the number as typed, trimmed, with no token', async () => {
    answer(reply(200, { sent: true, message: 'If this number is registered, a code has been sent to it.' }));
    const r = await requestOtp('  +91 98765 43210 ');
    expect(calls[0].url).toMatch(/\/api\/auth\/otp\/request$/);
    expect(bodyOf(0)).toEqual({ phone: '+91 98765 43210' });
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(r.sent).toBe(true);
    expect(r.devCode).toBeNull();
  });

  test('THE NUMBER IS NOT REWRITTEN — no country code is guessed', async () => {
    // The server matches the stored spelling exactly and does not assume
    // +91 on lookup. Adding one here would silently look up a different
    // account from the one the person registered.
    answer(reply(200, { sent: true }));
    await requestOtp('9876543210');
    expect(bodyOf(0).phone).toBe('9876543210');
  });

  test('a code shown on screen is passed through, and only when present', async () => {
    answer(reply(200, { sent: true, message: 'm', devCode: '123456' }));
    expect((await requestOtp('+919999900001')).devCode).toBe('123456');
  });

  test('a bad shape is the server sentence, not a crash', async () => {
    answer(reply(400, { error: 'Enter the mobile number with its country code, like +91 98765 43210.' }));
    await expect(requestOtp('12')).rejects.toThrow(/country code/);
  });
});

describe('signing in with the code', () => {
  const session = {
    accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-09-23T12:00:00Z',
    user: { id: 'u1', email: 'amit@tatvaos.com', displayName: 'Amit' },
  };

  test('a session is kept exactly as a password sign-in would keep it', async () => {
    answer(reply(200, session));
    const r = await loginWithOtp('+919999900001', ' 123456 ');
    expect(calls[0].url).toMatch(/\/api\/auth\/otp\/verify$/);
    expect(bodyOf(0)).toEqual({ phone: '+919999900001', code: '123456' });
    expect(r.kind).toBe('session');
    expect(r.session.accessToken).toBe('AT');
    expect(r.session.user.displayName).toBe('Amit');
    // The refresh token goes to the keychain, same key as login().
    expect(SecureStore.__store['tatvaos.refresh']).toBe('RT');
  });

  test('A 200 WITH mfaRequired IS NOT A SIGN-IN', async () => {
    // The OTP is only the first factor. An account with two-step on gets a
    // challenge and NO token; declaring that a sign-in leaves every screen
    // holding undefined.
    answer(reply(200, { mfaRequired: true, challenge: 'CH', note: 'Enter the code from your authenticator app.' }));
    const r = await loginWithOtp('+919999900001', '123456');
    expect(r.kind).toBe('mfa');
    expect(r.challenge).toBe('CH');
    expect(SecureStore.__store['tatvaos.refresh']).toBeUndefined();
  });

  test('a refused code is the server sentence and NEVER a token renewal', async () => {
    // /api/auth/* 401s must not trigger the refresh-and-retry: there is no
    // session to refresh, and retrying would burn a second of the 5 attempts.
    answer(reply(401, { error: 'That email address and password combination was not recognised.' }));
    await expect(loginWithOtp('+919999900001', '000000')).rejects.toThrow(/not recognised/);
    expect(calls).toHaveLength(1);
  });

  test('a session the app cannot read is refused, not half-kept', async () => {
    answer(reply(200, { accessToken: 'AT' }));    // no refreshToken
    await expect(loginWithOtp('+919999900001', '123456')).rejects.toThrow(/could not read/);
    expect(SecureStore.__store['tatvaos.refresh']).toBeUndefined();
  });
});
