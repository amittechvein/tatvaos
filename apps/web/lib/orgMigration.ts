// ============================================================================
//  Moving an organisation from Google Workspace
// ============================================================================
//
//  The console's side of /api/org/migration (Modules/Migration/
//  MigrationEndpoints.cs). Decision 0019 (proposed) is the model: TatvaOS owns
//  one Google service account; the admin authorises its client ID in Google's
//  Admin console and tells us here; nothing of Google's is uploaded.
//
//  Every refusal the server words is surfaced UNCHANGED (MigrationError): the
//  sentences say what to do in Google's console, and a sentence of our own
//  here would eventually describe a rule the server no longer has.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const DATA_TYPES = ['mail', 'contacts', 'calendar', 'drive'] as const;
export type DataType = (typeof DATA_TYPES)[number];
export const DATA_TYPE_LABEL: Record<DataType, string> = {
  mail: 'Mail', contacts: 'Contacts', calendar: 'Calendar', drive: 'Drive files',
};

export interface MigrationGrant {
  id: string;
  googleDomain: string;
  googleAdmin: string;
  clientId: string;
  grantedAt: string;
}

export interface MigrationSetup {
  configured: boolean;
  /** Why not, when not configured. Shown verbatim. */
  reason?: string;
  clientId?: string | null;
  serviceAccount?: string;
  scopes?: string[];
  grant: MigrationGrant | null;
  /** False when the grant was made for a key that has since been rotated. */
  grantIsForThisKey?: boolean | null;
}

export interface PersonSize { email: string; mailBytes: number; driveBytes: number }
export interface PersonNote { email: string; reason: string }
export interface MigrationEstimate {
  people: PersonSize[];
  notMigrated: PersonNote[];
  unmeasured: PersonNote[];
  mailBytes: number;
  driveBytes: number;
  verdict: { state: 'fits' | 'refused' | 'incomplete'; reasons: string[]; notChecked: string[] };
}

export interface EnrolmentReport {
  people: number;
  jobsCreated: number;
  matched: number;
  unmatched: string[];
  notEnrolled: string[];
}

export interface StartReport { jobsStarted: number; peopleStarted: number; notStarted: PersonNote[] }

export interface TypeProgress {
  dataType: DataType;
  state: 'planned' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  itemsTotal: number | null;
  itemsDone: number;
  itemsSkipped: number;
  itemsFailed: number;
  bytesDone: number;
  lastError: string | null;
  updatedAt: string;
}
export interface PersonProgress {
  googleAddress: string;
  targetUserId: string | null;
  targetEmail: string | null;
  types: TypeProgress[];
}
export interface MigrationPeople {
  people: PersonProgress[];
  totals: { people: number; matched: number; jobs: number; byState: Record<string, number>; itemsDone: number; bytesDone: number };
}

export class MigrationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MigrationError';
  }
}

async function call<T>(authedFetch: AuthedFetch, path: string, init?: RequestInit, fallback = 'The request failed.'): Promise<T> {
  const res = await authedFetch(`/org/migration${path}`, init);
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  throw new MigrationError(typeof body.error === 'string' && body.error ? body.error : fallback, res.status);
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const fetchSetup = (f: AuthedFetch) => call<MigrationSetup>(f, '/setup', undefined, 'Could not load the Google set-up.');
export const fetchPeople = (f: AuthedFetch) => call<MigrationPeople>(f, '/people', undefined, 'Could not load progress.');
export const grantAccess = (f: AuthedFetch, googleDomain: string, googleAdmin: string) =>
  call<{ grant: MigrationGrant; peopleListed: number }>(f, '/grant', post({ googleDomain, googleAdmin }), 'Could not record the grant.');
export const revokeAccess = (f: AuthedFetch) =>
  call<{ jobsCancelled: number; removeInGoogle: string }>(f, '/revoke', post({}), 'Could not remove access.');
export const runEstimate = (f: AuthedFetch) => call<MigrationEstimate>(f, '/estimate', post({}), 'Could not run the estimate.');
export const enrol = (f: AuthedFetch, dataTypes: DataType[]) =>
  call<EnrolmentReport>(f, '/enrol', post({ dataTypes }), 'Could not read the Google directory.');
export const start = (f: AuthedFetch, dataTypes: DataType[], people: string[] | null) =>
  call<StartReport>(f, '/start', post({ dataTypes, people }), 'Could not start.');
export const catchUp = (f: AuthedFetch, people: string[] | null) =>
  call<{ queued: string[] }>(f, '/catch-up', post({ people }), 'Could not start the catch-up.');

/** A job still moving: the page keeps refreshing while any is. */
export const isActive = (s: TypeProgress['state']) => s === 'pending' || s === 'running';
