// The one door to the server.
//
// Every network call the app makes goes through `request` below, so timeouts,
// error wording and token storage have exactly one implementation to get
// right. The web app learned this the expensive way: four hand-rolled SMTP
// clients before anyone noticed. One door, from the start.

import * as SecureStore from 'expo-secure-store';

import { hosts, isProduction } from './lib/hosts';

// Set in app.json under expo.extra.hosts. See lib/hosts.js for why it moved
// out of here, and for the one thing about it that is not yet established.
export const API_BASE = hosts.core;

//  Logged once, at import. "Which server am I actually talking to" is the
//  first question of every confusing bug report, and until now the answer
//  was a literal three files away.
console.log(`[api] talking to ${API_BASE}${isProduction ? '' : ' (NOT production)'}`);

// Access tokens from this API last about fifteen minutes (proven: a token
// issued at 17:41 carried expiresAt 17:56). So the REFRESH token is what
// actually keeps somebody signed in between launches, which makes it the
// long-lived secret — it goes in the device keychain (iOS Keychain, Android
// Keystore), never in plain storage.
const REFRESH_KEY = 'tatvaos.refresh';

// A request that never returns is worse than one that fails. Without this the
// person watches a spinner forever on a bad train connection and cannot tell
// whether to wait or retry. React Native's fetch has no useful default.
const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // 0 means we never got an answer at all
  }
}

/**
 * One line per request, and it is the only reason anyone can diagnose this app
 * remotely.
 *
 * 8 Sept 2026: a sign-in on the emulator did not store a session, and the
 * device log could not say why — because after the startup line this app
 * emitted NOTHING. A 401, a DNS failure and a person who simply never pressed
 * the button all produced an identical, empty log. The only diagnostic
 * available was to look at the screen, which rules out ever helping someone
 * with a problem we cannot reproduce.
 *
 * WHAT THIS DELIBERATELY NEVER PRINTS: the request body, the response body,
 * the access token, the refresh token, the password, or the email address.
 * Method, path, status and duration answer "did it reach the server and what
 * did the server say", which is the question. Anything more is a credential in
 * a log file that gets pasted into a chat window.
 */
function logLine(method, path, status, ms, note) {
  console.log(`[api] ${method} ${path} -> ${status} ${ms}ms${note ? ' ' + note : ''}`);
}

/**
 * Exported so lib/connect.js can use the same door rather than growing a
 * second one. Behaviour unchanged — this adds a keyword and nothing else.
 */
export async function request(path, { method = 'POST', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // React Native keeps a native cookie jar, and /api/auth/refresh reads a
      // cookie BEFORE it reads the body. Left alone, a cookie the app never
      // asked for could quietly decide which session gets refreshed. This app
      // carries its own token; it should not also carry cookies.
      credentials: 'omit',
      signal: controller.signal,
    });
  } catch (e) {
    // "We gave up waiting" and "there is no network" need different advice,
    // so they get different sentences. The log keeps the distinction too — a
    // timeout and a refused connection look identical to the person and mean
    // completely different things to whoever is fixing it.
    logLine(method, path, 'FAILED', Date.now() - started,
            e.name === 'AbortError' ? '(timed out)' : `(${e.name}: ${e.message})`);
    throw new ApiError(
      e.name === 'AbortError'
        ? 'The server is taking too long to answer. Try again.'
        : 'Cannot reach TatvaOS. Check your internet connection.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  logLine(method, path, res.status, Date.now() - started);

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    // The server's own wording is the right wording. It is written for the
    // person, it names the lockout minutes, and it is deliberately vague about
    // whether an account exists — rewriting it here would leak that. Only fall
    // back to our own sentence when the server sent none.
    throw new ApiError(data?.error || `Something went wrong (${res.status}).`, res.status);
  }
  return data;
}

// ---------------------------------------------------------------------------
//  Sign in
// ---------------------------------------------------------------------------

/**
 * Returns either { kind: 'session', session } or { kind: 'mfa', challenge }.
 *
 * THE TRAP THIS EXISTS TO AVOID: when an account has two-factor turned on the
 * server answers **200 OK** with `{ mfaRequired: true, challenge }` and NO
 * token. A client that checks `response.ok` and nothing else declares the
 * person signed in, then holds `undefined` where the token should be. Every
 * screen after that looks broken and nothing in the logs says why.
 */
export async function login(email, password) {
  const data = await request('/api/auth/login', { body: { email, password } });
  if (data?.mfaRequired) {
    // Logged because this is the branch that looks like success and is not:
    // 200 OK, no token. Without this line, "login returned 200 but nobody is
    // signed in" is indistinguishable from a bug in the storage code.
    console.log('[api] login -> two-step verification required');
    return { kind: 'mfa', challenge: data.challenge, note: data.note };
  }
  console.log('[api] login -> session issued');
  return { kind: 'session', session: await keep(data) };
}

