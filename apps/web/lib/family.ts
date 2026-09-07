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

/**
 * A label with the number of live contacts carrying it. What
 * `GET /family/groups` actually returns — `count` excludes contacts in the
 * Bin, so it agrees with what you see when you click through.
 */
export interface LabelSummary extends ContactGroup {
  count: number;
}

export interface NewAddress {
  streetLine1?: string; streetLine2?: string; city?: string;
  stateProvince?: string; postalCode?: string; country?: string;
  type?: string; isPrimary?: boolean;
}

export interface BulkLabelResult {
  /** How many contacts were touched. */
  contacts: number;
  /** Membership rows created — never more than contacts x labels, often fewer. */
  added: number;
  removed: number;
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

/**
 * What one row of an imported file turned into. `outcome` is "skipped" today —
 * created and updated rows are counted, not listed, because a four-hundred-row
 * success does not need four hundred lines of proof.
 */
export interface ImportOutcome {
  row: number;
  name: string;
  email: string | null;
  outcome: string;
  reason: string;
  contactId: string | null;
}

export interface ImportReport {
  dryRun: boolean;
  fileName: string;
  /** 'csv' | 'vcard' — worked out from the file, not from what you told us. */
  format: string;
  rowsRead: number;
  created: number;
  updated: number;
  skipped: number;
  /** Things worth saying out loud that are not failures. */
  warnings: string[];
  problems: ImportOutcome[];
  problemsTruncated: boolean;
  /** The first few names that would be added, so a dry run is checkable. */
  sample: string[];
}

export interface ImportSettings {
  /** Check the file and report, writing nothing. */
  dryRun?: boolean;
  /** Where the imported contacts land. Defaults to personal. */
  ownership?: Ownership;
  /**
   * skip    an address already in the book leaves that contact alone
   * update  fills in its blanks and adds addresses and numbers it lacks
   */
  mode?: 'skip' | 'update';
  createLabels?: boolean;
  /** A label put on everything in this file — the only bulk undo there is. */
  label?: string;
}

export interface ExportSettings {
  format: 'csv' | 'vcf';
  ownership?: Ownership;
  groupId?: string;
  source?: 'auto' | 'manual';
  favourite?: boolean;
}

/**
 * The import routes answer with { message } rather than { error } — the string
 * is written to be read by the person who chose the file, and putting the
 * machine-readable code in front of them instead would be a small betrayal.
 */
async function readable(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({})) as
    { message?: string; detail?: string; title?: string; error?: string };
  throw new Error(body.message ?? body.detail ?? body.title ?? body.error ?? fallback);
}

export const familyApi = {
  /**
   * Read a file and say what would happen, or make it happen.
   *
   * Sent as multipart because that is what a browser file input produces and
   * authedFetch already leaves FormData's own Content-Type alone. The options
   * ride in the query string so the body stays exactly the file the person
   * chose — nothing wrapped, nothing re-encoded.
   */
  importFile: async (f: AuthedFetch, file: File, opts: ImportSettings = {}) => {
    const p = new URLSearchParams();
    if (opts.dryRun) p.set('dryRun', 'true');
    if (opts.ownership) p.set('ownership', opts.ownership);
    if (opts.mode) p.set('mode', opts.mode);
    if (opts.createLabels === false) p.set('createLabels', 'false');
    if (opts.label) p.set('label', opts.label);

    const body = new FormData();
    body.append('file', file, file.name);

    const res = await f(`/family/contacts/import?${p}`, { method: 'POST', body });
    if (!res.ok) return readable(res, 'The import failed.');
    return res.json() as Promise<ImportReport>;
  },

  /**
   * Returns the file itself, not a URL. The endpoint needs an Authorization
   * header, so it cannot be an anchor tag — the page has to fetch it and hand
   * the browser a blob.
   */
  exportFile: async (f: AuthedFetch, opts: ExportSettings) => {
    const p = new URLSearchParams({ format: opts.format });
    if (opts.ownership) p.set('ownership', opts.ownership);
    if (opts.groupId) p.set('groupId', opts.groupId);
    if (opts.source) p.set('source', opts.source);
    if (opts.favourite) p.set('favourite', 'true');

    const res = await f(`/family/contacts/export?${p}`);
    if (!res.ok) return readable(res, 'The export failed.');

    // Content-Disposition is only readable when the API is same-origin or
    // exposes the header, so the name is computed as a fallback rather than
    // depended on. A download called "blob" is a support ticket.
    const today = new Date().toISOString().slice(0, 10);
    const suggested = nameFromDisposition(res.headers.get('content-disposition'));

    return {
      blob: await res.blob(),
      name: suggested ?? `tatvaos-contacts-${today}.${opts.format}`,
    };
  },

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
      .then((r) => json<{
        id: string; email: string; displayName: string; isColleague: boolean;
      }[]>(r, 'Lookup failed.')),

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

  addAddress: (f: AuthedFetch, id: string, body: NewAddress) =>
    f(`/family/contacts/${id}/addresses`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => ok(r, 'Could not add the address.')),
  removeAddress: (f: AuthedFetch, id: string, addressId: string) =>
    f(`/family/contacts/${id}/addresses/${addressId}`, { method: 'DELETE' })
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
    f('/family/groups').then((r) => json<LabelSummary[]>(r, 'Could not load labels.')),

  createGroup: (f: AuthedFetch, name: string, description?: string, colour?: string) =>
    f('/family/groups', { method: 'POST', body: JSON.stringify({ name, description, colour }) })
      .then((r) => json<{ id: string }>(r, 'Could not create the group.')),

  /**
   * Rename, recolour, or describe. Send only what changed — an absent field is
   * left alone, an empty string clears it.
   *
   * A rename is a real update, never a delete and recreate: every membership
   * row points at this id, and recreating the label would quietly empty it.
   */
  updateGroup: (f: AuthedFetch, groupId: string, body: {
    name?: string; description?: string; colour?: string;
  }) => f(`/family/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(body) })
        .then(async (r) => {
          if (r.status === 409) {
            const b = await r.json().catch(() => ({})) as { message?: string };
            throw new Error(b.message ?? 'A label with that name already exists.');
          }
          return ok(r, 'Could not save the label.');
        }),

  deleteGroup: (f: AuthedFetch, groupId: string) =>
    f(`/family/groups/${groupId}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not delete the group.')),

  /**
   * Add and remove labels across many contacts in one request.
   *
   * Two ways to say which contacts, and they are not equivalent:
   *
   *   contactIds   the rows someone ticked
   *   all + filter everything matching, which may be thousands they have not
   *                seen — the server runs the SAME filter the list route ran,
   *                so the number on the button is the number that changes
   *
   * `added` and `removed` count membership rows, not contacts: labelling 100
   * contacts with a label half of them already carried reports 50.
   */
  bulkLabels: (f: AuthedFetch, body: {
    contactIds?: string[];
    all?: boolean;
    ownership?: Ownership;
    groupId?: string;
    favourite?: boolean;
    source?: 'auto' | 'manual';
    add?: string[];
    remove?: string[];
  }) => f('/family/contacts/labels', { method: 'POST', body: JSON.stringify(body) })
        .then((r) => json<BulkLabelResult>(r, 'Could not update the labels.')),

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

/** filename="x.csv" or filename*=UTF-8''x.csv out of a Content-Disposition. */
function nameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) return decodeURIComponent(star[1].trim());
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: revoking
 * it in the same frame as the click races the download in Safari and produces
 * an empty file.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
