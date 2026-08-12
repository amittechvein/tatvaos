// ============================================================================
//  Organisation storage
// ============================================================================
//
//  The console's view of the pool: what was bought, what is used, how it is
//  split between products, and which mailboxes are heaviest.
//
//  Thresholds are NOT defined here. The API returns isWarning and isCritical,
//  and the same flags decide whether another user can be added — so the page
//  shows whatever the gate is enforcing rather than a second opinion.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface StorageProduct {
  productCode: string;
  productName: string;
  /** null means "draw from whatever is left in the pool". */
  allocatedBytes: number | null;
  usedBytes: number;
  usedFraction: number;
}

export interface OrgStorage {
  storageModel: 'per_user' | 'pooled';
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedFraction: number;
  isWarning: boolean;
  isCritical: boolean;
  userCount: number;
  maxUsers: number | null;
  canAddUser: boolean;
  /** A ready-to-display sentence when canAddUser is false. Shown verbatim. */
  reason: string | null;
  perUserQuotaBytes: number | null;
  products: StorageProduct[];
}

export interface MailboxUsage {
  /** null for a shared mailbox — there is no person behind it. */
  userId: string | null;
  address: string;
  displayName: string | null;
  isShared: boolean;
  usedBytes: number;
  quotaBytes: number;
  usedFraction: number;
}

/** Carries the headroom the server reports when an allocation over-commits. */
export class AllocationError extends Error {
  readonly availableBytes?: number;

  constructor(message: string, availableBytes?: number) {
    super(message);
    this.name = 'AllocationError';
    this.availableBytes = availableBytes;
  }
}

export async function fetchOrgStorage(authedFetch: AuthedFetch): Promise<OrgStorage> {
  const res = await authedFetch('/org/storage');
  if (!res.ok) throw new Error('Could not load storage.');
  return res.json();
}

/** Heaviest first — the server sorts it, and the order is the point. */
export async function fetchMailboxUsage(authedFetch: AuthedFetch): Promise<MailboxUsage[]> {
  const res = await authedFetch('/org/storage/users');
  if (!res.ok) throw new Error('Could not load mailbox usage.');
  return res.json();
}

/**
 * Set a product's allocation, or pass null to draw from the pool.
 *
 * The two 400s — over-committing the pool, and allocating less than the product
 * already holds — come back with a sentence worth reading, so it is surfaced
 * unchanged rather than replaced with a generic failure.
 */
export async function setAllocation(
  authedFetch: AuthedFetch,
  productCode: string,
  allocatedBytes: number | null,
): Promise<void> {
  const res = await authedFetch(`/org/storage/allocations/${productCode}`, {
    method: 'PUT',
    body: JSON.stringify({ allocatedBytes }),
  });
  if (res.ok) return;

  const body = await res.json().catch(() => ({}));
  throw new AllocationError(
    typeof body.error === 'string' && body.error ? body.error : 'Could not change the allocation.',
    typeof body.availableBytes === 'number' ? body.availableBytes : undefined,
  );
}
