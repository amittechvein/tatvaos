// ============================================================================
//  Family API client — contacts.
//
//  Mirrors lib/mail.ts: every call takes authedFetch from lib/auth, which
//  attaches the in-memory access token and silently refreshes once on a 401.
//  Nothing in here thinks about tokens.
//
//  Note the British spelling throughout — isFavourite, colour,
//  'organisational'. It matches the API, which matches the rest of the
//  codebase. Americanised field names will silently read as undefined.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type Ownership = 'personal' | 'organisational';

/**
 * How the row came to exist. The auto_* values were never typed by a human —
 * the list surfaces them so a person can review what mail put in their address
 * book rather than discovering it as clutter.
 */
export type ContactSource =
  | 'manual' | 'import' | 'api'
  | 'auto_received' | 'auto_sent' | 'auto_reply';

export interface ContactSummary {
  id: string;
  displayName: string;
  jobTitle: string | null;
  companyName: string | null;
  primaryEmail: string | null;
  ownershipType: Ownership;
  source: ContactSource;
  isFavourite: boolean;
  lastContactedAt: string | null;
  interactionCount: number;
  updatedAt: string;
}

export interface ContactEmail { id: string; email: string; type: string; isPrimary: boolean }
export interface ContactPhone { id: string; phone: string; type: string; isPrimary: boolean }
export interface ContactAddress {
  id: string; type: string;
  streetLine1: string | null; streetLine2: string | null;
  city: string | null; stateProvince: string | null;
  postalCode: string | null; country: string | null;
  isPrimary: boolean;
}
export interface ContactGroup {
  id: string; name: string; description: string | null; colour: string | null;
}

export interface ContactDetail extends ContactSummary {
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  notes: string | null;
  createdAt: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  groups: ContactGroup[];
}

export interface ContactPage {
  total: number; page: number; pageSize: number; items: ContactSummary[];
}

export interface FamilySettings {
  autoSaveReceived: boolean;
  autoSaveSent: boolean;
  autoSaveReply: boolean;
}

export interface FamilyBootstrap {
  counts: { total: number; personal: number; organisational: number };
  groups: ContactGroup[];
  settings: FamilySettings;
}

export interface Interaction {
  id: string; type: string; subject: string | null; notes: string | null;
  mailMessageId: string | null; occurredAt: string;
}

export interface AuditEntry {
  id: string; operation: string; actorUserId: string | null;
  changes: string | null; reason: string | null; occurredAt: string;
}

export interface CreateContact {
  displayName: string;
  firstName?: string; lastName?: string; nickname?: string;
  jobTitle?: string; companyName?: string; notes?: string;
  isFavourite?: boolean;
  ownershipType?: Ownership;
  email?: string; emailType?: string;
  phone?: string; phoneType?: string;
}

/**
 * A duplicate address is a 409 carrying the id of the contact that already
 * holds it. Thrown as a distinct type so the UI can offer "open the existing
 * one" instead of a dead-end error toast — which is the whole reason the API
 * returns the id rather than just refusing.
 */
export class DuplicateContactError extends Error {
  constructor(message: string, readonly contactId: string) {
    super(message);
    this.name = 'DuplicateContactError';
  }
}

async function json<T>(res: Response, fallbackError: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string; title?: string }).error
      ?? (body as { title?: string }).title
      ?? fallbackError);
  }
  return res.json() as Promise<T>;
}

async function ok(res: Response, fallbackError: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string; title?: string }).error
      ?? (body as { title?: string }).title
      ?? fallbackError);
  }
}

/** 409 → DuplicateContactError; anything else → plain Error. */
async function duplicateAware(res: Response, fallbackError: string): Promise<{ id: string }> {
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as
      { message?: string; error?: string; contactId?: string };
    if (body.contactId) {
      throw new DuplicateContactError(body.message ?? 'That address is already in use.', body.contactId);
    }
    throw new Error(body.message ?? body.error ?? fallbackError);
  }
  return json<{ id: string }>(res, fallbackError);
}

