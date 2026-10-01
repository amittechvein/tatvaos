// ============================================================================
//  TatvaOS Docs — API client
// ============================================================================
//
//  A document is a Space file. Sharing, trash, restore and stars go through
//  spaceApi (lib/space.ts) with the document's id — there is deliberately no
//  second copy of any of them here. This file is only what Space cannot do:
//  content, versions, comments, pictures, AI.
//
//  The live channel is lib/docsLive.ts.
// ============================================================================

import type { SpaceFile, SpacePermission, SpaceScope } from './space';

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * COPY of DocsFormat.MimeType in apps/api/Modules/Docs/DocsFormat.cs — the
 * root. The one marker that makes a Space file a document; Space's web page
 * compares against this to open documents in Docs instead of downloading.
 */
export const DOCS_MIME = 'application/vnd.tatvaos.document';

export const isDocument = (f: { mimeType?: string }) => f.mimeType === DOCS_MIME;

export const docHref = (id: string) => `/docs/d/${id}`;

export type DocsView = 'recent' | 'owned' | 'shared' | 'starred' | 'trash';

export interface DocumentMeta {
  id: string;
  title: string;
  myPermission: SpacePermission;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  ownershipType: SpaceScope;
  folderId: string | null;
  isStarred: boolean;
  isShared: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  me: { id: string; displayName: string };
  ai: { available: boolean; reason: string | null };
  /** What the file is. Each editor refuses the other's files. */
  kind?: 'document' | 'spreadsheet';
}

export interface DocVersion {
  id: string;
  kind: 'auto' | 'named' | 'restore';
  name: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  parentId: string | null;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  anchor: string | null;
  quote: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  createdAt: string;
  editedAt: string | null;
  replies: CommentThread[];
}

export type AiAction = 'summarize' | 'rewrite' | 'translate' | 'generate';

export class DocsError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DocsError((body as { error?: string }).error ?? fallback, res.status);
  }
  return res.json() as Promise<T>;
}

async function ok(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DocsError((body as { error?: string }).error ?? fallback, res.status);
  }
}

/** Bytes → base64 without blowing the call stack on a large document. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export const docsApi = {
  /** Is Docs switched on for my organisation? Off unless the platform operator turned it on. */
  status: (f: AuthedFetch) =>
    f('/docs/status')
      .then((r) => json<{ enabled: boolean }>(r, 'Could not check whether Docs is on.'))
      .then((b) => b.enabled),

  list: (f: AuthedFetch, view: DocsView, q = '') =>
    f(`/docs?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => json<{ documents: (SpaceFile & {
        isStarred?: boolean; ownerDisplayName?: string | null; parentName?: string | null;
      })[]; total: number }>(r, 'Could not load your documents.')),

  create: (f: AuthedFetch, title?: string, folderId?: string | null, scope: SpaceScope = 'personal') =>
    f('/docs', {
      method: 'POST',
      body: JSON.stringify(folderId ? { title, folderId } : { title, scope }),
    }).then((r) => json<{ id: string; title: string }>(r, 'Could not create the document.')),

  get: (f: AuthedFetch, id: string) =>
    f(`/docs/${id}`).then((r) => json<DocumentMeta>(r, 'Could not open this document.')),

  rename: (f: AuthedFetch, id: string, title: string) =>
    f(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      .then((r) => json<{ id: string; title: string }>(r, 'Could not rename the document.')),

  ticket: (f: AuthedFetch, id: string) =>
    f(`/docs/${id}/live-ticket`, { method: 'POST' })
      .then((r) => json<{ ticket: string }>(r, 'Could not connect to this document.'))
      .then((b) => b.ticket),

  // "Please save now." The server builds the file, the text and the stored
  // state from what IT stored (decision 0011 condition 1); nothing of the
  // browser's copy is sent. A 503 with reason "render_failed" means the file
  // could not be built: the editor says so and tries again.
  checkpoint: (f: AuthedFetch, id: string, body: { upToSeq: number }) =>
    f(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => ok(r, 'Could not save the document.')),

  versions: (f: AuthedFetch, id: string) =>
    f(`/docs/${id}/versions`)
      .then((r) => json<{ versions: DocVersion[] }>(r, 'Could not load version history.'))
      .then((b) => b.versions),

  version: (f: AuthedFetch, id: string, vid: string) =>
    f(`/docs/${id}/versions/${vid}`)
      .then((r) => json<{ id: string; html: string; state: string; name: string | null; createdAt: string }>(
        r, 'Could not load that version.')),

  // The version is the server's stored document at this moment, built by
  // the render service; the browser sends only what kind and what name.
  saveVersion: (f: AuthedFetch, id: string, body: { kind: 'named' | 'restore'; name?: string }) =>
    f(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ id: string }>(r, 'Could not save the version.')),

  nameVersion: (f: AuthedFetch, id: string, vid: string, name: string) =>
    f(`/docs/${id}/versions/${vid}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      .then((r) => ok(r, 'Could not name that version.')),

  comments: (f: AuthedFetch, id: string) =>
    f(`/docs/${id}/comments`)
      .then((r) => json<{ threads: CommentThread[] }>(r, 'Could not load comments.'))
      .then((b) => b.threads),

  comment: (f: AuthedFetch, id: string, body: string, anchor: string | null, quote: string | null) =>
    f(`/docs/${id}/comments`, { method: 'POST', body: JSON.stringify({ body, anchor, quote }) })
      .then((r) => json<{ id: string }>(r, 'Could not add the comment.')),

  reply: (f: AuthedFetch, id: string, cid: string, body: string) =>
    f(`/docs/${id}/comments/${cid}/replies`, { method: 'POST', body: JSON.stringify({ body }) })
      .then((r) => json<{ id: string }>(r, 'Could not add the reply.')),

  editComment: (f: AuthedFetch, id: string, cid: string, body: string) =>
    f(`/docs/${id}/comments/${cid}`, { method: 'PATCH', body: JSON.stringify({ body }) })
      .then((r) => ok(r, 'Could not edit the comment.')),

  resolve: (f: AuthedFetch, id: string, cid: string, resolved: boolean) =>
    f(`/docs/${id}/comments/${cid}`, { method: 'PATCH', body: JSON.stringify({ resolved }) })
      .then((r) => ok(r, resolved ? 'Could not resolve the comment.' : 'Could not reopen the comment.')),

  deleteComment: (f: AuthedFetch, id: string, cid: string) =>
    f(`/docs/${id}/comments/${cid}`, { method: 'DELETE' })
      .then((r) => ok(r, 'Could not delete the comment.')),

  uploadImage: (f: AuthedFetch, id: string, file: Blob) => {
    const form = new FormData();
    form.append('file', file, 'image');
    return f(`/docs/${id}/images`, { method: 'POST', body: form })
      .then((r) => json<{ id: string; src: string }>(r, 'Could not add the picture.'));
  },

  ai: (f: AuthedFetch, id: string, body: {
    action: AiAction; text?: string; prompt?: string; style?: string; language?: string;
  }) =>
    f(`/docs/${id}/ai`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ text: string; truncated: boolean }>(r, 'TatvaOS AI could not answer.')),
};
