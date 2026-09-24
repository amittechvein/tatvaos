'use client';

import { createContext, useContext, useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';

// ============================================================================
//  What the signed-in person is in Hire — asked once, shared by every page.
//
//  This only decides what to SHOW. The API checks every call itself
//  (Modules/Hire/HireAccess.cs); a page that forgot to hide a button would
//  get a 403 or 404 back, not access.
// ============================================================================

export type HireAccessLevel = 'admin' | 'recruiter' | 'hiring_manager' | 'none';

export interface HireMe {
  access: HireAccessLevel;
  canManageTeam: boolean;
  canSeeAllJobs: boolean;
}

const Ctx = createContext<HireMe | null>(null);

export function useHireAccess(): HireMe {
  const me = useContext(Ctx);
  if (!me) throw new Error('useHireAccess outside HireAccessProvider');
  return me;
}

/** Loads /hire/me; renders `loading` until it knows, `denied` for none. */
export function HireAccessProvider({ children, loading, denied }: {
  children: (me: HireMe) => React.ReactNode;
  loading: React.ReactNode;
  denied: React.ReactNode;
}) {
  const { authedFetch } = useAuth();
  const [me, setMe] = useState<HireMe | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await authedFetch('/hire/me');
      // Anything but a clear answer is treated as no access: failing closed
      // shows a "not on the team" page, failing open would show screens full
      // of 403s.
      setMe(res.ok ? await res.json() : { access: 'none', canManageTeam: false, canSeeAllJobs: false });
    })();
  }, [authedFetch]);

  if (!me) return <>{loading}</>;
  if (me.access === 'none') return <>{denied}</>;
  return <Ctx.Provider value={me}>{children(me)}</Ctx.Provider>;
}
