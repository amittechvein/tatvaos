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
  adminName: string | null;
  phone: string | null;
  gstin: string | null;
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

/**
 * The product catalogue — core.products, served by the API.
 *
 * The plans screen used to carry its own copy of this list. It drifted twice,
 * and the second drift made Connect ungrantable from the console entirely.
 * A screen that must agree with a table should read the table.
 */
export interface ProductRow {
  code: string;
  name: string;
  description: string | null;
  isAvailable: boolean;
  sortOrder: number;
}

export async function fetchProducts(authedFetch: AuthedFetch): Promise<ProductRow[]> {
  const res = await authedFetch('/admin/products');
  if (!res.ok) throw new Error('Could not load the product catalogue.');
  return res.json();
}

// ---------------------------------------------------------------------------
//  Plan management (super-admin). The request shape below is the API's
//  UpsertPlanRequest: storage is in BYTES (the form collects GB and multiplies
//  by 1024³), and the two storage fields are mutually exclusive — the one that
//  does not match storageModel is sent null and ignored by the server.
// ---------------------------------------------------------------------------
export interface UpsertPlanBody {
  name: string;
  maxUsers?: number | null;
  storageModel: 'per_user' | 'pooled';
  perUserQuotaBytes?: number | null;
  pooledStorageBytes?: number | null;
  maxDomains?: number | null;
  includedProducts?: string[];
  pricePerUserMonthly?: number | null;
  priceMonthly?: number | null;
}

// Surfaces the server's own { error } text when present (the DELETE-in-use case
// returns a message telling the admin to move organisations off first), falling
// back to a generic line only when the body carries nothing useful.
async function planError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return (body && typeof body.error === 'string' && body.error) || fallback;
  } catch {
    return fallback;
  }
}

export async function createPlan(
  authedFetch: AuthedFetch,
  body: UpsertPlanBody,
): Promise<{ id: string; name: string }> {
  const res = await authedFetch('/admin/plans', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await planError(res, 'Could not create the plan.'));
  return res.json();
}

export async function updatePlan(
  authedFetch: AuthedFetch,
  id: string,
  body: UpsertPlanBody,
): Promise<{ id: string; name: string }> {
  const res = await authedFetch(`/admin/plans/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await planError(res, 'Could not save the plan.'));
  return res.json();
}

export async function deletePlan(authedFetch: AuthedFetch, id: string): Promise<void> {
  const res = await authedFetch(`/admin/plans/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await planError(res, 'Could not delete the plan — it may be in use.'));
}
