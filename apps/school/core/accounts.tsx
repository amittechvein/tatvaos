// Saved school, saved logins and the active login (FR-C01, FR-C02, FR-C06, FR-C13, B-02).
//
// - The chosen school is kept so the next launch goes straight to sign-in.
// - Every login on this phone is kept (two children, or a teacher who is also a parent), each
//   with its own school host and token; one is active and the others stay signed in.
// - Tokens live only in the phone's secure storage (NF-06), one key per login. Nothing about a
//   login is written to a plain file.
// - "Keep me signed in" off: the token is held in memory only, so closing the app signs out,
//   and 30 minutes in the background signs out too (design decision, 6 Oct 2026).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Device from "./device";
import { api, LoginAnswer, School } from "./api";
import { forget as forgetBiometric } from "./biometric";
import { clear as clearOffline } from "./offline";

export type Account = {
  id: string; // `${schoolCode}_${userId}`: also the secure-storage key suffix
  school: School;
  userId: number;
  name: string;
  username: string;
  role: "STUDENT" | "EMPLOYEE" | "ADMIN";
  keep: boolean;
  mustChangePassword: boolean;
};

const K_SCHOOL = "school";
const K_ACCOUNTS = "accounts";
const K_ACTIVE = "active";
const tokenKey = (id: string) => `token_${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
const BACKGROUND_LIMIT_MS = 30 * 60 * 1000;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (key: string, value: unknown) => SecureStore.setItemAsync(key, JSON.stringify(value));

type Ctx = {
  ready: boolean;
  school: School | null;
  accounts: Account[];
  active: Account | null;
  token: string | null;
  chooseSchool: (s: School | null) => Promise<void>;
  signIn: (s: School, username: string, password: string, keep: boolean) => Promise<Account>;
  /** Saves a login the server has already answered (sign in with mobile OTP). */
  addLogin: (s: School, r: LoginAnswer, keep: boolean) => Promise<Account>;
  signOut: (id?: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  tokenOf: (id: string) => string | null;
  passwordChanged: () => Promise<void>;
};

const AccountsContext = createContext<Ctx | null>(null);

export function AccountsProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [school, setSchool] = useState<School | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // tokens by account id; the source of truth for "signed in"
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const backgroundAt = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      const [s, list, act] = await Promise.all([
        readJson<School | null>(K_SCHOOL, null),
        readJson<Account[]>(K_ACCOUNTS, []),
        SecureStore.getItemAsync(K_ACTIVE).catch(() => null),
      ]);
      // logins saved with "keep me signed in" off have no stored token: they ended when the app closed
      const kept = list.filter((a) => a.keep);
      const found: Record<string, string> = {};
      for (const a of kept) {
        const t = await SecureStore.getItemAsync(tokenKey(a.id)).catch(() => null);
        if (t) found[a.id] = t;
      }
      const alive = kept.filter((a) => found[a.id]);
      if (alive.length !== list.length) await writeJson(K_ACCOUNTS, alive);
      setSchool(s);
      setAccounts(alive);
      setTokens(found);
      setActiveId(alive.find((a) => a.id === act)?.id ?? alive[0]?.id ?? null);
      setReady(true);
    })();
  }, []);

  const persist = useCallback(async (list: Account[], act: string | null) => {
    setAccounts(list);
    setActiveId(act);
    await writeJson(K_ACCOUNTS, list);
    if (act) await SecureStore.setItemAsync(K_ACTIVE, act);
    else await SecureStore.deleteItemAsync(K_ACTIVE);
  }, []);

  const chooseSchool = useCallback(async (s: School | null) => {
    setSchool(s);
    if (s) await writeJson(K_SCHOOL, s);
    else await SecureStore.deleteItemAsync(K_SCHOOL);
  }, []);

  const addLogin = useCallback(
    async (s: School, r: LoginAnswer, keep: boolean) => {
      const acc: Account = {
        id: `${s.code}_${r.user.id}`,
        school: s,
        userId: r.user.id,
        name: r.user.name,
        username: r.user.username,
        role: r.user.role,
        keep,
        mustChangePassword: r.mustChangePassword,
      };
      if (keep) await SecureStore.setItemAsync(tokenKey(acc.id), r.token);
      setTokens((t) => ({ ...t, [acc.id]: r.token }));
      await chooseSchool(s);
      await persist([...accounts.filter((a) => a.id !== acc.id), acc], acc.id);
      return acc;
    },
    [accounts, chooseSchool, persist],
  );

  const signIn = useCallback(
    async (s: School, username: string, password: string, keep: boolean) =>
      addLogin(s, await api.login(s.host, username.trim(), password, Device.name()), keep),
    [addLogin],
  );

  const signOut = useCallback(
    async (id?: string) => {
      const target = id ?? activeId;
      if (!target) return;
      const acc = accounts.find((a) => a.id === target);
      const t = tokens[target];
      // tell the school (ends the token and stops pushes to this phone); signing out works offline too
      if (acc && t) api.logout(acc.school.host, t).catch(() => {});
      await SecureStore.deleteItemAsync(tokenKey(target)).catch(() => {});
      await forgetBiometric(target);
      await clearOffline(target);
      setTokens(({ [target]: _gone, ...rest }) => rest);
      const left = accounts.filter((a) => a.id !== target);
      await persist(left, target === activeId ? left[0]?.id ?? null : activeId);
    },
    [accounts, activeId, persist, tokens],
  );

  const switchTo = useCallback(async (id: string) => persist(accounts, id), [accounts, persist]);

  const passwordChanged = useCallback(async () => {
    // the backend ends every session of the login when its password changes
    if (activeId) await signOut(activeId);
  }, [activeId, signOut]);

  // "Keep me signed in" off: 30 minutes in the background ends those logins
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") backgroundAt.current = Date.now();
      if (state === "active" && backgroundAt.current) {
        const away = Date.now() - backgroundAt.current;
        backgroundAt.current = null;
        if (away > BACKGROUND_LIMIT_MS) accounts.filter((a) => !a.keep).forEach((a) => signOut(a.id));
      }
    });
    return () => sub.remove();
  }, [accounts, signOut]);

  const active = accounts.find((a) => a.id === activeId && tokens[a.id]) ?? null;
  const value = useMemo<Ctx>(
    () => ({
      ready,
      school,
      accounts: accounts.filter((a) => tokens[a.id]),
      active,
      token: active ? tokens[active.id] : null,
      chooseSchool,
      signIn,
      addLogin,
      signOut,
      switchTo,
      tokenOf: (id) => tokens[id] ?? null,
      passwordChanged,
    }),
    [ready, school, accounts, active, tokens, chooseSchool, signIn, addLogin, signOut, switchTo, passwordChanged],
  );
  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts() {
  const c = useContext(AccountsContext);
  if (!c) throw new Error("useAccounts outside AccountsProvider");
  return c;
}
