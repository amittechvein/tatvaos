// ============================================================================
//  Mail API client — the real one.
//
//  Replaces the mock the shell shipped with. Every call goes through
//  authedFetch from lib/auth, which attaches the in-memory access token and
//  silently refreshes once on a 401 — so nothing here thinks about tokens.
// ============================================================================

import type { Folder, Message } from '@tatvaos/types';

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface MailMailbox {
  id: string;
  address: string;
  displayName: string;
  type: 'user' | 'shared' | 'group';
  quotaBytes: number;
  usedBytes: number;
}

/**
 * A mailbox's signature.
 *
 * Both representations are stored: outgoing mail is multipart/alternative, and
 * a signature present in only one part means half the recipients see a
 * different message.
 */
export interface MailSignature {
  bodyHtml: string;
  bodyText: string;
  enabled: boolean;
  /** Separate from `enabled` — most people don't want it on every reply. */
  includeOnReply: boolean;
}

/**
 * A draft, in the shape the composer edits.
 *
 * Attachments are absent on purpose: files stay in the browser until send, so
 * a saved draft carries recipients, subject and body only. The composer has to
 * say so — someone who closes the window believing their attachment was kept
 * has lost work.
 */
export interface MailDraft {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export interface MailBootstrap {
  /** Null is a normal state — a person with no mail product. */
  mailbox: MailMailbox | null;
  folders: Folder[];
  /** Arrives with bootstrap so a composer has it the moment it opens. */
  signature?: MailSignature;
}

export interface MessagePage {
  total: number;
  messages: Message[];
}

/**
 * A search hit is a Message plus where it lives — results span every folder,
 * so a row has to be able to say "in Sent" and navigate there.
 */
export type SearchHit = Message & {
  folderId: string;
  folderName: string | null;
  folderSlug: string | null;
};

export interface SearchPage {
  total: number;
  messages: SearchHit[];
}

/**
 * One conversation in a folder listing: the newest message, plus the parts
 * of the group that only make sense rolled up.
 *
 * `isRead` is false when ANY message in the conversation is unread - the
 * alternative hides the single new reply at the end of a long read thread.
 */
export interface ThreadSummary {
  threadId: string;
  /** The message a click on the row should open: newest in this folder. */
  latestMessageId: string;
  count: number;
  subject: string;
  snippet: string;
  from: { name: string | null; email: string };
  /** Distinct senders, oldest first. */
  participants: { name: string | null; email: string }[];
  sentAt: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
}

export interface ThreadPage {
  total: number;
  threads: ThreadSummary[];
}

/** An address this mailbox has blocked. Blocked mail is filed to Junk, not refused. */
export interface BlockedSender {
  id: string;
  address: string;
  createdAt: string;
}

/** What a filter rule can match on, and what it can do. */
export type FilterField = 'from' | 'to' | 'subject' | 'body';
export type FilterOp = 'contains' | 'equals';

export interface FilterCondition {
  field: FilterField;
  op: FilterOp;
  value: string;
}

export interface FilterActions {
  /** Null means "leave it where it landed". */
  moveToFolderId: string | null;
  markRead: boolean;
  flag: boolean;
}

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  matchAll: boolean;
  position: number;
  conditions: FilterCondition[];
  actions: FilterActions;
  createdAt: string;
}

/** A create/update body — everything but the server-owned fields. */
export type FilterDraft = Omit<FilterRule, 'id' | 'createdAt'>;

/**
 * A person you can address inside your own organisation, as offered by the
 * composer's "@" picker. Mailboxes only: somebody with a Core account but no
 * mail product has no address worth suggesting.
 */
export interface DirectoryPerson {
  email: string;
  name: string;
}

async function json<T>(res: Response, fallbackError: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? fallbackError);
  }
  return res.json() as Promise<T>;
}

