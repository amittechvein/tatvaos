'use client';

// ============================================================================
//  Authentication for the web client
// ============================================================================
//
//  THE ACCESS TOKEN IS HELD IN MEMORY AND NOWHERE ELSE.
//
//  Not localStorage, not sessionStorage, not a readable cookie. This product
//  renders HTML written by strangers — assume a cross-site scripting bug will
//  happen one day, and make it survivable rather than fatal. Anything in
//  localStorage is readable by any script on the page, so a token there means
//  one XSS is a full account takeover, and a stolen token cannot be withdrawn.
//
//  In memory, a token dies with the tab. The cost is that a page refresh loses
//  it — which is why the refresh token is an httpOnly cookie the browser sends
//  automatically and no script can read. On mount we exchange that cookie for
//  a fresh access token, so the user stays signed in without the credential
//  ever being reachable from JavaScript.
// ============================================================================

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/**
 * One account signed in on this browser.
 *
 * Assembled by the server from httpOnly cookies and returned in the auth
 * responses. There is deliberately no token here and no way to get one: the
 * switcher renders names, and switching is a server call that validates the
 * slot's actual refresh token.
 */
export interface AccountSlot {
  slot: number;
  email: string;
  displayName: string;
  organisation: string;
  /** False once the slot's token has expired or been signed out. */
  signedIn: boolean;
  active: boolean;
}

export interface SignedInUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  departmentId: string | null;
}

/**
 * What a sign-in returns when the account has two-step verification on.
 *
 * The password (or SMS code) was correct — this is NOT a failure. The server
 * has withheld the session until the second factor is proven, so the caller
 * must collect a code and call verifyMfa. Nothing about the account has
 * changed yet, including the failed-attempt counter.
 */
export interface MfaChallenge {
  challenge: string;
  note: string;
}

interface AuthState {
  user: SignedInUser | null;
  mustChangePassword: boolean;
  /** True until the initial refresh attempt settles. Render nothing until then. */
  loading: boolean;
  /** Every account signed in on this browser, including signed-out ones. */
  accounts: AccountSlot[];
  /** Resolves with a challenge when MFA is on, or null when signed in. */
  signIn: (email: string, password: string) => Promise<MfaChallenge | null>;
  /** Request a sign-in code by SMS. Resolves with a dev code when the
   *  platform is in testing mode and the real send failed. */
  requestOtp: (phone: string) => Promise<{ devCode: string | null }>;
  /** Sign in with the SMS code. Same session as a password sign-in, and the
   *  same MFA challenge if the account has it on. */
  signInWithOtp: (phone: string, code: string) => Promise<MfaChallenge | null>;
  /** Completes a challenged sign-in with a TOTP code or a recovery code. */
  verifyMfa: (challenge: string, code: string) => Promise<void>;
  /** Signs out of the CURRENT account only; the others stay signed in. */
  signOut: (all?: boolean) => Promise<void>;
  /** Move to another account already signed in here. No password. */
  switchTo: (slot: number) => Promise<void>;
  /** "Remove" — revokes that account's session and drops it from the list. */
  forget: (slot: number) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  /** fetch() that attaches the token and retries once after a silent refresh. */
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [mustChangePassword, setMustChange] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountSlot[]>([]);

  // A ref, not state. Setting state schedules a re-render and the new value is
  // not visible to code already running — and the very next thing we do after
  // a refresh is retry a request with the new token.
  const accessToken = useRef<string | null>(null);

  // Several requests can 401 at the same moment. Without this they would each
  // start their own refresh, and rotation means the second one presents an
  // already-spent token — which the server correctly treats as a replay and
  // kills the whole session. One in-flight refresh, shared.
  const refreshing = useRef<Promise<boolean> | null>(null);

  const applyAuth = useCallback((data: {
    accessToken: string; mustChangePassword: boolean;
    user: SignedInUser; accounts?: AccountSlot[] | null;
  }) => {
    accessToken.current = data.accessToken;
    setUser(data.user);
    setMustChange(data.mustChangePassword);
    if (data.accounts) setAccounts(data.accounts);
  }, []);

