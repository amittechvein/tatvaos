// Data for the active login. Every query key starts with the login's id, so one child's data is
// never shown for another, and signing out can drop exactly that login's copies.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { api, ApiError } from "./api";
import { useAccounts } from "./accounts";

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
    queryFn: () => fn(host, token!),
    enabled: enabled && !!token,
  });
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.signedOut) {
      signOut(id).then(() => router.replace("/"));
    }
  }, [q.error, id, signOut]);
  return q;
}

export function useBoot() {
  return useMe("bootstrap", api.bootstrap);
}

/** Drop every cached copy of one login (sign-out deletes the cache: SRS section 8, Offline). */
export function useForget() {
  const qc = useQueryClient();
  return (id: string) => qc.removeQueries({ queryKey: [id] });
}
