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
  /**
   * 'personal' (20260926-z-personal-plans.sql): held by one person in the
   * personal house, limits ENFORCED. Never offered to an organisation — the
   * API refuses it too.
   */
  audience?: 'organisation' | 'personal';
  maxUsers: number | null;
  storageModel: string;
  perUserQuotaBytes: number | null;
  pooledStorageBytes: number | null;
  maxDomains: number | null;
  includedProducts: string[];
  pricePerUserMonthly: number | null;
  priceMonthly: number | null;
  /** Yearly prices (billing, 26 Sept 2026). null = 12 x monthly. */
  pricePerUserYearly?: number | null;
  priceYearly?: number | null;
  /** AI credits (26 Sept 2026): per user × users, or one pool. Null amount = no limit. */
  aiCreditModel?: string;
  aiCreditsPerUser?: number | null;
  aiCreditsPooled?: number | null;
  /** null = every feature of the included modules (the meaning before 26 Sept). */
  includedFeatures: string[] | null;
  /** Limit feature code -> number. Missing = no limit. */
  featureLimits: Record<string, number>;
}

/** core.features — one feature inside a module. productCode null = platform-wide. */
export interface FeatureRow {
  code: string;
  productCode: string | null;
  name: string;
  description: string | null;
  kind: 'switch' | 'limit';
  unit: string | null;
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
  pricePerUserYearly?: number | null;
  priceYearly?: number | null;
  aiCreditModel?: 'per_user' | 'pooled';
  aiCreditsPerUser?: number | null;
  aiCreditsPooled?: number | null;
  includedFeatures?: string[];
  allFeatures?: boolean;
  featureLimits?: Record<string, number>;
}

