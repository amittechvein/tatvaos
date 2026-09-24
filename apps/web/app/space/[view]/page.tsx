'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { formatDateShort } from '@/lib/dates';
import { useAuth } from '@/lib/auth';
import {
  spaceApi, formatSize,
  type SpaceFile, type SpaceFolder, type SpaceListing, type SpaceScope,
} from '@/lib/space';
import { Icon } from '@/components/ui/Icon';
import { useUploads } from '@/components/space/UploadTray';
import { ShareDialog } from '@/components/space/ShareDialog';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { docsApi, docHref, isDocument } from '@/lib/docs';
import { Spinner } from '@/components/ui/Kit';

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

// Pinned to en-IN in lib/dates.ts. This used to pass `undefined`, which meant
// the field ORDER came from the viewer's browser — the same screen read
// "19 Sep 2026" here and "Sep 19, 2026" on a US-configured machine.
const when = formatDateShort;

export default function SpacePage({ params }: { params: Promise<{ view: string }> }) {
  const { view: viewParam } = use(params);
  const view: View = (['personal', 'organisational', 'shared', 'trash'] as const)
    .includes(viewParam as View) ? (viewParam as View) : 'personal';
  const browsing = view === 'personal' || view === 'organisational';
  const scope: SpaceScope = view === 'organisational' ? 'organisational' : 'personal';

  const { authedFetch } = useAuth();
  const router = useRouter();
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
        ) : file && isDocument(file) && !trashed ? (
          // A TatvaOS document opens in Docs. Its Download button still
          // works — it saves the HTML rendering the server keeps current.
          <Link href={docHref(file.id)}
            className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:underline">
            {item.name}
          </Link>
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
              <button type="button"
                onClick={() => void docsApi.create(authedFetch, undefined, folderId, scope)
                  .then((d) => router.push(docHref(d.id)))
                  .catch((e: Error) => setError(e.message))}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink">
                New document
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
            <Spinner className="h-full" />
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
