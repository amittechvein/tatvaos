// Attendance saved with no connection (SRS section 8: "Teacher attendance can be saved offline
// and sent automatically later; if someone changed it meanwhile, the server keeps the newer save
// and tells the teacher"). One waiting save per section and date, kept in secure storage for the
// login, sent when the app is next open with a connection.
import * as SecureStore from "expo-secure-store";
import { ApiError, AttendanceSave } from "./api";

export type Queued = { save: AttendanceSave; label: string; queuedAt: number };

/** What happened to each waiting save when sending was tried. */
export type Outcome =
  | { kind: "sent"; item: Queued }
  | { kind: "kept"; item: Queued } // still no connection, or the login must sign in again
  | { kind: "theirs"; item: Queued; by: string | null; at: string | null } // someone saved after; theirs kept
  | { kind: "refused"; item: Queued; message: string }; // locked day, holiday, no longer allowed

const keyOf = (accountId: string) => `attq_${accountId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
export const slot = (s: AttendanceSave) => `${s.section_id}:${s.attendance_date}`;

export async function read(accountId: string): Promise<Queued[]> {
  try {
    return JSON.parse((await SecureStore.getItemAsync(keyOf(accountId))) || "[]");
  } catch {
    return [];
  }
}

async function write(accountId: string, items: Queued[]) {
  if (items.length) await SecureStore.setItemAsync(keyOf(accountId), JSON.stringify(items));
  else await SecureStore.deleteItemAsync(keyOf(accountId)).catch(() => {});
}

/** Keeps a save to send later; a newer save of the same section and date replaces it. */
export async function enqueue(accountId: string, item: Queued) {
  const items = (await read(accountId)).filter((q) => slot(q.save) !== slot(item.save));
  await write(accountId, [...items, item]);
}

export const clear = (accountId: string) => write(accountId, []);

/**
 * Tries each waiting save in order. `myUserId` tells a refusal caused by this login's own earlier
 * save (sent, but its answer was lost) from someone else's: the first is simply done.
 */
export async function sendAll(items: Queued[], send: (s: AttendanceSave) => Promise<unknown>, myUserId: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let stop = false;
  for (const item of items) {
    if (stop) {
      out.push({ kind: "kept", item });
      continue;
    }
    try {
      await send(item.save);
      out.push({ kind: "sent", item });
    } catch (e) {
      if (!(e instanceof ApiError) || e.offline || e.signedOut || e.status >= 500) {
        out.push({ kind: "kept", item });
        stop = true; // no point trying the rest now
      } else if (e.code === "CHANGED") {
        if (e.changed?.byId === myUserId) out.push({ kind: "sent", item });
        else out.push({ kind: "theirs", item, by: e.changed?.by ?? null, at: e.changed?.at ?? null });
      } else {
        out.push({ kind: "refused", item, message: e.message });
      }
    }
  }
  return out;
}

/** Sends this login's waiting saves and keeps only those still waiting. */
export async function flush(accountId: string, send: (s: AttendanceSave) => Promise<unknown>, myUserId: number) {
  const items = await read(accountId);
  if (!items.length) return [];
  const out = await sendAll(items, send, myUserId);
  // a save queued while sending is not lost: keep what is still waiting plus anything new
  const done = new Set(out.filter((o) => o.kind !== "kept").map((o) => slot(o.item.save) + "@" + o.item.queuedAt));
  const now = await read(accountId);
  await write(accountId, now.filter((q) => !done.has(slot(q.save) + "@" + q.queuedAt)));
  return out;
}
