// Data for the active login. Every query key starts with the login's id, so one child's data is
// never shown for another, and signing out can drop exactly that login's copies.
//
// Read screens keep an offline copy (core/offline.ts): when a call fails for lack of connection,
// the last copy is shown instead and `offlineAt` says when it was taken.

import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { api, ApiError } from "./api";
import { useAccounts } from "./accounts";
import * as Offline from "./offline";

// when each query last answered from its offline copy (absent: it answered live)
const offlineSince = new Map<string, number>();
const mapKey = (parts: unknown[]) => JSON.stringify(parts);

async function liveOrCopy<T>(id: string, name: string, extra: unknown[], fetch: () => Promise<T>): Promise<T> {
  const k = mapKey([id, name, ...extra]);
  try {
    const data = await fetch();
    offlineSince.delete(k);
    Offline.save(id, name, extra, data);
    return data;
  } catch (e) {
    if (e instanceof ApiError && e.offline) {
      const copy = await Offline.load<T>(id, name, extra);
      if (copy) {
        offlineSince.set(k, copy.at);
        return copy.data;
      }
    }
    throw e;
  }
}

export function useActive() {
  const { active, token } = useAccounts();
  return { active, token, host: active?.school.host ?? "", id: active?.id ?? "none" };
}

/** A call for the active login. A 401 means the token ended (expired, signed out elsewhere, password changed). */
export function useMe<T>(name: string, fn: (host: string, token: string) => Promise<T>, extraKey: unknown[] = [], enabled = true) {
  const { host, token, id } = useActive();
  const { signOut } = useAccounts();
  const q = useQuery({
    queryKey: [id, name, ...extraKey],
    queryFn: () => liveOrCopy(id, name, extraKey, () => fn(host, token!)),
    enabled: enabled && !!token,
  });
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.signedOut) {
      signOut(id).then(() => router.replace("/"));
    }
  }, [q.error, id, signOut]);
  return { ...q, offlineAt: q.data !== undefined ? offlineSince.get(mapKey([id, name, ...extraKey])) : undefined };
}

export function useBoot() {
  return useMe("bootstrap", api.bootstrap);
}

/** Drop every cached copy of one login (sign-out deletes the cache: SRS section 8, Offline). */
export function useForget() {
  const qc = useQueryClient();
  return (id: string) => qc.removeQueries({ queryKey: [id] });
}

/** A paged list for the active login (B-07 lists: pass `next` back as the cursor until it is null).
 *  Only the first page keeps an offline copy. */
export function useMePages<T>(name: string, fn: (host: string, token: string, cursor?: string) => Promise<{ items: T[]; next: string | null }>, enabled = true) {
  const { host, token, id } = useActive();
  const q = useInfiniteQuery({
    queryKey: [id, name],
    queryFn: ({ pageParam }) => (pageParam === undefined ? liveOrCopy(id, name, [], () => fn(host, token!)) : fn(host, token!, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: enabled && !!token,
  });
  return { ...q, offlineAt: q.data ? offlineSince.get(mapKey([id, name])) : undefined };
}