export async function verifyMfa(challenge, code) {
  const data = await request('/api/auth/mfa/verify', { body: { challenge, code } });
  return { kind: 'session', session: await keep(data) };
}

/**
 * Store the refresh token, hand back the parts the screens need.
 *
 * Field names confirmed against production, not assumed: the response carries
 * accessToken, expiresAt, refreshToken, mustChangePassword, user, slot,
 * accounts — and user carries id, email, displayName, role, status, mfaEnabled,
 * departmentId. `slot` and `accounts` are the browser multi-account switcher;
 * they mean nothing on a phone, so they are ignored on purpose rather than
 * carried around as dead weight.
 */
async function keep(data) {
  if (!data?.accessToken || !data?.refreshToken) {
    throw new ApiError('The server sent a sign-in we could not read.', 0);
  }
  await SecureStore.setItemAsync(REFRESH_KEY, data.refreshToken);
  // The keychain write is its own failure mode - it is native, it can throw on
  // a device with no secure hardware, and until this line the only evidence it
  // had happened was a file appearing in shared_prefs.
  console.log('[api] refresh token stored in the keychain');
  return {
    accessToken: data.accessToken,
    expiresAt: data.expiresAt,
    mustChangePassword: !!data.mustChangePassword,
    user: data.user ?? {},
  };
}

// ---------------------------------------------------------------------------
//  Staying signed in
// ---------------------------------------------------------------------------

/**
 * On launch: trade the stored refresh token for a live session, or null.
 *
 * SINGLE-FLIGHT, and here is the incident. 9 Sept 2026, 19:48:36, within 120ms:
 *
 *     POST /api/auth/refresh -> 200        rotates the token, stores the new one
 *     POST /api/auth/refresh -> 401        the OLD token, just consumed
 *
 * and the catch below - correctly reasoning that a server-rejected token is
 * spent - cleared it. The person was signed out. Two callers had raced: the
 * refresh token rotates on every use, so the second request is indistinguishable
 * from a revoked session.
 *
 * On a cold launch this fires once and is fine (measured, same day: one
 * refresh, 200, no 401). The double call came from Fast Refresh re-running the
 * effect in App.js after a hot patch - the `cancelled` flag there drops the
 * second STATE UPDATE, but the second REQUEST has already gone. Development
 * only, then, today. But any future duplicate - a remount, a second screen
 * calling this, a retry - produces the same permanent logout, so concurrent
 * callers now share one in-flight request rather than racing their own
 * rotation. Cost: one variable.
 */
let restoring = null;

export function restore() {
  if (restoring) {
    console.log('[api] restore already in flight; joining it rather than refreshing twice');
    return restoring;
  }
  restoring = restoreOnce().finally(() => { restoring = null; });
  return restoring;
}

async function restoreOnce() {
  // The keychain read is INSIDE the try from here on. It used to sit outside
  // every guard in this file, so a throw here rejected restore() and — with no
  // .catch in App.js — pinned the app on its splash screen permanently. Both
  // halves of that are fixed; this half means the caller gets "nobody is
  // signed in", which is true and recoverable, instead of an exception.
  let saved;
  try {
    saved = await SecureStore.getItemAsync(REFRESH_KEY);
  } catch (e) {
    console.log(`[api] keychain read failed, treating as signed out: ${e?.message ?? e}`);
    return null;
  }
  if (!saved) {
    console.log('[api] no stored session; showing sign-in');
    return null;
  }

  try {
    // The body is the documented mobile path — the endpoint's own comment says
    // so: "Cookie first ... the body is the mobile path."
    const data = await request('/api/auth/refresh', { body: { refreshToken: saved } });
    return await keep(data);
  } catch (e) {
    // A token the SERVER rejected is spent: rotated, revoked, or the account is
    // gone. Clear it, or every launch repeats a call that cannot succeed.
    //
    // A NETWORK failure is not that, and must not sign the person out. Someone
    // opening the app in a lift should not be logged out by a dead signal.
    if (e.status >= 400) await SecureStore.deleteItemAsync(REFRESH_KEY);
    return null;
  }
}

/**
 * Who is signed in, which organisation, and WHICH PRODUCTS THEY ACTUALLY HAVE.
 *
 * That last part is why this call is worth making: without it the dashboard
 * shows six tiles to everybody, and four of them open a page that tells the
 * person they have no access. A tile that cannot work should not be on the
 * screen.
 *
 * Returns { user, organisation, products, mailboxAddress }. `products` is a
 * list of product CODES — see the note on `product` in theme.js, because two
 * of them are not what you would guess.
 */
export async function me(accessToken) {
  return request('/api/auth/me', { method: 'GET', token: accessToken });
}

export async function signOut(accessToken) {
  try {
    if (accessToken) await request('/api/auth/logout', { token: accessToken });
  } catch {
    // Sign-out has to work locally even when the server cannot be reached.
    // Refusing to sign somebody out on a train, so as to keep a server row
    // tidy, is the wrong trade — the session expires on its own anyway.
  }
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}
