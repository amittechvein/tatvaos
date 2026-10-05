'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { avatarObjectUrl, onAvatarChange } from '@/lib/avatars';

/**
 * "Does this person have a photo?" — for screens that know people by EMAIL
 * (Mail, Contacts) or by USER ID (Connect), not by a row from the people list.
 *
 * ── WHY ────────────────────────────────────────────────────────────────
 *  Amit, 25 Sept 2026: "if any user photo updated in tatvaos app show photo
 *  in all apps like email and connect people section". Until then a photo
 *  showed only where a user row (with hasAvatar) was to hand — the admin
 *  People page, the header, the account menu. Everywhere else drew initials.
 *
 * ── ONE REQUEST, NOT FIFTY ─────────────────────────────────────────────
 *  A mail list asks about fifty senders at once. Asks made within BATCH_MS
 *  of each other go to POST /org/users/photos together, 200 at a time. The
 *  answer lists only COLLEAGUES WITH A PHOTO; anybody not in it — someone
 *  outside the organisation, a shared mailbox, a colleague with no photo —
 *  is drawn with initials. The server decides who is a colleague, by tenant.
 *
 * ── UPDATES ────────────────────────────────────────────────────────────
 *  Each answer carries the photo's version and is kept TTL_MS, so a
 *  colleague's new photo reaches your open tabs within that time, without a
 *  reload. Your OWN change reaches this tab at once: bustAvatar() fires
 *  onAvatarChange, and the answers for that person are dropped here first.
 *
 *  Signed out (a guest in a meeting) nothing is asked: the endpoint is for
 *  members, and a guest sees initials.
 */

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface PhotoRef { userId: string; v: number }

const TTL_MS = 5 * 60_000;
/** A failed lookup is retried sooner than a successful one is refreshed. */
const FAILED_TTL_MS = 30_000;
const BATCH_MS = 25;
const CHUNK = 200;

interface Entry { at: number; ttl: number; p: Promise<PhotoRef | null> }
const byEmail = new Map<string, Entry>();
const byUser = new Map<string, Entry>();
/** userId -> addresses resolved to them, so forgetting a person clears both maps. */
const addressesOf = new Map<string, Set<string>>();

let queuedEmails = new Map<string, (r: PhotoRef | null) => void>();
let queuedUsers = new Map<string, (r: PhotoRef | null) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let fetcher: AuthedFetch | null = null;

function fresh(e: Entry | undefined): e is Entry {
  return !!e && Date.now() - e.at < e.ttl;
}

function schedule(f: AuthedFetch) {
  fetcher = f;
  if (!timer) timer = setTimeout(() => { void flush(); }, BATCH_MS);
}

async function flush() {
  timer = null;
  const emails = queuedEmails; queuedEmails = new Map();
  const users = queuedUsers; queuedUsers = new Map();
  const f = fetcher;
  const E = [...emails.keys()];
  const U = [...users.keys()];

  for (let i = 0; i < Math.max(E.length, U.length); i += CHUNK) {
    const eChunk = E.slice(i, i + CHUNK);
    const uChunk = U.slice(i, i + CHUNK);
    let people: Array<{ email?: string; userId: string; v: number }> | null = null;
    try {
      if (!f) throw new Error('no session');
      const r = await f('/org/users/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: eChunk, userIds: uChunk }),
      });
      if (r.ok) people = ((await r.json()) as { people?: typeof people }).people ?? [];
    } catch { people = null; }

    const failed = people === null;
    const hitEmail = new Map<string, PhotoRef>();
    const hitUser = new Map<string, PhotoRef>();
    for (const p of people ?? []) {
      const ref = { userId: p.userId, v: p.v };
      if (p.email) {
        hitEmail.set(p.email, ref);
        if (!addressesOf.has(p.userId)) addressesOf.set(p.userId, new Set());
        addressesOf.get(p.userId)!.add(p.email);
      } else {
        hitUser.set(p.userId, ref);
      }
    }
    for (const e of eChunk) {
      if (failed) { const x = byEmail.get(e); if (x) x.ttl = FAILED_TTL_MS; }
      emails.get(e)?.(hitEmail.get(e) ?? null);
    }
    for (const u of uChunk) {
      if (failed) { const x = byUser.get(u); if (x) x.ttl = FAILED_TTL_MS; }
      users.get(u)?.(hitUser.get(u) ?? null);
    }
  }
}

