// Signing out revokes the refresh token on the server, not just on the phone.
//
// Mr. Singh, 23 Sept 2026, reading PR 214: "on sign-out, is the refresh token
// revoked server-side, or only deleted from SecureStore?" It was only deleted.
// The server revokes the token family it is handed in the request body; the
// phone sent no body. These pin the body, the order (read before delete), and
// that a phone with no network still signs out locally.

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
const { signOut } = require('../api');

const REFRESH_KEY = 'tatvaos.refresh';
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body ?? {}) });
let calls;

beforeEach(() => {
  for (const k of Object.keys(SecureStore.__store)) delete SecureStore.__store[k];
  SecureStore.__store[REFRESH_KEY] = 'RT-LIVE';
  calls = [];
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('THE REFRESH TOKEN IS SENT IN THE BODY, so the server can revoke its family', async () => {
  global.fetch = jest.fn(async (url, init) => { calls.push({ url, init }); return reply(200, {}); });
  await signOut('AT');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toMatch(/\/api\/auth\/logout$/);
  expect(calls[0].init.headers.Authorization).toBe('Bearer AT');
  expect(JSON.parse(calls[0].init.body)).toEqual({ refreshToken: 'RT-LIVE' });
  // And only THEN is the local copy gone.
  expect(SecureStore.__store[REFRESH_KEY]).toBeUndefined();
});

test('read before delete: the token is still there when the server is asked', async () => {
  let tokenAtCall = 'not read';
  global.fetch = jest.fn(async (url, init) => {
    tokenAtCall = JSON.parse(init.body).refreshToken;
    return reply(200, {});
  });
  await signOut('AT');
  expect(tokenAtCall).toBe('RT-LIVE');
});

test('no network: the phone still signs out locally, and says the server was not reached', async () => {
  global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
  await expect(signOut('AT')).resolves.toBeUndefined();
  expect(SecureStore.__store[REFRESH_KEY]).toBeUndefined();
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/reached no server/));
});

test('no access token: nothing is sent, the local copy is still removed', async () => {
  global.fetch = jest.fn();
  await signOut(null);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(SecureStore.__store[REFRESH_KEY]).toBeUndefined();
});

test('no stored refresh token: the server is still told, with an empty body', async () => {
  delete SecureStore.__store[REFRESH_KEY];
  global.fetch = jest.fn(async (url, init) => { calls.push({ url, init }); return reply(200, {}); });
  await signOut('AT');
  expect(JSON.parse(calls[0].init.body)).toEqual({});
});
