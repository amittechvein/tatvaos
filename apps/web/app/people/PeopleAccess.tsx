'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';

// ============================================================================
//  What the signed-in person is in People — asked once, shared by every page.
//
//  This only decides what to SHOW. The API checks every call itself
//  (Modules/People/PeopleAccess.cs): HR sees everyone; anyone else themselves
//  and the people below them through "reports to" — never a role (0018 §3).
// ============================================================================

export interface Employee {
  id: string;
  employeeCode: string;
  userId: string | null;
  fullName: string;
  workEmail: string | null;
  departmentId: string | null;
  designationId: string | null;
  locationId: string | null;
  reportsTo: string | null;
  employmentType: 'full_time' | 'part_time' | 'contract' | 'intern';
  status: 'active' | 'on_notice' | 'exited';
  joinedOn: string;
  exitOn: string | null;
}

export interface PeopleMe {
  isHr: boolean;
  canNameHr: boolean;
  employee: Employee | null;
  directReports: number;
  /** The staff directory: everyone by default, People HR only if the organisation says so. */
  canSeeDirectory: boolean;
}

const Ctx = createContext<{ me: PeopleMe; reload: () => Promise<void> } | null>(null);

export function usePeopleAccess() {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePeopleAccess outside PeopleAccessProvider');
  return v;
}

export const TYPE_LABEL: Record<Employee['employmentType'], string> = {
  full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern',
};
export const STATUS_LABEL: Record<Employee['status'], string> = {
  active: 'Active', on_notice: 'On notice', exited: 'Left',
};

/**
 * Loads /people/me. `denied` is for someone with nothing to see here: not
 * HR, no employee record, and not an administrator (who could name
 * themselves HR). Anything but a clear answer counts as denied — failing
 * closed shows a sentence; failing open would show pages of 403s.
 */
export function PeopleAccessProvider({ children, loading, denied }: {
  children: (me: PeopleMe) => React.ReactNode;
  loading: React.ReactNode;
  denied: React.ReactNode;
}) {
  const { authedFetch } = useAuth();
  const [me, setMe] = useState<PeopleMe | null>(null);

  const reload = useCallback(async () => {
    const res = await authedFetch('/people/me');
    setMe(res.ok ? await res.json() : { isHr: false, canNameHr: false, employee: null, directReports: 0, canSeeDirectory: false });
  }, [authedFetch]);

  useEffect(() => { void reload(); }, [reload]);

  if (!me) return <>{loading}</>;
  if (!me.isHr && !me.canNameHr && !me.employee && !me.canSeeDirectory) return <>{denied}</>;
  return <Ctx.Provider value={{ me, reload }}>{children(me)}</Ctx.Provider>;
}
