// Staying signed in while the app is open: api.js renews an expired access
// token once, retries once, and only ends the session when the SERVER says so.
// 16 Sept 2026 — before this, every request failed with 401 fifteen minutes
// after the app was opened, until it was closed and opened again.

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
const { request, onSessionChange } = require('../api');

const REFRESH_KEY = 'tatvaos.refresh';
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const session = (n) => ({
  accessToken: `AT-${n}`, refreshToken: `RT-${n}`, expiresAt: '2026-09-16T12:00:00Z',
  user: { email: 'x@example.com' },
});

let calls;
let listened;
let unsubscribe;

beforeEach(() => {
  for (const k of Object.keys(SecureStore.__store)) delete SecureStore.__store[k];
  SecureStore.__store[REFRESH_KEY] = 'RT-OLD';
  calls = [];
  listened = [];
  unsubscribe = onSessionChange((s) => listened.push(s));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { unsubscribe(); console.log.mockRestore(); delete global.fetch; });

function serve(...answers) {
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: init.body });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

test('an expired token is renewed once and the SAME request is retried with the new one', async () => {
  serve(reply(401, { error: 'expired' }), reply(200, session(2)), reply(200, { meetings: [] }));

  const data = await request('/api/connect/meetings', { method: 'GET', token: 'AT-STALE' });

  expect(data).toEqual({ meetings: [] });
  expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
    '/api/connect/meetings', '/api/auth/refresh', '/api/connect/meetings',
  ]);
  expect(calls[0].auth).toBe('Bearer AT-STALE');
  expect(calls[2].auth).toBe('Bearer AT-2');
  expect(SecureStore.__store[REFRESH_KEY]).toBe('RT-2');             // the rotated refresh token was kept
  expect(listened.map((s) => s?.accessToken)).toEqual(['AT-2']);      // App.js is told
});

test('a wrong password is NOT a reason to renew — /api/auth/* never retries', async () => {
  serve(reply(401, { error: 'Invalid email or password.' }));
  await expect(request('/api/auth/login', { body: { email: 'a', password: 'b' }, token: 'AT-X' }))
    .rejects.toMatchObject({ status: 401 });
  expect(calls).toHaveLength(1);
  expect(listened).toEqual([]);
});

test('no loop: a retry that is still 401 fails instead of renewing again', async () => {
  serve(reply(401), reply(200, session(2)), reply(401, { error: 'still no' }));
  await expect(request('/api/mail/folders', { method: 'GET', token: 'AT-STALE' }))
    .rejects.toMatchObject({ status: 401 });
  expect(calls).toHaveLength(3);
});

test('when the SERVER refuses the refresh token, the session ends and App.js is told', async () => {
  serve(reply(401), reply(401, { error: 'Session expired. Sign in again.' }));
  await expect(request('/api/mail/folders', { method: 'GET', token: 'AT-STALE' }))
    .rejects.toMatchObject({ status: 401 });
  expect(SecureStore.__store[REFRESH_KEY]).toBeUndefined();
  expect(listened).toEqual([null]);
});

test('no signal is NOT a sign-out: the stored token survives and nobody is told to sign in', async () => {
  serve(reply(401), new TypeError('Network request failed'));
  await expect(request('/api/mail/folders', { method: 'GET', token: 'AT-STALE' }))
    .rejects.toMatchObject({ status: 401 });
  expect(SecureStore.__store[REFRESH_KEY]).toBe('RT-OLD');
  expect(listened).toEqual([]);
});

test('a call with no token never tries to renew', async () => {
  serve(reply(401));
  await expect(request('/api/connect/g/abc', { method: 'GET' })).rejects.toMatchObject({ status: 401 });
  expect(calls).toHaveLength(1);
});
