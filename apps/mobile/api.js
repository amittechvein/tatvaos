// The one door to the server.
//
// Every network call the app makes goes through `request` below, so timeouts,
// error wording and token storage have exactly one implementation to get
// right. The web app learned this the expensive way: four hand-rolled SMTP
// clients before anyone noticed. One door, from the start.

import * as SecureStore from 'expo-secure-store';

// Change this in ONE place to point the app at a different server.
export const API_BASE = 'https://core.tatvaos.com';

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

async function request(path, { method = 'POST', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
    // so they get different sentences.
    throw new ApiError(
      e.name === 'AbortError'
        ? 'The server is taking too long to answer. Try again.'
        : 'Cannot reach TatvaOS. Check your internet connection.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }

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
    return { kind: 'mfa', challenge: data.challenge, note: data.note };
  }
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

/** On launch: trade the stored refresh token for a live session, or null. */
export async function restore() {
  const saved = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!saved) return null;

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