export const familyApi = {
  bootstrap: (f: AuthedFetch) =>
    f('/family/bootstrap').then((r) => json<FamilyBootstrap>(r, 'Could not load your contacts.')),

  list: (f: AuthedFetch, opts: {
    ownership?: Ownership; groupId?: string; favourite?: boolean;
    /** 'auto' = everything mail saved; 'manual' = everything a human added. */
    source?: 'auto' | 'manual';
    /** Server-side, because it has to hold across pages. */
    sort?: 'name' | 'recent' | 'frequent' | 'deleted';
    /** The Bin. Soft-deleted rows are invisible everywhere else. */
    deleted?: boolean;
    page?: number; pageSize?: number;
  } = {}) => {
    const p = new URLSearchParams();
    if (opts.ownership) p.set('ownership', opts.ownership);
    if (opts.groupId) p.set('groupId', opts.groupId);
    if (opts.favourite) p.set('favourite', 'true');
    if (opts.source) p.set('source', opts.source);
    if (opts.sort) p.set('sort', opts.sort);
    if (opts.deleted) p.set('deleted', 'true');
    if (opts.page) p.set('page', String(opts.page));
    if (opts.pageSize) p.set('pageSize', String(opts.pageSize));
    const qs = p.size > 0 ? `?${p}` : '';
    return f(`/family/contacts${qs}`).then((r) => json<ContactPage>(r, 'Could not load contacts.'));
  },

  /** Returns the summary array directly — no envelope. Empty q gives []. */
  search: (f: AuthedFetch, q: string, limit = 50) =>
    f(`/family/contacts/search?q=${encodeURIComponent(q)}&limit=${limit}`)
      .then((r) => json<ContactSummary[]>(r, 'Search failed.')),

  /** One row per ADDRESS, not per contact — someone with two appears twice. */
  autocomplete: (f: AuthedFetch, q: string, limit = 10) =>
    f(`/family/contacts/autocomplete?q=${encodeURIComponent(q)}&limit=${limit}`)
      .then((r) => json<{ contactId: string; email: string; displayName: string }[]>(r, 'Lookup failed.')),

  /** 404 is a normal answer — the address simply is not in the address book. */
  lookup: async (f: AuthedFetch, email: string): Promise<ContactSummary | null> => {
    const res = await f(`/family/contacts/lookup?email=${encodeURIComponent(email)}`);
    if (res.status === 404) return null;
    return json<ContactSummary>(res, 'Lookup failed.');
  },

  get: (f: AuthedFetch, id: string) =>
    f(`/family/contacts/${id}`).then((r) => json<ContactDetail>(r, 'Could not load the contact.')),

  create: (f: AuthedFetch, body: CreateContact) =>
    f('/family/contacts', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => duplicateAware(r, 'Could not create the contact.')),

  /** Send only what changed. A no-op patch is a 204 and writes no audit row. */
  patch: (f: AuthedFetch, id: string, body: Partial<CreateContact>) =>
    f(`/family/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then((r) => ok(r, 'Could not save the contact.')),

  /** Undo a soft delete. Source is left alone — it is still a mail-saved row. */
  restore: (f: AuthedFetch, id: string) =>
    f(`/family/contacts/${id}/restore`, { method: 'POST' })
      .then((r) => ok(r, 'Could not restore the contact.')),

  remove: (f: AuthedFetch, id: string) =>
    f(`/family/contacts/${id}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not delete the contact.')),

  addEmail: (f: AuthedFetch, id: string, email: string, type = 'work', isPrimary = false) =>
    f(`/family/contacts/${id}/emails`, {
      method: 'POST', body: JSON.stringify({ email, type, isPrimary }),
    }).then(async (r) => {
      if (r.status === 409) {
        const b = await r.json().catch(() => ({})) as { message?: string; contactId?: string };
        if (b.contactId) throw new DuplicateContactError(b.message ?? 'Already in use.', b.contactId);
      }
      return ok(r, 'Could not add the address.');
    }),

  removeEmail: (f: AuthedFetch, id: string, emailId: string) =>
    f(`/family/contacts/${id}/emails/${emailId}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not remove the address.')),

  addPhone: (f: AuthedFetch, id: string, phone: string, type = 'mobile', isPrimary = false) =>
    f(`/family/contacts/${id}/phones`, {
      method: 'POST', body: JSON.stringify({ phone, type, isPrimary }),
    }).then((r) => ok(r, 'Could not add the number.')),

  removePhone: (f: AuthedFetch, id: string, phoneId: string) =>
    f(`/family/contacts/${id}/phones/${phoneId}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not remove the number.')),

  interactions: (f: AuthedFetch, id: string, limit = 50) =>
    f(`/family/contacts/${id}/interactions?limit=${limit}`)
      .then((r) => json<Interaction[]>(r, 'Could not load the history.')),

  logInteraction: (f: AuthedFetch, id: string, body: {
    type: string; subject?: string; notes?: string; occurredAt?: string;
  }) => f(`/family/contacts/${id}/interactions`, { method: 'POST', body: JSON.stringify(body) })
        .then((r) => ok(r, 'Could not log that.')),

  audit: (f: AuthedFetch, id: string, limit = 100) =>
    f(`/family/contacts/${id}/audit?limit=${limit}`)
      .then((r) => json<AuditEntry[]>(r, 'Could not load the audit trail.')),

  groups: (f: AuthedFetch) =>
    f('/family/groups').then((r) => json<ContactGroup[]>(r, 'Could not load groups.')),

  createGroup: (f: AuthedFetch, name: string, description?: string, colour?: string) =>
    f('/family/groups', { method: 'POST', body: JSON.stringify({ name, description, colour }) })
      .then((r) => json<{ id: string }>(r, 'Could not create the group.')),

  deleteGroup: (f: AuthedFetch, groupId: string) =>
    f(`/family/groups/${groupId}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not delete the group.')),

  /** PUT, and idempotent — adding twice succeeds rather than 409. */
  addToGroup: (f: AuthedFetch, groupId: string, contactId: string) =>
    f(`/family/groups/${groupId}/members/${contactId}`, { method: 'PUT' })
      .then((r) => ok(r, 'Could not add to the group.')),

  removeFromGroup: (f: AuthedFetch, groupId: string, contactId: string) =>
    f(`/family/groups/${groupId}/members/${contactId}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not remove from the group.')),

  settings: (f: AuthedFetch) =>
    f('/family/settings').then((r) => json<FamilySettings>(r, 'Could not load settings.')),

  /** Replaces all three — send the whole object. */
  saveSettings: (f: AuthedFetch, s: FamilySettings) =>
    f('/family/settings', { method: 'PUT', body: JSON.stringify(s) })
      .then((r) => json<FamilySettings>(r, 'Could not save settings.')),
};

/** "auto_received" → "Saved from mail". Used by the source chip in the list. */
export function sourceLabel(s: ContactSource): string {
  switch (s) {
    case 'auto_received': return 'Saved from mail';
    case 'auto_sent':     return 'Saved from sent mail';
    case 'auto_reply':    return 'Saved from a reply';
    case 'import':        return 'Imported';
    case 'api':           return 'Added by an app';
    default:              return 'Added by hand';
  }
}

export const isAutoSaved = (s: ContactSource) => s.startsWith('auto_');