export async function fetchFeatures(authedFetch: AuthedFetch): Promise<FeatureRow[]> {
  const res = await authedFetch('/admin/features');
  if (!res.ok) throw new Error('Could not load the feature catalogue.');
  return res.json();
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

// ---------------------------------------------------------------------------
//  One organisation's plan, feature by feature (26 Sept 2026). Warn first:
//  nothing here stops anything.
// ---------------------------------------------------------------------------
export interface FeatureState {
  code: string; productCode: string | null; name: string; description: string | null;
  kind: 'switch' | 'limit'; unit: string | null;
  included: boolean; limit: number | null;
  /** plan | keeps everything | override: granted | override: held | override | not in plan | module not in plan | no plan | plan (no limit) */
  source: string;
  overrideId: string | null; overrideExpiresAt: string | null;
}

export interface PlanWarning { code: string; level: 'not_in_plan' | 'over' | 'near'; message: string }

export interface FeatureOverrideRow {
  id: string; featureCode: string; mode: 'grant' | 'revoke' | 'limit'; limitValue: number | null;
  expiresAt: string | null; reason: string; createdAt: string; withdrawnAt: string | null;
  grantedBy: string | null;
}

export interface OrgPlan {
  entitlements: {
    keepsEverything: boolean; planId: string | null; planName: string | null;
    planProducts: string[]; planListsFeatures: boolean; features: FeatureState[];
  };
  warnings: PlanWarning[];
  overrides: FeatureOverrideRow[];
}

async function orgError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return (body && typeof body.error === 'string' && body.error) || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchOrgPlan(authedFetch: AuthedFetch, id: string): Promise<OrgPlan> {
  const res = await authedFetch(`/admin/organisations/${id}/plan`);
  if (!res.ok) throw new Error('Could not load this organisation’s plan.');
  return res.json();
}

export async function createFeatureOverride(
  authedFetch: AuthedFetch, id: string,
  body: { featureCode: string; mode: 'grant' | 'revoke' | 'limit'; limitValue?: number | null; expiresAt?: string | null; reason: string },
): Promise<void> {
  const res = await authedFetch(`/admin/organisations/${id}/feature-overrides`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await orgError(res, 'Could not save the exception.'));
}

export async function withdrawFeatureOverride(authedFetch: AuthedFetch, id: string, overrideId: string): Promise<void> {
  const res = await authedFetch(`/admin/organisations/${id}/feature-overrides/${overrideId}/withdraw`, { method: 'POST' });
  if (!res.ok) throw new Error(await orgError(res, 'Could not withdraw the exception.'));
}

export async function setKeepsEverything(
  authedFetch: AuthedFetch, id: string, keepsEverything: boolean, reason: string,
): Promise<void> {
  const res = await authedFetch(`/admin/organisations/${id}/keeps-everything`, {
    method: 'PUT', body: JSON.stringify({ keepsEverything, reason }),
  });
  if (!res.ok) throw new Error(await orgError(res, 'Could not change this.'));
}

export interface PlanWarningsSummary {
  organisations: { id: string; name: string; planName: string | null; warnings: PlanWarning[] }[];
  keepEverything: number;
}

export async function fetchPlanWarnings(authedFetch: AuthedFetch): Promise<PlanWarningsSummary> {
  const res = await authedFetch('/admin/plan-warnings');
  if (!res.ok) throw new Error('Could not load plan warnings.');
  return res.json();
}

// ---------------------------------------------------------------------------
//  Deleting an organisation for good. The rules are the database's
//  (local/postgres/init/20260929-organisation-deletions.sql); these only ask.
// ---------------------------------------------------------------------------

export interface DeletionPreview {
  org: { id: string; name: string; status: string; kind: string; createdAt: string; suspendedAt: string | null };
  canDelete: boolean;
  blockers: { code: string; reason: string }[];
  counts: {
    people: number; domains: number; mailboxes: number; messages: number;
    meetings: number; recordings: number; files: number; documents: number; rowsInAll: number;
  };
  /** "schema.table.column" → rows. Everything that names the organisation. */
  tables: Record<string, number>;
  domains: string[];
  /** Domains whose mail folder is on the server. These are NOT removed. */
  mailFolders: string[];
  /** False: the mail store could not be looked at; mailFolders is every domain, out of caution. */
  mailStoreSeen: boolean;
  spaceFolderOnDisk: boolean;
}

export interface DeletedFiles {
  space?: { files: number; bytes: number; removed: boolean };
  recordings?: { listed: number; removed: number; alreadyGone: number; failed: number };
  dkimKeys?: { removed: number };
  errors?: string[];
  error?: string;
}

export interface OrganisationDeletion {
  id: string;
  organisationId: string;
  name: string;
  type: string | null;
  origin: string | null;
  organisationCreatedAt: string | null;
  domains: string[];
  counts: Record<string, number>;
  reason: string | null;
  deletedBy: string;
  deletedAt: string;
  recordingFiles: number;
  filesRemoved: DeletedFiles | null;
  filesRemovedAt: string | null;
  mailFolders: string[];
  /** Folders the mail server has removed so far, one domain at a time. */
  mailFoldersRemoved: string[];
  mailFoldersRemovedAt: string | null;
}

export async function fetchDeletionPreview(authedFetch: AuthedFetch, id: string): Promise<DeletionPreview> {
  const res = await authedFetch(`/admin/organisations/${id}/deletion-preview`);
  if (!res.ok) throw new Error(await orgError(res, 'Could not work out what would be deleted.'));
  return res.json();
}

export async function deleteOrganisation(
  authedFetch: AuthedFetch, id: string, typedName: string, reason: string,
): Promise<{ deleted: boolean; record: string; name: string; mailFoldersLeft: string[]; files: DeletedFiles | null }> {
  const res = await authedFetch(`/admin/organisations/${id}/delete`, {
    method: 'POST', body: JSON.stringify({ typedName, reason }),
  });
  if (!res.ok) throw new Error(await orgError(res, 'The organisation was not deleted.'));
  return res.json();
}

export async function fetchOrganisationDeletions(authedFetch: AuthedFetch): Promise<OrganisationDeletion[]> {
  const res = await authedFetch('/admin/organisation-deletions');
  if (!res.ok) throw new Error('Could not load the deleted organisations.');
  return res.json();
}

export async function removeDeletedFiles(authedFetch: AuthedFetch, recordId: string): Promise<DeletedFiles> {
  const res = await authedFetch(`/admin/organisation-deletions/${recordId}/remove-files`, { method: 'POST' });
  if (!res.ok) throw new Error(await orgError(res, 'The files could not be removed.'));
  return (await res.json()).files;
}
