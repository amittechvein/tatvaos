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

export interface SignedInUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  categoryId: string | null;
}

interface AuthState {
  user: SignedInUser | null;
  mustChangePassword: boolean;
  /** True until the initial refresh attempt settles. Render nothing until then. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  /** fetch() that attaches the token and retries once after a silent refresh. */
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [mustChangePassword, setMustChange] = useState(false);
  const [loading, setLoading] = useState(true);

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
    accessToken: string; mustChangePassword: boolean; user: SignedInUser;
  }) => {
    accessToken.current = data.accessToken;
    setUser(data.user);
    setMustChange(data.mustChangePassword);
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
    const call = () => fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
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
    applyAuth(await res.json());
  }, [applyAuth]);

  const signOut = useCallback(async () => {
    await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken.current ? { Authorization: `Bearer ${accessToken.current}` } : {}),
      },
      credentials: 'include',
      body: '{}',
    }).catch(() => undefined);

    accessToken.current = null;
    setUser(null);
    setMustChange(false);
  }, []);

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
    user, mustChangePassword, loading, signIn, signOut, changePassword, authedFetch,
  }), [user, mustChangePassword, loading, signIn, signOut, changePassword, authedFetch]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
