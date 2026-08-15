// ============================================================================
//  My storage — one allowance, spent across every product
// ============================================================================
//
//  Read by every rail meter and expanded on the account page. The figure is
//  the PERSON's, not the mailbox's and not the organisation's: those two were
//  what the meters used to show, which is why Mail and Space disagreed and
//  neither matched the number a customer had been sold.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ProductUsage {
  /** Catalogue code — 'mail', 'drive'. Stable; the NAME is what changes. */
  code: string;
  name: string;
  usedBytes: number;
}

export interface MyStorage {
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedFraction: number;
  isWarning: boolean;
  isCritical: boolean;
  products: ProductUsage[];
  /** Printed verbatim — one wording for one fact, everywhere it appears. */
  note: string;
}

export async function fetchMyStorage(f: AuthedFetch): Promise<MyStorage> {
  const res = await f('/account/storage');
  if (!res.ok) throw new Error('Could not load your storage.');
  return res.json();
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Colour by fullness. The thresholds match the server's isWarning/isCritical. */
export function meterColour(fraction: number): string {
  if (fraction >= 0.95) return '#fd4963';
  if (fraction >= 0.8) return '#ffa909';
  return '#4285f4';
}
