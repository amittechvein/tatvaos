/**
 * Makes sure a meeting that has ended on the phone has also ended on the server.
 *
 * ── THE GHOST FOUND ON 16 SEPT 2026, 21:56. ─────────────────────────────────
 *  Amit locked the phone while sharing, unlocked it, and the phone said "You
 *  have left the meeting". The laptop in the same meeting still showed him in
 *  it — tile, name, muted mic — and kept showing him.
 *
 *  The phone's log: renegotiation failed ("Local fingerprint does not match
 *  identity"), the room went reconnecting -> disconnected, and EIGHTEEN SECONDS
 *  LATER the library rejoined the server with a new participant id. Nobody on
 *  the phone could see or end that connection.
 *
 *  Why, in livekit-client 2.22.3 (read, not guessed):
 *   - RTCEngine.close() sets _isClosed = true and removes every listener.
 *   - But a full reconnect already in flight (restartConnection) is sitting in
 *     `await this.join(...)`, and join() sets `_isClosed = false` when the
 *     server answers. Close loses the race; the engine is alive again.
 *   - Room.disconnect() has already done `this.engine = undefined`, and a
 *     second room.disconnect() returns early with "already disconnected". So
 *     the revived engine is unreachable through the Room — an orphan holding a
 *     seat in the meeting.
 *
 *  So the Room cannot be trusted to have closed its engine. This keeps its own
 *  list of every engine the Room ever had, and after the meeting ends it keeps
 *  closing any of them that come back, until each has been quiet for a while.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `room.engine` is not documented public API. If a library upgrade renames it,
 * watchEngines records nothing and says so in the log — the phone then behaves
 * exactly as it did before this file, rather than crashing.
 */

const TICK_MS = 1500;

// The default reconnect policy retries ten times over roughly fifty seconds, and
// each attempt can itself wait on a join timeout. Five minutes is generous; the
// cost of a timer ticking for five minutes is nothing next to a ghost in a call.
const GIVE_UP_MS = 5 * 60 * 1000;

// An engine is only let go once it has been closed and not mid-reconnect this
// many checks in a row, so a join that is about to land still gets caught.
const QUIET_TICKS = 5;

/** Remembers every engine a Room uses. Returns the list it fills. */
export function watchEngines(room, log = () => {}) {
  const engines = [];
  const note = () => {
    const engine = room?.engine;
    if (engine && !engines.includes(engine)) engines.push(engine);
  };
  // ConnectionStateChanged fires before Room.disconnect() drops its reference,
  // and on every reconnecting/reconnected — each moment a new engine can appear.
  room.on('connectionStateChanged', note);
  room.on('connected', note);
  room.on('reconnecting', note);
  engines.note = () => {
    note();
    if (engines.length === 0) log('no engine visible on the room — cannot guard against a ghost connection');
  };
  return engines;
}

function isSettled(engine) {
  return engine.isClosed === true && !engine.attemptingReconnect;
}

async function shutDown(engine, log) {
  try {
    // Tell the server we are leaving, as Room.disconnect() does, so the seat is
    // freed now rather than after the server's own departure timeout.
    if (engine.client && !engine.client.isDisconnected) await engine.client.sendLeave();
  } catch (e) {
    log(`leave message not sent: ${e?.message ?? e}`);
  }
  try {
    await engine.close('the meeting ended on this phone');
  } catch (e) {
    log(`engine close failed: ${e?.message ?? e}`);
  }
}

const running = new Set();

/**
 * Close every engine in `engines` now, and keep re-closing any that revive
 * until each is settled or GIVE_UP_MS passes. Returns a stop function.
 * Deliberately NOT tied to the screen's lifetime: the ghost appears after the
 * screen has already given up on the meeting, often after it has unmounted.
 */
export function reapEngines(engines, log = () => {}, timers = { setInterval, clearInterval, now: Date.now }) {
  const list = [...engines];
  if (list.length === 0) return () => {};

  const quiet = new Map(list.map((e) => [e, 0]));
  const started = timers.now();
  let busy = false;
  let handle = null;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const engine of list) {
        if (!quiet.has(engine)) continue;
        if (isSettled(engine)) {
          const n = quiet.get(engine) + 1;
          if (n >= QUIET_TICKS) quiet.delete(engine);
          else quiet.set(engine, n);
          continue;
        }
        if (engine.isClosed !== true) {
          // This line in the phone's log is the ghost being caught. Search for it.
          log('a connection was still open after the meeting ended — closing it');
          await shutDown(engine, log);
        }
        quiet.set(engine, 0);
      }
      if (quiet.size === 0 || timers.now() - started >= GIVE_UP_MS) {
        if (quiet.size > 0) log(`gave up watching ${quiet.size} connection(s) after ${GIVE_UP_MS / 1000}s`);
        stop();
      }
    } finally {
      busy = false;
    }
  };

  function stop() {
    if (handle) { timers.clearInterval(handle); handle = null; }
    running.delete(stop);
  }

  handle = timers.setInterval(tick, TICK_MS);
  running.add(stop);
  tick();
  return stop;
}

/** For the checks: a watcher outliving its test would keep jest waiting. */
export function stopAllReapers() {
  for (const stop of [...running]) stop();
}
