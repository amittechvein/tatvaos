// ============================================================================
//  TatvaOS Space — API client
// ============================================================================
//
//  Speaks the approved v1.1 contract (docs/SPACE_API.md) and nothing else.
//  Two rules from that contract are load-bearing here:
//
//  UPLOAD FIELD ORDER IS PART OF THE PROTOCOL. sizeBytes must reach the
//  server before the bytes do — quota is pre-checked against the claim, and
//  the server refuses to read a `file` part that arrives first. FormData
//  preserves append order, so upload() appends in the contract's order and
//  nothing may "tidy" it alphabetically.
//
//  QUOTA REFUSAL IS 413 + reason, NEVER 5xx. The UI branches on `reason`
//  (full | suspended | no_allocation | file_too_large), so upload errors
//  carry it through rather than flattening everything to a sentence.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type SpaceScope = 'personal' | 'organisational';
export type SpacePermission = 'view' | 'comment' | 'edit' | 'owner';

export interface SpaceFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  folderId: string | null;
  ownershipType: SpaceScope;
  ownerUserId: string | null;
  createdByUserId: string | null;
  myPermission: SpacePermission;
  isShared: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceFolder extends Omit<SpaceFile, 'mimeType' | 'sizeBytes'> {
  parentFolderId: string | null;
  childFolderCount: number;
  fileCount: number;
}

export interface Crumb { id: string | null; name: string }

export interface SpaceListing {
  breadcrumb: Crumb[];
  folder: SpaceFolder | null;
  folders: SpaceFolder[];
  files: SpaceFile[];
  page: number;
  pageSize: number;
  totalFiles: number;
}

export interface SpaceShare {
  id: string;
  userId: string | null;
  userDisplayName: string | null;
  orgWide: boolean;
  permission: Exclude<SpacePermission, 'owner'>;
  sharedByUserId: string | null;
  createdAt: string;
}

/** An upload refusal the UI can branch on. Everything else throws Error. */
export class UploadRefusedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'full' | 'suspended' | 'no_allocation' | 'file_too_large',
  ) {
    super(message);
  }
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? fallback);
  }
  return res.json() as Promise<T>;
}

/** folderId when inside a folder, scope at a root — exactly one, per contract. */
function target(folderId: string | null, scope: SpaceScope): string {
  return folderId ? `folderId=${folderId}` : `scope=${scope}`;
}