export const mailApi = {
  bootstrap: (f: AuthedFetch) =>
    f('/mail/bootstrap').then((r) => json<MailBootstrap>(r, 'Could not load your mailbox.')),

  folders: (f: AuthedFetch) =>
    f('/mail/folders')
      .then((r) => json<{ folders: Folder[] }>(r, 'Could not load folders.'))
      .then((b) => b.folders),

  messages: (f: AuthedFetch, folderId: string, opts?: { skip?: number; take?: number; q?: string }) => {
    const params = new URLSearchParams();
    if (opts?.skip) params.set('skip', String(opts.skip));
    if (opts?.take) params.set('take', String(opts.take));
    if (opts?.q) params.set('q', opts.q);
    const qs = params.size > 0 ? `?${params}` : '';
    return f(`/mail/folders/${folderId}/messages${qs}`).then((r) =>
      json<MessagePage>(r, 'Could not load messages.'),
    );
  },

  /**
   * A folder as conversations rather than as messages.
   *
   * Grouping is per folder and the key is the thread id, falling back to the
   * message id - so mail that predates threading still appears, as a
   * conversation of one, instead of vanishing from the list.
   */
  folderThreads: (f: AuthedFetch, folderId: string, opts?: { skip?: number; take?: number }) => {
    const params = new URLSearchParams();
    if (opts?.skip) params.set('skip', String(opts.skip));
    if (opts?.take) params.set('take', String(opts.take));
    const qs = params.size > 0 ? `?${params}` : '';
    return f(`/mail/folders/${folderId}/threads${qs}`).then((r) =>
      json<ThreadPage>(r, 'Could not load conversations.'),
    );
  },

  /**
   * Search the whole mailbox — every folder, including message bodies.
   *
   * This replaces filtering the loaded page in the browser, which only ever
   * searched the ~50 rows on screen in the current folder: a search for older
   * mail returned nothing and looked exactly like "no such message".
   */
  search: (f: AuthedFetch, q: string, opts?: { skip?: number; take?: number }) => {
    const params = new URLSearchParams({ q });
    if (opts?.skip) params.set('skip', String(opts.skip));
    if (opts?.take) params.set('take', String(opts.take));
    return f(`/mail/search?${params}`).then((r) => json<SearchPage>(r, 'Could not search your mail.'));
  },

  /**
   * Every message in one conversation, oldest first.
   *
   * Rows are the same shape as a search hit, folder included: a thread
   * legitimately spans Inbox and Sent, so a row has to be able to say which
   * one it is in. `total` is the untruncated count - a very long thread is
   * capped server-side, and the strip should say so rather than just stop.
   */
  thread: (f: AuthedFetch, threadId: string) =>
    f(`/mail/threads/${threadId}/messages`)
      .then((r) => json<SearchPage>(r, 'Could not load this conversation.')),

  message: (f: AuthedFetch, id: string) =>
    f(`/mail/messages/${id}`).then((r) => json<Message>(r, 'Could not load the message.')),

  /**
   * Recipient suggestions for the composer's "@" picker.
   *
   * Server-side rather than filtering a list held in the browser: the client
   * never has to hold the whole organisation, and a company that grows does
   * not mean shipping a longer list of its people into every page load.
   */
  directory: (f: AuthedFetch, q: string) =>
    f(`/mail/directory?q=${encodeURIComponent(q)}`)
      .then((r) => json<{ people: DirectoryPerson[] }>(r, 'Could not load your directory.'))
      .then((b) => b.people),

  /**
   * Drafts. A draft is a message in the Drafts folder, so it appears there and
   * in search like anything else.
   */
  draft: (f: AuthedFetch, id: string) =>
    f(`/mail/drafts/${id}`).then((r) => json<MailDraft>(r, 'Could not open that draft.')),

  createDraft: (f: AuthedFetch, d: Omit<MailDraft, 'id'>) =>
    f('/mail/drafts', { method: 'POST', body: JSON.stringify(d) })
      .then((r) => json<{ id: string }>(r, 'Could not save the draft.')),

  updateDraft: (f: AuthedFetch, id: string, d: Omit<MailDraft, 'id'>) =>
    f(`/mail/drafts/${id}`, { method: 'PUT', body: JSON.stringify(d) })
      .then((r) => json<{ id: string }>(r, 'Could not save the draft.')),

  deleteDraft: (f: AuthedFetch, id: string) =>
    f(`/mail/drafts/${id}`, { method: 'DELETE' })
      .then((r) => json<{ deleted: boolean }>(r, 'Could not discard the draft.')),

  /** This mailbox's signature. Also included in the bootstrap response. */
  signature: (f: AuthedFetch) =>
    f('/mail/signature').then((r) => json<MailSignature>(r, 'Could not load your signature.')),

  saveSignature: (f: AuthedFetch, sig: MailSignature) =>
    f('/mail/signature', { method: 'PUT', body: JSON.stringify(sig) })
      .then((r) => json<MailSignature>(r, 'Could not save your signature.')),

  /**
   * Blocked senders. Blocking is a filing rule, not a refusal: future mail from
   * the address lands in Junk instead of the Inbox, and nothing is lost — so
   * unblocking takes effect immediately and costs no history.
   */
  blocked: (f: AuthedFetch) =>
    f('/mail/blocked')
      .then((r) => json<{ blocked: BlockedSender[] }>(r, 'Could not load blocked senders.'))
      .then((b) => b.blocked),

  blockSender: (f: AuthedFetch, address: string) =>
    f('/mail/blocked', { method: 'POST', body: JSON.stringify({ address }) })
      .then((r) => json<{ id: string; address: string }>(r, 'Could not block that sender.')),

  unblockSender: (f: AuthedFetch, id: string) =>
    f(`/mail/blocked/${id}`, { method: 'DELETE' })
      .then((r) => json<{ unblocked: boolean }>(r, 'Could not unblock that sender.')),

  /**
   * Filter rules. Applied by the ingest worker as mail arrives, in position
   * order — every matching rule runs, so a later move overrides an earlier one.
   */
  filters: (f: AuthedFetch) =>
    f('/mail/filters')
      .then((r) => json<{ filters: FilterRule[] }>(r, 'Could not load filters.'))
      .then((b) => b.filters),

  createFilter: (f: AuthedFetch, draft: FilterDraft) =>
    f('/mail/filters', { method: 'POST', body: JSON.stringify(draft) })
      .then((r) => json<FilterRule>(r, 'Could not save the filter.')),

  updateFilter: (f: AuthedFetch, id: string, draft: FilterDraft) =>
    f(`/mail/filters/${id}`, { method: 'PUT', body: JSON.stringify(draft) })
      .then((r) => json<FilterRule>(r, 'Could not save the filter.')),

  deleteFilter: (f: AuthedFetch, id: string) =>
    f(`/mail/filters/${id}`, { method: 'DELETE' })
      .then((r) => json<{ deleted: boolean }>(r, 'Could not delete the filter.')),

  setRead: (f: AuthedFetch, id: string, isRead: boolean) =>
    f(`/mail/messages/${id}/read`, { method: 'POST', body: JSON.stringify({ isRead }) }),

  setFlag: (f: AuthedFetch, id: string, isFlagged: boolean) =>
    f(`/mail/messages/${id}/flag`, { method: 'POST', body: JSON.stringify({ isFlagged }) }),

  move: (f: AuthedFetch, id: string, folderId: string) =>
    f(`/mail/messages/${id}/move`, { method: 'POST', body: JSON.stringify({ folderId }) }),

  /** First delete moves to Trash; delete from Trash is permanent. */
  delete: (f: AuthedFetch, id: string) =>
    f(`/mail/messages/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ deleted: boolean; movedTo?: string }>(r, 'Could not delete the message.'),
    ),

  send: (
    f: AuthedFetch,
    payload: {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      /** Rich body. When present the message goes out as multipart/alternative. */
      bodyHtml?: string;
      inReplyToId?: string;
      files?: File[];
      /** The draft this was composed from; the server deletes it after send. */
      draftId?: string;
    },
  ) => {
    // Multipart, not JSON — the send endpoint now carries file attachments.
    const fd = new FormData();
    fd.append('to', payload.to.join(', '));
    if (payload.cc?.length) fd.append('cc', payload.cc.join(', '));
    fd.append('subject', payload.subject);
    fd.append('bodyText', payload.bodyText);
    if (payload.bodyHtml) fd.append('bodyHtml', payload.bodyHtml);
    if (payload.inReplyToId) fd.append('inReplyToId', payload.inReplyToId);
    if (payload.draftId) fd.append('draftId', payload.draftId);
    for (const file of payload.files ?? []) fd.append('files', file, file.name);
    return f('/mail/send', { method: 'POST', body: fd }).then((r) =>
      json<{ id: string | null }>(r, 'The message could not be sent.'),
    );
  },

  /**
   * Attachment download. fetch + blob rather than a plain <a href>, because
   * the endpoint needs the Authorization header a bare link cannot carry.
   */
  downloadAttachment: async (f: AuthedFetch, messageId: string, attachmentId: string, filename: string) => {
    const res = await f(`/mail/messages/${messageId}/attachments/${attachmentId}`);
    if (!res.ok) throw new Error('Could not download the attachment.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

/**
 * The [folderId] route segment is a slug for special folders ('inbox') and a
 * GUID for custom ones. Slugs first: /mail/inbox must never depend on which
 * mailbox is looking at it.
 */
export function resolveFolder(folders: Folder[], param: string): Folder | undefined {
  return folders.find((f) => f.slug === param) ?? folders.find((f) => f.id === param);
}

/** The route segment for a folder — slug when it has one, id otherwise. */
export function folderPath(folder: Folder): string {
  return `/mail/${folder.slug ?? folder.id}`;
}
