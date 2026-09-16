// The sign-in handoff, app side: when it is asked for, what it returns, and
// what it must never write to the log.

jest.mock('../api', () => ({ request: jest.fn() }));

const { request } = require('../api');
const { handoffUrl } = require('../lib/handoff');

const CODE = 'a'.repeat(43);
const URL = `https://core.tatvaos.com/handoff#c=${CODE}&p=%2Fmail`;

beforeEach(() => {
  request.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); });

test('asks the server for the product path and hands back the url', async () => {
  request.mockResolvedValue({ url: URL, expiresAt: '2026-09-16T10:00:00Z' });
  await expect(handoffUrl('AT', '/mail')).resolves.toBe(URL);
  expect(request).toHaveBeenCalledWith('/api/auth/handoff', { body: { path: '/mail' }, token: 'AT' });
});

test('THE URL IS NEVER LOGGED — it carries a sign-in for sixty seconds', async () => {
  request.mockResolvedValue({ url: URL });
  await handoffUrl('AT', '/mail');
  const logged = console.log.mock.calls.flat().join(' ');
  expect(logged).not.toContain(CODE);
  expect(logged).not.toContain(URL);
  // Something was said, though: silence would leave nobody able to tell a
  // handoff from a fallback when a tile misbehaves.
  expect(logged).toContain('/mail');
});

test('a refusal, a missing endpoint or a dead network all fall back quietly', async () => {
  for (const status of [400, 401, 404, 500, 0]) {
    request.mockReset();
    const e = new Error('nope'); e.status = status;
    request.mockRejectedValue(e);
    await expect(handoffUrl('AT', '/mail')).resolves.toBeNull();
  }
});

test('a 200 without a usable url is a failure, not a url', async () => {
  for (const body of [{}, null, { url: 42 }, { url: 'javascript:alert(1)' }, { url: 'http://core.tatvaos.com/handoff#c=x' }]) {
    request.mockReset();
    request.mockResolvedValue(body);
    await expect(handoffUrl('AT', '/mail')).resolves.toBeNull();
  }
});

test('a slow mint loses the race, so the tile is never left waiting on the network', async () => {
  jest.useFakeTimers();
  try {
    request.mockReturnValue(new Promise(() => {})); // never answers
    const pending = handoffUrl('AT', '/mail');
    await jest.advanceTimersByTimeAsync(2600);
    await expect(pending).resolves.toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('no token and no path never reach the server', async () => {
  await expect(handoffUrl(null, '/mail')).resolves.toBeNull();
  // Connect has no path: it opens a native screen, not a browser.
  await expect(handoffUrl('AT', undefined)).resolves.toBeNull();
  expect(request).not.toHaveBeenCalled();
});
