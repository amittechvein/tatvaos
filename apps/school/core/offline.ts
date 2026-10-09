// Offline copies of the read screens (SRS section 8, "Offline"): the last answer of each is kept
// so the screen still shows it, with an "updated at" time, when the phone has no connection.
// Kept in secure storage (encrypted by the phone's keystore), never in a plain file (NF-06), and
// deleted when the login signs out. Payments, approvals and the like never use a copy.
import * as SecureStore from "expo-secure-store";

/** The only screens that keep an offline copy. */
export const OFFLINE_SCREENS = new Set(["bootstrap", "attendance", "fees", "timetable", "homework-pages", "notice-pages", "calendar", "leaves", "staff-sections", "staff-roster"]);
const MAX_CHARS = 60_000;

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const indexKey = (accountId: string) => `cache_${safe(accountId)}__index`;
export const copyKey = (accountId: string, name: string, extra: unknown[] = []) => `cache_${safe(accountId)}_${safe([name, ...extra.map(String)].join("_"))}`;

export type Copy<T> = { at: number; data: T };

export async function save<T>(accountId: string, name: string, extra: unknown[], data: T) {
  if (!OFFLINE_SCREENS.has(name)) return;
  const json = JSON.stringify({ at: Date.now(), data });
  if (json.length > MAX_CHARS) return;
  const key = copyKey(accountId, name, extra);
  try {
    await SecureStore.setItemAsync(key, json);
    const index: string[] = JSON.parse((await SecureStore.getItemAsync(indexKey(accountId))) || "[]");
    if (!index.includes(key)) await SecureStore.setItemAsync(indexKey(accountId), JSON.stringify([...index, key].slice(-40)));
  } catch {
    // a copy is a convenience; never let it break the screen
  }
}

export async function load<T>(accountId: string, name: string, extra: unknown[] = []): Promise<Copy<T> | null> {
  if (!OFFLINE_SCREENS.has(name)) return null;
  try {
    const raw = await SecureStore.getItemAsync(copyKey(accountId, name, extra));
    return raw ? (JSON.parse(raw) as Copy<T>) : null;
  } catch {
    return null;
  }
}

/** Sign-out deletes every copy of the login (SRS section 8: "Signing out deletes the cache"). */
export async function clear(accountId: string) {
  try {
    const index: string[] = JSON.parse((await SecureStore.getItemAsync(indexKey(accountId))) || "[]");
    await Promise.all(index.map((k) => SecureStore.deleteItemAsync(k).catch(() => {})));
    await SecureStore.deleteItemAsync(indexKey(accountId));
  } catch {
    // nothing saved
  }
}
