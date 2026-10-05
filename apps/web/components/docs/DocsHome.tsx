'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { formatDateShort } from '@/lib/dates';
import { docHref, docsApi, type DocsView } from '@/lib/docs';
import { spaceApi, type SpaceFile } from '@/lib/space';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Kit';
import { DocGlyph } from './icons';

type Row = SpaceFile & { isStarred?: boolean; ownerDisplayName?: string | null; parentName?: string | null };

const TITLES: Record<DocsView, string> = {
  recent: 'Recent documents',
  owned: 'Owned by me',
  shared: 'Shared with me',
  starred: 'Starred',
  trash: 'Trash',
};

const EMPTY: Record<DocsView, string> = {
  recent: 'No documents yet. Start one above.',
  owned: 'You have not created any documents yet.',
  shared: 'Nobody has shared a document with you yet.',
  starred: 'Star a document to keep it here.',
  trash: 'The trash is empty.',
};

/**
 * The Docs home page: a "start a new document" strip, then one list per
 * rail view. Every row is a Space file; star, trash, restore and delete go
 * through spaceApi, so a document behaves identically here and in Space.
 */
export function DocsHome({ view }: { view: DocsView }) {
  const { authedFetch, user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Space owns the trash period; asked, not restated, so the sentence below
  // cannot drift from what the purge actually does.
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  // null = still asking. Docs is off unless the operator switched it on.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    docsApi.status(authedFetch).then(setEnabled).catch(() => setEnabled(false));
  }, [authedFetch]);

  useEffect(() => {
    if (view !== 'trash') return;
    spaceApi.trash(authedFetch).then((t) => setRetentionDays(t.retentionDays)).catch(() => {});
  }, [view, authedFetch]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await docsApi.list(authedFetch, view, query.trim());
      setRows(r.documents);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your documents.');
      setRows([]);
    }
  }, [authedFetch, view, query]);

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  async function create(scope: 'personal' | 'organisational') {
    setCreating(true);
    setError(null);
    try {
      const d = await docsApi.create(authedFetch, undefined, null, scope);
      router.push(docHref(d.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the document.');
      setCreating(false);
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  }

  const canEdit = (p: string) => p === 'edit' || p === 'owner';

  if (enabled === null) return <Spinner className="py-16" />;
  if (!enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <DocGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">Docs is not switched on for your organisation yet.</p>
        <p className="max-w-md text-sm text-ink-muted">
          It is being introduced one organisation at a time. Your documents in Space are unaffected.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 scroll-thin">
      {view !== 'trash' && (
        <section className="rounded-card border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Start a new document</h2>
          <div className="flex flex-wrap gap-4">
            <NewTile label="Blank document" hint="In My Space" disabled={creating}
              onClick={() => void create('personal')} />
            <NewTile label="Organisation document" hint="Everyone in your organisation can edit"
              disabled={creating} onClick={() => void create('organisational')} />
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-col rounded-card border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{TITLES[view]}</h1>
          <div className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search documents" aria-label="Search documents"
              className="w-32 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-48" />
          </div>
        </header>

        {error && <p className="border-b border-line px-4 py-2 text-sm text-danger">{error}</p>}
        {view === 'trash' && (
          <p className="border-b border-line bg-canvas/50 px-4 py-1.5 text-xs text-ink-muted">
            Documents here are deleted forever
            {retentionDays ? ` after ${retentionDays} days` : ' after a while'}, with their history and comments.
          </p>
        )}

        {rows === null ? (
          <Spinner className="py-16" />
        ) : rows.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-ink-faint">
            {query ? 'No document matches that search.' : EMPTY[view]}
          </p>
        ) : (
          <div role="table" aria-label={TITLES[view]}>
            <div role="row" className="hidden border-b border-line px-4 py-2 text-xs font-medium text-ink-muted sm:flex">
              <span role="columnheader" className="flex-1">Name</span>
              <span role="columnheader" className="w-40">Owner</span>
              <span role="columnheader" className="w-28 text-right">{view === 'trash' ? 'Deleted' : 'Last modified'}</span>
              <span className="w-24" />
            </div>
            {rows.map((d) => {
              const busy = busyId === d.id;
              const owner = d.ownerUserId === user?.id ? 'me'
                : d.ownershipType === 'organisational' ? 'Organisation'
                : d.ownerDisplayName ?? '—';
              return (
                <div role="row" key={d.id}
                  className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 transition hover:bg-canvas/70">
                  <DocGlyph className="h-5 w-5 shrink-0" />
                  <span role="cell" className="min-w-0 flex-1">
                    {view === 'trash' ? (
                      <span className="block truncate text-sm text-ink">{d.name}</span>
                    ) : (
                      <Link href={docHref(d.id)} className="block truncate text-sm font-medium text-ink hover:underline">
                        {d.name}
                      </Link>
                    )}
                    {d.parentName && (
                      <span className="block truncate text-xs text-ink-faint">{d.parentName}</span>
                    )}
                  </span>
                  <span role="cell" className="hidden w-40 truncate text-xs text-ink-muted sm:block">
                    {owner}{d.isShared && <span className="ml-1 text-ink-faint">· shared</span>}
                  </span>
                  <span role="cell" className="hidden w-28 text-right text-xs text-ink-muted sm:block">
                    {formatDateShort((view === 'trash' ? d.deletedAt : d.updatedAt) ?? d.updatedAt)}
                  </span>
                  <span className="flex w-24 shrink-0 items-center justify-end gap-1">
                    {view === 'trash' ? (
                      <>
                        <RowButton label="Restore" icon="refresh" disabled={busy}
                          onClick={() => void act(d.id, () => spaceApi.restoreFile(authedFetch, d.id))} />
                        <RowButton label="Delete forever" icon="trash" danger disabled={busy}
                          onClick={() => {
                            if (!window.confirm(`Delete "${d.name}" forever? Its history and comments go with it. This cannot be undone.`)) return;
                            void act(d.id, () => spaceApi.purgeFile(authedFetch, d.id));
                          }} />
                      </>
                    ) : (
                      <>
                        <RowButton label={d.isStarred ? 'Remove star' : 'Star'}
                          icon={d.isStarred ? 'star-filled' : 'star'} disabled={busy}
                          onClick={() => void act(d.id, () => authedFetch(`/space/files/${d.id}/star`,
                            { method: d.isStarred ? 'DELETE' : 'PUT' }))} />
                        {canEdit(d.myPermission) && (
                          <RowButton label="Move to trash" icon="trash" danger disabled={busy}
                            onClick={() => void act(d.id, () => spaceApi.trashFile(authedFetch, d.id))} />
                        )}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function NewTile({ label, hint, onClick, disabled }: {
  label: string; hint: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="group flex w-40 flex-col items-start gap-2 text-left disabled:opacity-50">
      <span className="flex h-48 w-40 items-center justify-center rounded-lg border border-line bg-white transition group-hover:border-brand-600">
        <svg viewBox="0 0 24 24" className="h-12 w-12" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="#1a73e8" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-sm font-medium text-ink">{label}</span>
      <span className="-mt-1.5 text-xs text-ink-faint">{hint}</span>
    </button>
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
