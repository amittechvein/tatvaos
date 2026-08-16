'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  spaceApi, formatSize, linkApi, type PublicLink,
  type SpaceFile, type SpaceFolder, type SpaceListing, type SpaceScope, type SpaceShare,
} from '@/lib/space';
import { Icon } from '@/components/ui/Icon';
import { useUploads } from '@/components/space/UploadTray';

/**
 * The Space client: personal and organisational browsing, shared-with-me,
 * and trash — chosen by the route segment, which is also the rail nav.
 *
 * Folder navigation is component state, not the URL: the breadcrumb comes
 * from the server on every listing, so the page deep-links to a VIEW and
 * navigates folders within it. (Also sidesteps the useSearchParams-needs-
 * Suspense production-build trap.)
 */

type View = 'personal' | 'organisational' | 'shared' | 'trash';

const fileIcon = (mime: string): React.ComponentProps<typeof Icon>['name'] => {
  if (mime.startsWith('image/')) return 'bookmark';
  if (mime === 'application/pdf') return 'print';
  return 'draft';
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SpacePage({ params }: { params: Promise<{ view: string }> }) {
  const { view: viewParam } = use(params);
  const view: View = (['personal', 'organisational', 'shared', 'trash'] as const)
    .includes(viewParam as View) ? (viewParam as View) : 'personal';
  const browsing = view === 'personal' || view === 'organisational';
  const scope: SpaceScope = view === 'organisational' ? 'organisational' : 'personal';

  const { authedFetch } = useAuth();
  const { upload, jobs, drainCompleted } = useUploads();

  const [folderId, setFolderId] = useState<string | null>(null);
  const [listing, setListing] = useState<SpaceListing | null>(null);
  const [shared, setShared] = useState<{ folders: SpaceFolder[]; files: SpaceFile[] } | null>(null);
  const [trash, setTrash] = useState<{
    folders: SpaceFolder[]; files: SpaceFile[]; retentionDays: number; trashBytes: number;
  } | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SpaceFile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sharing, setSharing] = useState<{ kind: 'files' | 'folders'; item: SpaceFile | SpaceFolder } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The view is the route; changing it resets folder navigation with it.
  useEffect(() => { setFolderId(null); setQuery(''); setHits(null); }, [view]);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (browsing) setListing(await spaceApi.list(authedFetch, folderId, scope));
      else if (view === 'shared') setShared(await spaceApi.shared(authedFetch));
      else setTrash(await spaceApi.trash(authedFetch));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load Space.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, browsing, folderId, scope, view]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  // Search, debounced, across live file names.
  useEffect(() => {
    const term = query.trim();
    if (!term) { setHits(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      spaceApi.search(authedFetch, term)
        .then((r) => { if (!cancelled) setHits(r.files); })
        .catch(() => { if (!cancelled) setHits([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, authedFetch]);

  async function act(id: string, fn: () => Promise<unknown>, done?: string) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  function handleUpload(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;

    // Handed to the tray and forgotten. The page no longer waits: uploading
    // used to block this component, so the listing froze, navigation felt
    // broken, and a large file made Space look hung.
    upload(list, folderId, scope);
    if (fileInput.current) fileInput.current.value = '';
  }

  // Finished uploads appear in the listing as they land, without a refetch —
  // the API returns the completed FileDto, so there is nothing left to ask.
  useEffect(() => {
    const done = drainCompleted();
    if (done.length === 0) return;
    const here = done.filter((f) => f.folderId === folderId);
    if (here.length === 0) return;
    setListing((prev) => prev && ({
      ...prev,
      files: [...here, ...prev.files.filter((f) => !here.some((d) => d.id === f.id))],
      totalFiles: prev.totalFiles + here.length,
    }));
  }, [jobs, drainCompleted, folderId]);

  async function newFolder() {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    await act('new-folder', () => spaceApi.createFolder(authedFetch, name.trim(), folderId, scope));
  }

  const rename = (kind: 'files' | 'folders', item: SpaceFile | SpaceFolder) => {
    const name = window.prompt('Rename to', item.name);
    if (!name?.trim() || name.trim() === item.name) return;
    void act(item.id, () => kind === 'files'
      ? spaceApi.renameFile(authedFetch, item.id, name.trim())
      : spaceApi.renameFolder(authedFetch, item.id, name.trim()));
  };

  const canEdit = (p: SpaceFile['myPermission']) => p === 'edit' || p === 'owner';

  // ---- Row ------------------------------------------------------------
  function Row({ kind, item }: { kind: 'files' | 'folders'; item: SpaceFile | SpaceFolder }) {
    const isFile = kind === 'files';
    const file = isFile ? (item as SpaceFile) : null;
    const folder = isFile ? null : (item as SpaceFolder);
    const busy = busyId === item.id;
    const trashed = view === 'trash';

    return (
      <div className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 transition hover:bg-canvas/70">
        <Icon
          name={isFile ? fileIcon(file!.mimeType) : 'inbox'}
          className={`h-4.5 w-4.5 shrink-0 ${isFile ? 'text-ink-faint' : 'text-brand-600'}`}
        />
        {folder && !trashed ? (
          <button
            type="button"
            onClick={() => setFolderId(item.id)}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink hover:underline"
          >
            {item.name}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.name}</span>
        )}

        {item.isShared && (
          <span className="hidden shrink-0 text-xs text-ink-faint sm:inline" title="Shared">shared</span>
        )}
        <span className="hidden w-20 shrink-0 text-right text-xs text-ink-muted sm:block">
          {file ? formatSize(file.sizeBytes) : `${folder!.fileCount} files`}
        </span>
        <span className="hidden w-24 shrink-0 text-right text-xs text-ink-muted md:block">
          {when(item.updatedAt)}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          {trashed ? (
            <>
              <RowButton label="Restore" icon="refresh" disabled={busy}
                onClick={() => void act(item.id, () => isFile
                  ? spaceApi.restoreFile(authedFetch, item.id)
                  : spaceApi.restoreFolder(authedFetch, item.id), `${item.name} restored.`)} />
              <RowButton label="Delete forever" icon="trash" danger disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete "${item.name}" forever? This cannot be undone.`)) return;
                  void act(item.id, () => isFile
                    ? spaceApi.purgeFile(authedFetch, item.id)
                    : spaceApi.purgeFolder(authedFetch, item.id), `${item.name} deleted forever.`);
                }} />
            </>
          ) : (
            <>
              {file && (
                <RowButton label="Download" icon="forward" disabled={busy}
                  onClick={() => void spaceApi.download(authedFetch, file).catch(
                    (e: Error) => setError(e.message))} />
              )}
              {canEdit(item.myPermission) && (
                <RowButton label="Rename" icon="compose" disabled={busy} onClick={() => rename(kind, item)} />
              )}
              {(item.myPermission === 'owner' || (item.ownershipType === 'organisational' && canEdit(item.myPermission))) && (
                <RowButton label="Share" icon="reply-all" disabled={busy}
                  onClick={() => setSharing({ kind, item })} />
              )}
              {canEdit(item.myPermission) && (
                <RowButton label="Move to trash" icon="trash" danger disabled={busy}
                  onClick={() => void act(item.id, () => isFile
                    ? spaceApi.trashFile(authedFetch, item.id)
                    : spaceApi.trashFolder(authedFetch, item.id), `${item.name} moved to trash.`)} />
              )}
            </>
          )}
        </span>
      </div>
    );
  }

  // ---- Render ---------------------------------------------------------
  const folders = hits ? [] : browsing ? listing?.folders ?? [] : view === 'shared' ? shared?.folders ?? [] : trash?.folders ?? [];
  const files = hits ?? (browsing ? listing?.files ?? [] : view === 'shared' ? shared?.files ?? [] : trash?.files ?? []);
  const empty = !loading && folders.length === 0 && files.length === 0;

  const [dragging, setDragging] = useState(false);

  return (
    <div
      className="relative flex h-full flex-col bg-canvas p-3"
      // Dropping files onto the folder is the gesture everyone tries first.
      // dragOver must preventDefault or the browser navigates to the file.
      onDragOver={(e) => { if (browsing) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        if (!browsing) return;
        e.preventDefault();
        setDragging(false);
        handleUpload(e.dataTransfer.files);
      }}
    >
      {dragging && browsing && (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-brand-600 bg-brand-50/80">
          <span className="text-sm font-semibold text-brand-600">
            Drop to upload to {listing?.folder?.name ?? (scope === 'personal' ? 'My Space' : 'Organisation')}
          </span>
        </div>
      )}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface">
        {/* Header: breadcrumb (or view title), search, actions */}
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm">
            {browsing && listing ? (
              listing.breadcrumb.map((c, i) => {
                const last = i === listing.breadcrumb.length - 1;
                return (
                  // A real Fragment-free chain: keys live on the buttons.
                  <span key={c.id ?? 'root'} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <Icon name="chevron-right" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
                    {last ? (
                      <span className="truncate font-semibold text-ink">{c.name}</span>
                    ) : (
                      <button type="button" onClick={() => setFolderId(c.id)}
                        className="truncate text-ink-muted hover:text-ink hover:underline">
                        {c.name}
                      </button>
                    )}
                  </span>
                );
              })
            ) : (
              <span className="font-semibold text-ink">
                {view === 'shared' ? 'Shared with me' : view === 'trash' ? 'Trash' : 'Space'}
              </span>
            )}
          </nav>

          <div className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files"
              className="w-28 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-40"
            />
          </div>

          {browsing && (
            <>
              <button type="button" onClick={newFolder}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink">
                New folder
              </button>
              <button type="button" onClick={() => fileInput.current?.click()}
                className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700">
                Upload
              </button>
              <input ref={fileInput} type="file" multiple hidden
                onChange={(e) => handleUpload(e.target.files)} />
            </>
          )}
        </header>

        {view === 'trash' && trash && (
          <p className="border-b border-line bg-canvas/50 px-4 py-1.5 text-xs text-ink-muted">
            Items here are deleted forever after {trash.retentionDays} days. Trash still counts
            toward your storage — emptying it frees {formatSize(trash.trashBytes)}.
          </p>
        )}

        {(error || notice) && (
          <p className={`border-b border-line px-4 py-2 text-sm ${error ? 'text-danger' : 'text-ink-muted'}`}>
            {error ?? notice}
          </p>
        )}

        {/* Listing */}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
            </div>
          ) : empty ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center text-ink-faint">
              <Icon name="inbox" className="mb-3 h-10 w-10" />
              <p className="text-sm">
                {hits ? 'Nothing matches that search'
                  : view === 'trash' ? 'The trash is empty'
                  : view === 'shared' ? 'Nothing has been shared with you yet'
                  : 'Nothing here yet — upload a file or make a folder'}
              </p>
            </div>
          ) : (
            <>
              {folders.map((f) => <Row key={f.id} kind="folders" item={f} />)}
              {files.map((f) => <Row key={f.id} kind="files" item={f} />)}
            </>
          )}
        </div>
      </section>

      {sharing && (
        <ShareDialog
          kind={sharing.kind}
          item={sharing.item}
          onClose={() => setSharing(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

function RowButton({ label, icon, onClick, danger, disabled }: {
  label: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-canvas ${
        danger ? 'hover:text-danger' : 'hover:text-ink'} disabled:opacity-40`}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}

/**
 * Who has access. Org-wide sharing works for anyone allowed to share; naming
 * a colleague needs their user id, which today only the org People API
 * exposes — non-admins see the note instead of a broken picker. (A Space
 * directory endpoint is the known follow-up.)
 */
function ShareDialog({ kind, item, onClose, onChanged }: {
  kind: 'files' | 'folders';
  item: SpaceFile | SpaceFolder;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authedFetch } = useAuth();
  const [shares, setShares] = useState<SpaceShare[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- the chip picker ------------------------------------------------
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<{ id: string; displayName: string; email: string }[]>([]);
  const [chips, setChips] = useState<{ id: string; displayName: string }[]>([]);
  const [inviteLevel, setInviteLevel] = useState<SpaceShare['permission']>('view');

  const reload = useCallback(() => {
    spaceApi.shares(authedFetch, kind, item.id)
      .then(setShares)
      .catch((e: Error) => setErr(e.message));
  }, [authedFetch, kind, item.id]);

  useEffect(() => { reload(); }, [reload]);

  // Debounced directory search — a keystroke should not be a query.
  useEffect(() => {
    const q = term.trim();
    if (!q) { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      spaceApi.directory(authedFetch, q)
        .then((people) => { if (!cancelled) setHits(people.filter((p) => !chips.some((c) => c.id === p.id))); })
        .catch(() => { if (!cancelled) setHits([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, authedFetch, chips]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); reload(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  /** Send the invitations — every chip at the chosen level, in one go. */
  async function invite() {
    await run(async () => {
      for (const c of chips) {
        await spaceApi.share(authedFetch, kind, item.id, { userId: c.id }, inviteLevel);
      }
      setChips([]); setTerm('');
    });
  }

  // General access: the org-wide row, if any. Named audiences live below it.
  const orgShare = shares?.find((s) => s.orgWide) ?? null;
  const named = shares?.filter((s) => !s.orgWide) ?? [];

  return (
    <>
      <div className="fixed inset-0 z-[1190] bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed left-1/2 top-1/2 z-[1200] w-[min(520px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-raised">
        <div className="px-5 pt-5">
          <h2 className="mb-3 truncate text-base font-semibold text-ink">
            Share &ldquo;{item.name}&rdquo;
          </h2>

          {err && <p className="mb-2 text-sm text-danger">{err}</p>}

          {/* ---- Invite box: chips + a level for the whole invitation ---- */}
          <div className="relative mb-1">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1.5">
              {chips.map((c) => (
                <span key={c.id}
                      className="flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-xs text-ink">
                  {c.displayName}
                  <button type="button" aria-label={`Remove ${c.displayName}`}
                          onClick={() => setChips((p) => p.filter((x) => x.id !== c.id))}
                          className="text-ink-faint hover:text-danger">×</button>
                </span>
              ))}
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder={chips.length === 0 ? 'Add people by name or email' : ''}
                className="min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
              />
              {chips.length > 0 && (
                <select value={inviteLevel} disabled={busy}
                        onChange={(e) => setInviteLevel(e.target.value as SpaceShare['permission'])}
                        className="shrink-0 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink">
                  <option value="view">Viewer</option>
                  <option value="comment">Commenter</option>
                  <option value="edit">Editor</option>
                </select>
              )}
            </div>

            {hits.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-[1400] mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-raised">
                {hits.slice(0, 6).map((p) => (
                  <button key={p.id} type="button"
                          // mousedown, not click: click lands after blur and the
                          // list would already be gone.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setChips((c) => [...c, { id: p.id, displayName: p.displayName }]);
                            setTerm(''); setHits([]);
                          }}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-canvas">
                    <span className="block font-medium text-ink">{p.displayName}</span>
                    <span className="block text-xs text-ink-muted">{p.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {chips.length > 0 && (
            <div className="mb-3 mt-2 flex justify-end">
              <button type="button" disabled={busy} onClick={() => void invite()}
                      className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Sharing…' : 'Share'}
              </button>
            </div>
          )}

          {/* ---- People with access ---- */}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">People with access</h3>
          <div className="max-h-40 overflow-y-auto">
            {shares === null ? (
              <p className="py-1 text-xs text-ink-faint">Loading…</p>
            ) : named.length === 0 ? (
              <p className="py-1 text-xs text-ink-faint">
                Only you. {item.ownershipType === 'organisational'
                  ? 'This item belongs to the organisation, so colleagues may already reach it.'
                  : 'Nobody else can open this.'}
              </p>
            ) : named.map((s) => (
              <div key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">
                  {s.userDisplayName ?? s.userId}
                </span>
                {/* Changing the level is an upsert on the same audience, so the
                    select IS the edit — no separate save. */}
                <select
                  value={s.permission}
                  disabled={busy}
                  onChange={(e) => void run(() => spaceApi.share(
                    authedFetch, kind, item.id, { userId: s.userId! },
                    e.target.value as SpaceShare['permission']))}
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                >
                  <option value="view">Viewer</option>
                  <option value="comment">Commenter</option>
                  <option value="edit">Editor</option>
                </select>
                <button type="button" disabled={busy}
                        onClick={() => void run(() => spaceApi.unshare(authedFetch, kind, item.id, s.id))}
                        className="text-xs text-danger hover:underline">
                  remove
                </button>
              </div>
            ))}
          </div>

          {/* ---- General access ---- */}
          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">General access</h3>
          <div className="mb-1 flex items-center gap-2">
            <select
              value={orgShare ? 'org' : 'restricted'}
              disabled={busy}
              onChange={(e) => void run(() => e.target.value === 'org'
                ? spaceApi.share(authedFetch, kind, item.id, { orgWide: true }, orgShare?.permission ?? 'view')
                : spaceApi.unshare(authedFetch, kind, item.id, orgShare!.id))}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            >
              <option value="restricted">Restricted</option>
              <option value="org">Everyone in the organisation</option>
            </select>

            {orgShare && (
              <select
                value={orgShare.permission}
                disabled={busy}
                onChange={(e) => void run(() => spaceApi.share(
                  authedFetch, kind, item.id, { orgWide: true },
                  e.target.value as SpaceShare['permission']))}
                className="ml-auto rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              >
                <option value="view">Viewer</option>
                <option value="comment">Commenter</option>
                <option value="edit">Editor</option>
              </select>
            )}
          </div>
          <p className="mb-4 text-xs text-ink-muted">
            {orgShare
              ? `Anyone signed in to your organisation can ${
                  orgShare.permission === 'view' ? 'view' : orgShare.permission === 'comment' ? 'comment on' : 'edit'
                } this.`
              : 'Only people added above can open this.'}
            {/* No public links, deliberately: an audience is a colleague or the
                organisation. A link anyone on the internet can open is a
                different security decision and is not in this product yet. */}
          </p>
          {/* ---- Anyone with the link (files only) ---- */}
          {kind === 'files' && <PublicLinkSection fileId={item.id} />}
        </div>

        <div className="flex justify-end border-t border-line px-5 py-3">
          <button type="button" onClick={onClose}
                  className="rounded-full bg-brand-600 px-6 py-1.5 text-sm font-semibold text-white">
            Done
          </button>
        </div>
      </div>
    </>
  );
}


/**
 * "Anyone with the link" — the third audience, files only.
 *
 * The URL is shown ONCE, at creation: the server stores only a hash, so it
 * cannot be re-displayed later, the same rule as MFA recovery codes. The list
 * that follows shows that links exist, when they die, and how to revoke them
 * — everything except the secret.
 *
 * Degrades to silence while the backend endpoint does not exist yet: a
 * feature that is not deployed should be absent, not broken.
 */
function PublicLinkSection({ fileId }: { fileId: string }) {
  const { authedFetch } = useAuth();
  const [links, setLinks] = useState<PublicLink[] | 'unsupported' | null>(null);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(30);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    authedFetch(`/space/files/${fileId}/links`)
      .then(async (r) => {
        if (r.status === 404) { setLinks('unsupported'); return; }
        const b = await r.json().catch(() => ({ links: [] }));
        setLinks(b.links ?? []);
      })
      .catch(() => setLinks('unsupported'));
  }, [authedFetch, fileId]);

  useEffect(() => { reload(); }, [reload]);

  if (links === 'unsupported' || links === null) return null;

  const live = links.filter((l) => !l.revokedAt);

  return (
    <>
      <h3 className="mb-1 mt-4 text-sm font-semibold text-ink">Anyone with the link</h3>

      {freshUrl ? (
        <div className="mb-2 rounded-lg border border-brand-600/40 bg-brand-50 p-2.5">
          <p className="mb-1.5 text-xs text-ink">
            Link created. <strong>Copy it now</strong> — for safety it cannot be
            shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs text-ink">
              {freshUrl}
            </code>
            <button type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(freshUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="shrink-0 rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <select value={expiry} disabled={busy}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                  className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
            <option value={7}>Expires in 7 days</option>
            <option value={30}>Expires in 30 days</option>
            <option value={90}>Expires in 90 days</option>
            <option value={365}>Expires in 1 year</option>
          </select>
          <button type="button" disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    linkApi.create(authedFetch, fileId, expiry)
                      .then((l) => { setFreshUrl(l.url); reload(); })
                      .catch(() => {/* the section stays; the button re-enables */})
                      .finally(() => setBusy(false));
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink disabled:opacity-50">
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </div>
      )}

      {live.length > 0 && (
        <div className="mb-1">
          {live.map((l) => (
            <div key={l.id} className="flex items-center gap-2 py-1 text-xs text-ink-muted">
              <span className="min-w-0 flex-1 truncate">
                Expires {new Date(l.expiresAt).toLocaleDateString(undefined,
                  { day: 'numeric', month: 'short', year: 'numeric' })}
                {l.downloadCount > 0 && ` · downloaded ${l.downloadCount}×`}
              </span>
              <button type="button" disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        linkApi.revoke(authedFetch, fileId, l.id)
                          .then(() => { if (freshUrl) setFreshUrl(null); reload(); })
                          .catch(() => {})
                          .finally(() => setBusy(false));
                      }}
                      className="shrink-0 text-danger hover:underline">
                revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mb-1 text-xs text-ink-muted">
        Anyone on the internet with the link can download this file until it
        expires or you revoke it. Nothing else in Space is reachable from it.
      </p>
    </>
  );
}