  const doRefresh = useCallback(async (): Promise<boolean> => {
    if (refreshing.current) return refreshing.current;

    refreshing.current = (async () => {
      try {
        const res = await fetch(`${API}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Sends the httpOnly cookie. Without this the browser omits it and
          // every refresh fails for a reason that looks like a server bug.
          credentials: 'include',
          body: '{}',
        });
        if (!res.ok) {
          accessToken.current = null;
          setUser(null);
          // A 401 still carries the roster. Someone whose session expired
          // should land on "pick an account", not on a blank sign-in form
          // that has forgotten they have three accounts here.
          const body = await res.json().catch(() => null);
          if (body?.accounts) setAccounts(body.accounts);
          return false;
        }
        applyAuth(await res.json());
        return true;
      } catch {
        return false;
      } finally {
        refreshing.current = null;
      }
    })();

    return refreshing.current;
  }, [applyAuth]);

  // On mount: try to resume. A 401 here is the normal "not signed in" case,
  // not an error worth showing anyone.
  useEffect(() => {
    void doRefresh().finally(() => setLoading(false));
  }, [doRefresh]);

  const authedFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    // FormData sets its own multipart Content-Type WITH a boundary; forcing
    // application/json here would strip the boundary and the server would fail
    // to parse the upload. Only default to JSON for non-form bodies.
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const call = () => fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
        ...(accessToken.current ? { Authorization: `Bearer ${accessToken.current}` } : {}),
      },
    });

    let res = await call();

    // Access tokens last 15 minutes, so this is routine rather than
    // exceptional. Retry once; a second 401 means the session is genuinely
    // over and the caller should handle it.
    if (res.status === 401 && await doRefresh()) res = await call();

    return res;
  }, [doRefresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Sign-in failed.');
    }

    // The response body also carries refreshToken. It is deliberately ignored
    // here — it exists for the mobile apps. The browser already has it as a
    // cookie no script can read, and storing a copy would undo that.
    const body = await res.json();

    // MFA on: a challenge, not a session. applyAuth would set a null user and
    // the page would render as signed-in-but-broken.
    if (body.mfaRequired) return { challenge: body.challenge, note: body.note };

    applyAuth(body);
    return null;
  }, [applyAuth]);

  const requestOtp = useCallback(async (phone: string) => {
    const res = await fetch(`${API}/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ phone }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Could not send the code.');
    return { devCode: body.devCode ?? null };
  }, []);

  const signInWithOtp = useCallback(async (phone: string, code: string) => {
    const res = await fetch(`${API}/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ phone, code }),
    });
    const body = await res.json().catch(() => ({}));
    // The server sends ONE message for wrong code, unknown number and
    // suspended account. Passed through untouched for the same reason the
    // password path does it.
    if (!res.ok) throw new Error(body.error ?? 'Sign-in failed.');

    // The SMS code is a first factor here, not a second one — an account with
    // MFA on is challenged after it, exactly as after a password.
    if (body.mfaRequired) return { challenge: body.challenge, note: body.note };

    applyAuth(body);
    return null;
  }, [applyAuth]);

  const verifyMfa = useCallback(async (challenge: string, code: string) => {
    const res = await fetch(`${API}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ challenge, code }),
    });
    const body = await res.json().catch(() => ({}));
    // One message for a wrong app code and a wrong recovery code, passed
    // through untouched — the server does not say which, on purpose.
    if (!res.ok) throw new Error(body.error ?? 'That code was not accepted.');
    applyAuth(body);
  }, [applyAuth]);

  /**
   * Signs out of the account in use. The others stay signed in, and this one
   * stays in the chooser as a one-click "Sign in" — pass all=true for the
   * shared-machine case, which clears everything.
   */
  const signOut = useCallback(async (all = false) => {
    const res = await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken.current ? { Authorization: `Bearer ${accessToken.current}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ all }),
    }).catch(() => null);

    accessToken.current = null;
    setUser(null);
    setMustChange(false);

    const body = res && res.ok ? await res.json().catch(() => null) : null;
    setAccounts(all ? [] : (body?.accounts ?? []));

    // If another account is still signed in here, land on it rather than on a
    // sign-in form — the person signed out of one account, not out of the
    // browser.
    if (!all && typeof body?.switchedTo === 'number') {
      await switchToRef.current?.(body.switchedTo);
    }
  }, []);

  /**
   * Switch to an account already signed in on this browser.
   *
   * Sends no credential. The slot's httpOnly refresh cookie is the credential,
   * and the server rotates it with the same reuse detection as any refresh —
   * so a stale slot fails here rather than handing back a session it should
   * not have.
   */
  const switchTo = useCallback(async (slot: number) => {
    const res = await fetch(`${API}/auth/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ slot }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // That account's session ended while it sat in the list. Reflect it
      // rather than pretending — the row becomes "Signed out / Sign in".
      accessToken.current = null;
      setUser(null);
      await refreshAccountsRef.current?.();
      throw new Error(body?.error ?? 'That account needs to sign in again.');
    }

    applyAuth(body);
  }, [applyAuth]);

  /** "Remove" in the chooser. Revokes that account's session, then forgets it. */
  const forget = useCallback(async (slot: number) => {
    const res = await fetch(`${API}/auth/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ slot }),
    }).catch(() => null);

    const body = res && res.ok ? await res.json().catch(() => null) : null;
    setAccounts(body?.accounts ?? []);

    // Removing the account you are using signs you out of it, which is what
    // "remove" has to mean.
    if (user && !((body?.accounts ?? []) as AccountSlot[]).some((a) => a.active)) {
      accessToken.current = null;
      setUser(null);
    }
  }, [user]);

  const refreshAccounts = useCallback(async () => {
    const res = await fetch(`${API}/auth/accounts`, { credentials: 'include' })
      .catch(() => null);
    if (!res || !res.ok) return;
    const body = await res.json().catch(() => null);
    setAccounts(body?.accounts ?? []);
  }, []);

  // signOut is defined before switchTo but calls it, and refreshAccounts is
  // defined after switchTo. Refs break the cycle without reordering the file
  // into something that reads backwards.
  const switchToRef = useRef<typeof switchTo | null>(null);
  const refreshAccountsRef = useRef<typeof refreshAccounts | null>(null);
  switchToRef.current = switchTo;
  refreshAccountsRef.current = refreshAccounts;

  const changePassword = useCallback(async (current: string, next: string) => {
    const res = await authedFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Could not change the password.');
    }

    // The server revoked every session, including this one's refresh token.
    // Signing the user out here is honest about that rather than letting them
    // discover it fifteen minutes later.
    accessToken.current = null;
    setUser(null);
    setMustChange(false);
  }, [authedFetch]);

  const value = useMemo<AuthState>(() => ({
    user, mustChangePassword, loading, accounts,
    signIn, requestOtp, signInWithOtp, verifyMfa,
    signOut, switchTo, forget, refreshAccounts, changePassword, authedFetch,
  }), [user, mustChangePassword, loading, accounts,
       signIn, requestOtp, signInWithOtp, verifyMfa,
       signOut, switchTo, forget, refreshAccounts, changePassword, authedFetch]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
