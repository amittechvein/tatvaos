// ============================================================================
//  Real data for the platform console.
//
//  Replaces adminMock for the admin pages. The mocks were compiled into the
//  bundle, so staging showed fictional customers to whoever signed in — which
//  reads as either a broken product or somebody else's data, and both readings
//  are worse than an empty list.
// ============================================================================

export interface OrgRow {
  id: string;
  name: string;
  type: string;
  status: string;
  primaryDomain: string;
  storageModel: string;
  maxUsers: number | null;
  userCount: number;
  storageTotalBytes: number;
  storageUsedBytes: number;
  domainCount: number;
  adminEmail: string | null;
  createdAt: string;
  trialEndsAt: string | null;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  seats: number | null;
}

export interface PlanRow {
  id: string;
  name: string;
  maxUsers: number | null;
  storageModel: string;
  perUserQuotaBytes: number | null;
  pooledStorageBytes: number | null;
  maxDomains: number | null;
  includedProducts: string[];
  pricePerUserMonthly: number | null;
  priceMonthly: number | null;
}

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function fetchOrganisations(authedFetch: AuthedFetch): Promise<OrgRow[]> {
  const res = await authedFetch('/admin/organisations');
  if (!res.ok) throw new Error('Could not load organisations.');
  return res.json();
}

export async function fetchPlans(authedFetch: AuthedFetch): Promise<PlanRow[]> {
  const res = await authedFetch('/admin/plans');
  if (!res.ok) throw new Error('Could not load plans.');
  return res.json();
}