export function photoForEmail(f: AuthedFetch, email: string): Promise<PhotoRef | null> {
  const key = email.trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  const hit = byEmail.get(key);
  if (fresh(hit)) return hit.p;
  const p = new Promise<PhotoRef | null>((resolve) => queuedEmails.set(key, resolve));
  byEmail.set(key, { at: Date.now(), ttl: TTL_MS, p });
  schedule(f);
  return p;
}

export function photoForUser(f: AuthedFetch, userId: string): Promise<PhotoRef | null> {
  if (!userId) return Promise.resolve(null);
  const hit = byUser.get(userId);
  if (fresh(hit)) return hit.p;
  const p = new Promise<PhotoRef | null>((resolve) => queuedUsers.set(userId, resolve));
  byUser.set(userId, { at: Date.now(), ttl: TTL_MS, p });
  schedule(f);
  return p;
}

/** Drop every answer about this person — their photo just changed here. */
export function forgetPhoto(userId: string) {
  byUser.delete(userId);
  for (const a of addressesOf.get(userId) ?? []) byEmail.delete(a);
  addressesOf.delete(userId);
}

// Registered at import, before any component subscribes, so the answers are
// gone by the time a component re-asks in response to the same event.
if (typeof window !== 'undefined') onAvatarChange(forgetPhoto);

/**
 * The photo for a person, as an object URL — or null, meaning "draw
 * initials". Pass whichever the screen has: an email address, or a user id.
 */
export function usePhotoUrl(who: { email?: string | null; userId?: string | null }): string | null {
  const { user, authedFetch } = useAuth();
  const email = who.email?.trim().toLowerCase() || null;
  const userId = who.userId || null;
  const key = userId ? `u:${userId}` : email ? `e:${email}` : '';
  // The URL is kept WITH the key it was fetched for. A list row that React
  // reuses for a different person must not show the previous person's photo
  // for the moment until the new answer arrives.
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: '', url: null });
  const [tick, setTick] = useState(0);

  useEffect(() => onAvatarChange(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    if (!user || !key) return;
    let alive = true;
    (userId ? photoForUser(authedFetch, userId) : photoForEmail(authedFetch, email!))
      .then((ref) => (ref ? avatarObjectUrl(authedFetch, ref.userId, ref.v) : null))
      .then((url) => { if (alive) setState({ key, url }); });
    return () => { alive = false; };
  }, [user, authedFetch, key, userId, email, tick]);

  return state.key === key ? state.url : null;
}

/**
 * usePhotoUrl for a whole list at once: user id -> object URL, for those who
 * have a photo. For code that builds plain data in a loop and cannot call a
 * hook per person — the picture-in-picture window (lib/pip.ts), which lives in
 * a separate document and was drawing initials only (Amit, 26 Sept 2026).
 * The lookups still batch into one request, as for usePhotoUrl.
 */
export function usePhotoUrls(userIds: readonly string[]): Record<string, string> {
  const { user, authedFetch } = useAuth();
  // A string, so a new array with the same people does not re-run the lookup.
  const key = [...new Set(userIds.filter(Boolean))].sort().join(',');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => onAvatarChange(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    if (!user || !key) { setUrls({}); return; }
    let alive = true;
    const ids = key.split(',');
    void Promise.all(ids.map((id) => photoForUser(authedFetch, id)
      .then((ref) => (ref ? avatarObjectUrl(authedFetch, ref.userId, ref.v) : null))
      .then((url) => [id, url] as const)))
      .then((pairs) => {
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const [id, url] of pairs) if (url) next[id] = url;
        setUrls(next);
      });
    return () => { alive = false; };
  }, [user, authedFetch, key, tick]);

  return urls;
}
