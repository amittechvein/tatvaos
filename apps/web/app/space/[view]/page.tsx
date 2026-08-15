'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  spaceApi, formatSize, UploadRefusedError,
  type SpaceFile, type SpaceFolder, type SpaceListing, type SpaceScope, type SpaceShare,
} from '@/lib/space';
import { Icon } from '@/components/ui/Icon';

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
  const [uploading, setUploading] = useState(false);
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

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        await spaceApi.upload(authedFetch, folderId, scope, f);
      }
      setNotice(files.length === 1 ? `${files[0]?.name} uploaded.` : `${files.length} files uploaded.`);
      await load();
    } catch (e) {
      if (e instanceof UploadRefusedError) {
        // The reason is machine-readable on purpose — say the right thing.
        setError(e.reason === 'full'
          ? `${e.message} Free space in the trash, or ask an admin to raise the allocation.`
          : e.message);
      } else {
        setError(e instanceof Error ? e.message : 'The upload failed.');
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

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

  return (
    <div className="flex h-full flex-col bg-canvas p-3">
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
              <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}
                className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50">
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
              <input ref={fileInput} type="file" multiple hidden
                onChange={(e) => void handleUpload(e.target.files)} />
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
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState<SpaceShare['permission']>('view');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    spaceApi.shares(authedFetch, kind, item.id).then(setShares).catch((e: Error) => setErr(e.message));
  }, [authedFetch, kind, item.id]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    void authedFetch('/org/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { id: string; displayName: string; status: string }[]) =>
        setPeople(list.filter((p) => p.status === 'active')))
      .catch(() => setPeople([]));
  }, [authedFetch]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); reload(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="fixed inset-0 z-[1190] bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed left-1/2 top-1/2 z-[1200] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-surface p-5 shadow-raised">
        <h2 className="mb-1 text-base font-semibold text-ink">Share “{item.name}”</h2>
        <p className="mb-3 text-xs text-ink-muted">
          A folder share reaches everything inside it. Levels: view, comment, edit.
        </p>

        {err && <p className="mb-2 text-sm text-danger">{err}</p>}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {people.length > 0 ? (
            <select value={userId} onChange={(e) => setUserId(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
              <option value="">Choose a person…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
          ) : (
            <span className="flex-1 text-xs text-ink-faint">
              Person-by-person sharing needs the people list (admins only today) — use
              org-wide below, or ask an admin.
            </span>
          )}
          <select value={level} onChange={(e) => setLevel(e.target.value as SpaceShare['permission'])}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
            <option value="view">view</option>
            <option value="comment">comment</option>
            <option value="edit">edit</option>
          </select>
          <button type="button" disabled={busy || !userId}
            onClick={() => void run(() => spaceApi.share(authedFetch, kind, item.id, { userId }, level))}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            Share
          </button>
        </div>

        <button type="button" disabled={busy}
          onClick={() => void run(() => spaceApi.share(authedFetch, kind, item.id, { orgWide: true }, level))}
          className="mb-3 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink">
          Share with the whole organisation ({level})
        </button>

        <div className="max-h-52 overflow-y-auto border-t border-line pt-2">
          {shares === null ? (
            <p className="text-xs text-ink-faint">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs text-ink-faint">Nobody else has access.</p>
          ) : shares.map((s) => (
            <div key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">
                {s.orgWide ? 'Everyone in the organisation' : s.userDisplayName ?? s.userId}
              </span>
              <span className="shrink-0 text-xs text-ink-muted">{s.permission}</span>
              <button type="button" disabled={busy}
                onClick={() => void run(() => spaceApi.unshare(authedFetch, kind, item.id, s.id))}
                className="shrink-0 text-xs text-danger hover:underline">
                remove
              </button>
            </div>
          ))}
        </div>

        <div className="mt-4 text-right">
          <button type="button" onClick={onClose}
            className="rounded-lg border border-line px-4 py-1.5 text-sm text-ink-muted hover:bg-canvas hover:text-ink">
            Done
          </button>
        </div>
      </div>
    </>
  );
}
