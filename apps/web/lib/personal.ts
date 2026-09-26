// ============================================================================
//  Personal accounts — the plan, the AI switch, and "is this one personal?"
// ============================================================================
//
//  Build plan personal-plans-build-plan.md §4. Everything here READS what the
//  server decides (GET /api/me/plan, /api/me/ai); nothing is decided in the
//  browser. A personal account sees its plan on the Account page and a
//  shorter launcher; the server refuses the rest regardless (PersonalGuard).
// ============================================================================

import { useEffect, useState } from 'react';

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface PlanFeature {
  code: string;
  kind: 'switch' | 'limit';
  unit: string | null;
  included: boolean;
  /** null = no limit */
  limit: number | null;
  /** 'plan' | 'trial' | 'not in plan' | ... */
  source: string;
}

export interface MyPlan {
  planId: string | null;
  planName: string | null;
  personal: boolean;
  /** True = these are hard limits. False = an organisation's plan (warnings only). */
  enforced: boolean;
  storageBytes: number | null;
  aiTrial: { startedAt: string; endsAt: string; active: boolean; daysLeft: number } | null;
  features: PlanFeature[];
}

export interface MyAi {
  enabled: boolean;
  confirmed: boolean;
  /** The plan includes AI minutes right now (Premium, or a running trial). */
  included: boolean;
  confirmSentence: string;
  trial: { startedAt: string; endsAt: string; active: boolean; daysLeft: number } | null;
}

export async function fetchMyPlan(f: AuthedFetch): Promise<MyPlan> {
  const res = await f('/me/plan');
  if (!res.ok) throw new Error('Could not load your plan.');
  return res.json();
}

export async function fetchMyAi(f: AuthedFetch): Promise<MyAi> {
  const res = await f('/me/ai');
  if (!res.ok) throw new Error('Could not load your AI setting.');
  return res.json();
}

/** Throws with the server's sentence when refused. */
export async function setMyAi(f: AuthedFetch, on: boolean, confirm: boolean): Promise<MyAi> {
  const res = await f('/me/ai', { method: 'PUT', body: JSON.stringify({ on, confirm }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not change the AI setting.');
  return body as MyAi;
}

export function feature(plan: MyPlan, code: string): PlanFeature | undefined {
  return plan.features.find((x) => x.code === code);
}

/**
 * Is the signed-in account a personal one? null while unknown. One request
 * per page load, shared by every caller on the page through the promise.
 */
let known: Promise<boolean> | null = null;
let knownFor: string | null = null;

export function usePersonal(authedFetch: AuthedFetch, userId: string | undefined): boolean | null {
  const [personal, setPersonal] = useState<boolean | null>(null);
  useEffect(() => {
    if (!userId) { setPersonal(null); return; }
    if (!known || knownFor !== userId) {
      knownFor = userId;
      known = fetchMyPlan(authedFetch).then((p) => p.personal).catch(() => false);
    }
    let alive = true;
    known.then((v) => { if (alive) setPersonal(v); });
    return () => { alive = false; };
  }, [authedFetch, userId]);
  return personal;
}
