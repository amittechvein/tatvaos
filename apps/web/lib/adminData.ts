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
  /** AI credits (26 Sept 2026): per user × users, or one pool. Null amount = no limit. */
  aiCreditModel?: string;
  aiCreditsPerUser?: number | null;
  aiCreditsPooled?: number | null;
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
  aiCreditModel?: 'per_user' | 'pooled';
  aiCreditsPerUser?: number | null;
  aiCreditsPooled?: number | null;
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

// ---------------------------------------------------------------------------
//  One organisation's detail page (26 Sept 2026). Addresses, names, sizes and
//  dates — never mail content. Both reads are audited server-side.
// ---------------------------------------------------------------------------
export interface OrgOverview {
  org: {
    id: string; name: string; type: string; status: string;
    createdAt: string; trialEndsAt: string | null; suspendedAt: string | null;
  };
  counts: {
    users: number; activeUsers: number; suspendedUsers: number;
    neverSignedIn: number; signedInLast30Days: number; admins: number; twoStepOn: number;
    personalMailboxes: number; sharedMailboxes: number; groupMailboxes: number;
    inactiveMailboxes: number; aliases: number; mailUsedBytes: number;
    domains: number; verifiedDomains: number;
    orgApiKeys: number; mailApiKeys: number; ssoApps: number;
  };
  domains: {
    id: string; fqdn: string; type: string; isActive: boolean; isPlatform: boolean;
    verificationMethod: string | null; createdAt: string; ownershipVerifiedAt: string | null;
    /** null for our own platform subdomains, whose DNS we manage. */
    checks: { mx: boolean; spf: boolean; dkim: boolean; dmarc: boolean } | null;
    dmarcPolicy: string; lastCheckedAt: string | null; lastCheckResult: string | null;
    mailboxCount: number;
  }[];
  sharedMailboxes: {
    id: string; address: string; displayName: string | null; isActive: boolean;
    quotaBytes: number; usedBytes: number; createdAt: string;
    access: { name: string; email: string; permission: string }[];
  }[];
}

export interface OrgMailbox {
  id: string; address: string; type: 'user' | 'shared' | 'group'; isActive: boolean;
  quotaBytes: number; usedBytes: number; createdAt: string;
  name: string | null;
  person: { id: string; role: string; status: string; lastLoginAt: string | null; mfaEnabled: boolean } | null;
  retained: boolean;
  aliases: string[];
}

export interface OrgMailboxPage { total: number; offset: number; limit: number; items: OrgMailbox[] }

export interface OrgAiUsage {
  from: string; tokens: number; requests: number; refused: number;
  ceilingTokens: number | null; perPersonPerHour: number | null; paused: boolean;
  percentOfCeiling: number;
  byFeature: { feature: string; requests: number; tokens: number }[];
}

export async function fetchOrgOverview(authedFetch: AuthedFetch, id: string): Promise<OrgOverview> {
  const res = await authedFetch(`/admin/organisations/${id}/overview`);
  if (res.status === 404) throw new Error('That organisation does not exist.');
  if (!res.ok) throw new Error('Could not load this organisation.');
  return res.json();
}

export async function fetchOrgMailboxes(
  authedFetch: AuthedFetch,
  id: string,
  opts: { q?: string; type?: string; status?: string; offset?: number; limit?: number },
): Promise<OrgMailboxPage> {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', opts.q);
  if (opts.type) p.set('type', opts.type);
  if (opts.status) p.set('status', opts.status);
  if (opts.offset) p.set('offset', String(opts.offset));
  if (opts.limit) p.set('limit', String(opts.limit));
  const res = await authedFetch(`/admin/organisations/${id}/mailboxes?${p}`);
  if (!res.ok) throw new Error('Could not load mail IDs.');
  return res.json();
}

export async function fetchOrgAiUsage(authedFetch: AuthedFetch, id: string): Promise<OrgAiUsage> {
  const res = await authedFetch(`/admin/organisations/${id}/ai-usage`);
  if (!res.ok) throw new Error('Could not load AI usage.');
  return res.json();
}
