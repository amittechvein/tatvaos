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

export interface MailBootstrap {
  /** Null is a normal state — a person with no mail product. */
  mailbox: MailMailbox | null;
  folders: Folder[];
}

export interface MessagePage {
  total: number;
  messages: Message[];
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

  message: (f: AuthedFetch, id: string) =>
    f(`/mail/messages/${id}`).then((r) => json<Message>(r, 'Could not load the message.')),

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
