// ============================================================================
//  Audit trail
// ============================================================================
//
//  The trail has been written from twenty-nine places since the beginning and
//  read from none. This is the read side.
//
//  PAGING IS BY CURSOR, NOT BY PAGE NUMBER. The trail grows while it is being
//  read, so an offset-based page two shows a row twice or skips one as new
//  entries land above it. `nextBefore` is the last id seen; passing it back
//  continues exactly where the previous page stopped. That is also why the UI
//  offers "load more" rather than numbered pages — there is no stable page N.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface AuditEntry {
  id: number;
  occurredAt: string;
  /** Dotted, e.g. "user.suspended". Platform actions are prefixed "platform:". */
  action: string;
  productCode: string | null;
  actorUserId: string | null;
  /** Null when the actor was deleted, or when the platform itself acted. */
  actorName: string | null;
  actorEmail: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  /** True when before/after state was recorded — drives the expand affordance. */
  hasDetail: boolean;
  beforeState: string | null;
  afterState: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass as `before` for the next page. Null means this is the last one. */
  nextBefore: number | null;
  hasMore: boolean;
}

export interface AuditQuery {
  /** Prefix match: "user." finds every user.* action. */
  action?: string;
  targetType?: string;
  actorUserId?: string;
  /** Inclusive. */
  from?: string;
  /** Exclusive, so a single-day range does not swallow the next midnight. */
  to?: string;
  before?: number;
  limit?: number;
}

export async function fetchAudit(
  authedFetch: AuthedFetch, q: AuditQuery = {},
): Promise<AuditPage> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }

  const suffix = params.toString();
  const res = await authedFetch(`/org/audit${suffix ? `?${suffix}` : ''}`);
  if (!res.ok) throw new Error('Could not load the audit trail.');
  return res.json();
}

/** The actions this organisation has actually recorded, for the filter. */
export async function fetchAuditActions(authedFetch: AuthedFetch): Promise<string[]> {
  const res = await authedFetch('/org/audit/actions');
  if (!res.ok) return [];
  return res.json();
}

// ---------------------------------------------------------------------------
//  Presentation helpers
// ---------------------------------------------------------------------------

/**
 * "user.suspended" → "User suspended".
 *
 * Derived rather than looked up in a map ON PURPOSE: a hardcoded label table
 * silently falls back to a raw key every time an endpoint adds an audit call,
 * and the person reading the trail is the last to find out. Deriving is
 * occasionally less elegant and never stale.
 */
export function humaniseAction(action: string): string {
  const platform = action.startsWith('platform:');
  const bare = platform ? action.slice('platform:'.length) : action;

  const words = bare.replace(/[.:_]/g, ' ').trim();
  const label = words.charAt(0).toUpperCase() + words.slice(1);

  return platform ? `${label} (by Techvein)` : label;
}

/**
 * Actions that change what someone can reach, or that touch a credential.
 *
 * Flagged so they stand out in a wall of routine entries — these are the rows
 * a person scanning the trail after an incident is actually looking for.
 */
export function isSensitive(action: string): boolean {
  const a = action.replace(/^platform:/, '');
  return a.startsWith('user.password')
      || a.startsWith('user.suspended')
      || a.startsWith('user.deleted')
      || a.startsWith('user.role')
      || a.includes('.reset')
      || a.startsWith('org.suspended')
      || a.startsWith('settings.');
}

/** Pretty-print a recorded JSON state blob, falling back to the raw string. */
export function formatState(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
