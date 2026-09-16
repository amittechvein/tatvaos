// lib/engineReaper.js on its own, with a hand-driven clock, so the timing
// claims (keeps watching; lets go once quiet; gives up after five minutes)
// are checked without waiting five minutes.

const { watchEngines, reapEngines } = require('../lib/engineReaper');

function engine() {
  const e = { isClosed: false, attemptingReconnect: false, closeCalls: 0, leaves: 0 };
  e.client = { isDisconnected: false, sendLeave: async () => { e.leaves++; } };
  e.close = async () => { e.closeCalls++; e.isClosed = true; e.client.isDisconnected = true; };
  e.revive = () => { e.isClosed = false; e.client.isDisconnected = false; };
  return e;
}

function clock() {
  let t = 0; let fn = null;
  return {
    timers: { setInterval: (f) => { fn = f; return 1; }, clearInterval: () => { fn = null; }, now: () => t },
    async tick(ms = 1500) { t += ms; if (fn) await fn(); },
    get running() { return fn !== null; },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('an open engine is told to leave and closed at once', async () => {
  const e = engine(); const c = clock();
  reapEngines([e], () => {}, c.timers);
  await settle();
  expect(e.leaves).toBe(1);
  expect(e.isClosed).toBe(true);
});

test('THE RACE: an engine that revives after closing is closed again', async () => {
  const e = engine(); const c = clock(); const lines = [];
  reapEngines([e], (l) => lines.push(l), c.timers);
  await settle();
  await c.tick();
  e.revive(); // the in-flight join lands
  await c.tick();
  expect(e.isClosed).toBe(true);
  expect(e.closeCalls).toBe(2);
  expect(e.leaves).toBe(2);
  expect(lines.filter((l) => l.includes('still open after the meeting ended'))).toHaveLength(2);
});

test('mid-reconnect is not quiet: the watch continues until the attempt ends', async () => {
  const e = engine(); const c = clock();
  e.isClosed = true; e.attemptingReconnect = true;
  reapEngines([e], () => {}, c.timers);
  for (let i = 0; i < 20; i++) await c.tick();
  expect(c.running).toBe(true);
  e.attemptingReconnect = false;
  for (let i = 0; i < 5; i++) await c.tick();
  expect(c.running).toBe(false);
});

test('a closed, quiet engine is let go after five quiet checks', async () => {
  const e = engine(); const c = clock();
  e.isClosed = true;
  reapEngines([e], () => {}, c.timers);
  await settle();
  for (let i = 0; i < 3; i++) await c.tick();
  expect(c.running).toBe(true);
  await c.tick();
  expect(c.running).toBe(false);
  expect(e.closeCalls).toBe(0);
});

test('gives up after five minutes and says so', async () => {
  const e = engine(); const c = clock(); const lines = [];
  e.isClosed = true; e.attemptingReconnect = true;
  reapEngines([e], (l) => lines.push(l), c.timers);
  await c.tick(5 * 60 * 1000);
  expect(c.running).toBe(false);
  expect(lines.some((l) => l.startsWith('gave up watching 1'))).toBe(true);
});

test('watchEngines keeps every engine the room has had, once each', () => {
  const handlers = {};
  const room = { engine: undefined, on(ev, fn) { (handlers[ev] ||= []).push(fn); } };
  const engines = watchEngines(room);
  const a = engine(); const b = engine();
  room.engine = a; handlers.connectionStateChanged.forEach((f) => f());
  room.engine = a; handlers.reconnecting.forEach((f) => f());
  room.engine = b; engines.note();
  room.engine = undefined; handlers.connectionStateChanged.forEach((f) => f());
  expect(engines).toHaveLength(2);
  expect(engines[0]).toBe(a);
  expect(engines[1]).toBe(b);
});

test('no engine on the room: says so rather than pretending to guard', () => {
  const lines = [];
  const engines = watchEngines({ on() {} }, (l) => lines.push(l));
  engines.note();
  expect(lines[0]).toMatch(/no engine visible/);
  expect(reapEngines(engines)).toEqual(expect.any(Function));
});