export const spaceApi = {
  list: (f: AuthedFetch, folderId: string | null, scope: SpaceScope, page = 1) =>
    f(`/space/list?${target(folderId, scope)}&page=${page}`)
      .then((r) => json<SpaceListing>(r, 'Could not load this folder.')),

  shared: (f: AuthedFetch) =>
    f('/space/shared')
      .then((r) => json<{ folders: SpaceFolder[]; files: SpaceFile[] }>(r, 'Could not load shared items.')),

  trash: (f: AuthedFetch) =>
    f('/space/trash')
      .then((r) => json<{
        folders: SpaceFolder[]; files: SpaceFile[]; retentionDays: number; trashBytes: number;
      }>(r, 'Could not load the trash.')),

  search: (f: AuthedFetch, q: string) =>
    f(`/space/search?q=${encodeURIComponent(q)}`)
      .then((r) => json<{ files: SpaceFile[]; total: number }>(r, 'Search failed.')),

  upload: async (f: AuthedFetch, folderId: string | null, scope: SpaceScope, file: File) => {
    const form = new FormData();
    // Contract order — see the header comment. file is LAST.
    if (folderId) form.append('folderId', folderId);
    else form.append('scope', scope);
    form.append('sizeBytes', String(file.size));
    form.append('file', file, file.name);

    const res = await f('/space/files', { method: 'POST', body: form });
    if (res.status === 413) {
      const body = await res.json().catch(() => ({}));
      throw new UploadRefusedError(
        (body as { error?: string }).error ?? 'There is no room for this file.',
        (body as { reason?: UploadRefusedError['reason'] }).reason ?? 'full',
      );
    }
    return json<SpaceFile>(res, 'The upload failed.');
  },

  /** Browser-native download; the server sets Content-Disposition. */
  download: async (f: AuthedFetch, file: SpaceFile) => {
    const res = await f(`/space/files/${file.id}/content`);
    if (!res.ok) throw new Error('Could not download that file.');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  },

  renameFile: (f: AuthedFetch, id: string, name: string) =>
    f(`/space/files/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      .then((r) => json<SpaceFile>(r, 'Could not rename that file.')),

  trashFile: (f: AuthedFetch, id: string) =>
    f(`/space/files/${id}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not move that file to trash.'); }),

  restoreFile: (f: AuthedFetch, id: string) =>
    f(`/space/files/${id}/restore`, { method: 'POST' })
      .then((r) => json<SpaceFile>(r, 'Could not restore that file.')),

  purgeFile: (f: AuthedFetch, id: string) =>
    f(`/space/files/${id}/permanent`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not delete that file permanently.'); }),

  createFolder: (f: AuthedFetch, name: string, parentFolderId: string | null, scope: SpaceScope) =>
    f('/space/folders', {
      method: 'POST',
      body: JSON.stringify(parentFolderId ? { name, parentFolderId } : { name, parentFolderId: null, scope }),
    }).then((r) => json<SpaceFolder>(r, 'Could not create the folder.')),

  renameFolder: (f: AuthedFetch, id: string, name: string) =>
    f(`/space/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      .then((r) => json<SpaceFolder>(r, 'Could not rename that folder.')),

  trashFolder: (f: AuthedFetch, id: string) =>
    f(`/space/folders/${id}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not move that folder to trash.'); }),

  restoreFolder: (f: AuthedFetch, id: string) =>
    f(`/space/folders/${id}/restore`, { method: 'POST' })
      .then((r) => json<SpaceFolder>(r, 'Could not restore that folder.')),

  purgeFolder: (f: AuthedFetch, id: string) =>
    f(`/space/folders/${id}/permanent`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not delete that folder permanently.'); }),

  /**
   * People in my organisation I can share with. Any signed-in caller — the
   * org People API is admin-only, which is why non-admins could not name a
   * colleague before this existed.
   */
  directory: (f: AuthedFetch, q: string) =>
    f(`/space/directory?q=${encodeURIComponent(q)}`)
      .then((r) => json<{ people: { id: string; displayName: string; email: string }[] }>(
        r, 'Could not load your directory.'))
      .then((b) => b.people),

  shares: (f: AuthedFetch, kind: 'files' | 'folders', id: string) =>
    f(`/space/${kind}/${id}/shares`)
      .then((r) => json<{ shares: SpaceShare[] }>(r, 'Could not load who has access.'))
      .then((b) => b.shares),

  share: (
    f: AuthedFetch, kind: 'files' | 'folders', id: string,
    grant: { userId: string } | { orgWide: true }, permission: SpaceShare['permission'],
  ) =>
    f(`/space/${kind}/${id}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ ...grant, permission }),
    }).then((r) => json<SpaceShare>(r, 'Could not share that.')),

  unshare: (f: AuthedFetch, kind: 'files' | 'folders', id: string, shareId: string) =>
    f(`/space/${kind}/${id}/shares/${shareId}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not remove that access.'); }),
};

// ---------------------------------------------------------------------------
//  Public links — "anyone with the link"
//
//  Built against docs/plans/LARGE_ATTACHMENTS.md. The management calls are
//  authenticated; resolving a link is NOT — that endpoint is the doorstep for
//  people with no account, and the landing page fetches it with plain fetch.
// ---------------------------------------------------------------------------

export interface PublicLink {
  id: string;
  /** Absent everywhere except the CREATE response — the token is shown once. */
  url?: string;
  expiresAt: string;
  downloadCount: number;
  maxDownloads: number | null;
  createdAt: string;
  revokedAt: string | null;
}

export const linkApi = {
  create: (f: AuthedFetch, fileId: string, expiresInDays: number) =>
    f(`/space/files/${fileId}/link`, {
      method: 'POST',
      body: JSON.stringify({ expiresInDays }),
    }).then((r) => json<PublicLink & { url: string }>(r, 'Could not create the link.')),

  list: (f: AuthedFetch, fileId: string) =>
    f(`/space/files/${fileId}/links`)
      .then((r) => json<{ links: PublicLink[] }>(r, 'Could not load the links.'))
      .then((b) => b.links),

  revoke: (f: AuthedFetch, fileId: string, linkId: string) =>
    f(`/space/files/${fileId}/links/${linkId}`, { method: 'DELETE' })
      .then((r) => { if (!r.ok) throw new Error('Could not revoke the link.'); }),
};

// ---------------------------------------------------------------------------
//  Org policy - the public-links kill switch.
//
//  GET is any signed-in user (the composer checks it before spending someone's
//  bytes on an upload that cannot be linked); PUT is OrgAdmin and audited.
//  Turning it off closes the TAP, not the handle: the anonymous resolve
//  predicate reads the flag, so existing links stop working immediately - and
//  reversibly, because the rows survive.
//
//  Owned by Space, per WORKING_IN_LANES.md 5a: the API client belongs with the
//  API. Core briefly had a second wrapper here for the admin toggle and the two
//  branches MERGED CLEANLY, which is how a duplicate gets onto main without
//  anyone being stopped. One client, and it lives with the endpoint.
// ---------------------------------------------------------------------------

export const settingsApi = {
  get: (f: AuthedFetch) =>
    f('/space/settings')
      .then((r) => json<{ allowPublicLinks: boolean }>(r, 'Could not load the sharing policy.')),

  set: (f: AuthedFetch, allowPublicLinks: boolean) =>
    f('/space/settings', { method: 'PUT', body: JSON.stringify({ allowPublicLinks }) })
      .then((r) => json<{ allowPublicLinks: boolean }>(r, 'Could not update the sharing policy.')),
};

/**
 * The landing page's metadata read. PLAIN fetch, no auth — the whole point is
 * that the reader has no account. Errors collapse to null: expired, revoked
 * and unknown are all the same "this link does not work" to a stranger, by
 * design (no oracle).
 */
export async function fetchLinkInfo(token: string): Promise<{
  name: string; sizeBytes: number; sharedBy: string | null; expiresAt: string;
} | null> {
  try {
    // The route is /meta, not /info — see SpaceLinkEndpoints.MetaAsync. It was
    // /info here, and because every failure collapses to null by design (no
    // oracle for a stranger), a working link was indistinguishable from a dead
    // one: every landing page showed "this link does not work".
    const res = await fetch(`/api/space/l/${encodeURIComponent(token)}/meta`);
    if (!res.ok) return null;
    const body = await res.json();
    // The wire calls it sharedByDisplayName; the page calls it sharedBy.
    // Mapped here, which is what a data layer is for — the landing page needs
    // no change.
    return {
      name: body.name,
      sizeBytes: body.sizeBytes,
      sharedBy: body.sharedByDisplayName ?? null,
      expiresAt: body.expiresAt,
    };
  } catch {
    return null;
  }
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
