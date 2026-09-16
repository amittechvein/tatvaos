/**
 * Open a product in the browser ALREADY SIGNED IN.
 *
 * docs/decisions/0003-mobile-signin-handoff.md. The app holds a token; the web
 * products read a cookie. So the app trades its token for a sixty-second,
 * single-use URL; opening that URL signs the browser in and lands on the
 * product. Without it every tile costs the person a second sign-in — the cost
 * App.js's openProduct comment has been apologising for since 8 September.
 *
 * ── NEVER LOG THE URL. ────────────────────────────────────────────────────
 * It carries the code in its fragment, and that code IS a sign-in for sixty
 * seconds. api.js logs method, path and status and never bodies, for exactly
 * this reason; this file logs whether a handoff happened, never what it was.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * FAILING HERE IS NOT AN ERROR THE PERSON SHOULD SEE. Every failure — the
 * endpoint not deployed yet, a path the server refuses, no network, a token
 * that expired — has the same right answer: open the plain product URL, which
 * is exactly what the app did before this existed. They sign in once, as they
 * do today. So this returns null rather than throwing, and the caller falls
 * back. A dead tile would be a worse bug than a second sign-in.
 */

import { request } from '../api';

const log = (line) => console.log(`[handoff] ${line}`);

/**
 * How long a tile may wait for a handoff before opening the plain URL.
 *
 * NOT api.js's 15-second timeout, and the difference is the whole point. That
 * one is right for a request somebody is watching a spinner for. This one sits
 * between a finger and a browser opening: a tile that does nothing for fifteen
 * seconds reads as broken, and the person presses it again, and again.
 *
 * Two and a half seconds is longer than the mint takes on a working connection
 * (it is one insert) and short enough that a bad connection costs a moment
 * rather than an apparently dead app. Losing the race costs exactly what the
 * app did before the handoff existed: one sign-in.
 *
 * The mint is NOT cancelled when the race is lost — the row is written and the
 * code simply expires unused sixty seconds later, which is what expiry is for.
 */
const DEADLINE_MS = 2500;

/**
 * A URL that opens `path` already signed in, or null to use the plain one.
 *
 * `path` comes from theme.js and is one of the server's allowlisted products.
 */
export async function handoffUrl(token, path) {
  if (!token || !path) return null;

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__too_slow__'), DEADLINE_MS);
  });

  try {
    const data = await Promise.race([
      request('/api/auth/handoff', { body: { path }, token }),
      deadline,
    ]);

    if (data === '__too_slow__') {
      log(`mint slower than ${DEADLINE_MS}ms; opening ${path} the plain way rather than making the tile wait`);
      return null;
    }

    // A 200 that does not carry a usable URL is not a success. Opening
    // `undefined` would send someone to a blank page with no explanation,
    // which is the shape of failure this codebase keeps writing down.
    if (typeof data?.url !== 'string' || !data.url.startsWith('https://')) {
      log(`mint answered without a usable url; opening ${path} the plain way`);
      return null;
    }

    log(`minted for ${path}`);
    return data.url;
  } catch (e) {
    // 404 while the endpoint is not deployed yet; 400 if the server refuses
    // this path; 0 for no network. The status is worth having in the log
    // because those need different fixes, and the person sees none of them.
    log(`no handoff for ${path} (${e?.status ?? 'no answer'}); opening it the plain way`);
    return null;
  } finally {
    // Or the timer keeps the JS runtime awake for up to DEADLINE_MS after a
    // fast answer — harmless on a laptop, and exactly the kind of thing that
    // shows up as battery drain on a phone.
    clearTimeout(timer);
  }
}
