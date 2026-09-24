'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useAuth } from '@/lib/auth';
import { formatDateShort } from '@/lib/dates';
import { toBase64 } from '@/lib/docs';
import { spaceApi } from '@/lib/space';
import { sheetHref, sheetsApi, type SheetRow, type SheetsView } from '@/lib/sheets/api';
import { SheetsModel } from '@/lib/sheets/model';
import { TEMPLATES, type Template } from '@/lib/sheets/templates';
import { readXlsx, writeXlsx } from '@/lib/sheets/io/xlsx';
import { readCsv } from '@/lib/sheets/io/csv';
import { workbookHtml, workbookText } from '@/lib/sheets/render';
import type { WorkbookData } from '@/lib/sheets/workbook';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Kit';
import { SheetGlyph, SI } from './icons';

const TITLES: Record<SheetsView, string> = {
  recent: 'Recent spreadsheets', owned: 'Owned by me', shared: 'Shared with me', starred: 'Starred', trash: 'Trash',
};
const EMPTY: Record<SheetsView, string> = {
  recent: 'No spreadsheets yet. Start one above.',
  owned: 'You have not created any spreadsheets yet.',
  shared: 'Nobody has shared a spreadsheet with you yet.',
  starred: 'Star a spreadsheet to keep it here.',
  trash: 'The trash is empty.',
};

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * Create a spreadsheet that starts with content (a template or an imported
 * file): the file is created empty, then its first CHECKPOINT carries the
 * whole Yjs state — the same call every editor makes after editing. No
 * second way of writing content exists on the server.
 */
async function createWith(authedFetch: ReturnType<typeof useAuth>['authedFetch'], title: string, data: WorkbookData, scope: 'personal' | 'organisational') {
  const created = await sheetsApi.create(authedFetch, title, null, scope);
  const doc = new Y.Doc();
  const model = new SheetsModel(doc);
  try {
    model.load(data, 'replace');
    const snap = model.snapshot();
    const locale = model.locale();
    await sheetsApi.checkpointSheet(authedFetch, created.id, {
      state: toBase64(Y.encodeStateAsUpdate(doc)), upToSeq: 0,
      html: workbookHtml(snap, locale), text: workbookText(snap, locale).slice(0, 2_000_000),
      xlsx: toBase64(await writeXlsx(snap)),
    });
  } finally {
    model.destroy();
    doc.destroy();
  }
  return created.id;
}

export function SheetsHome({ view }: { view: SheetsView }) {
  const { authedFetch, user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // null = still asking. Sheets has its own switch, off unless the platform
  // operator turned it on for this organisation.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    sheetsApi.status(authedFetch).then(setEnabled).catch(() => setEnabled(false));
  }, [authedFetch]);

  useEffect(() => {
    if (view !== 'trash') return;
    spaceApi.trash(authedFetch).then((t) => setRetentionDays(t.retentionDays)).catch(() => {});
  }, [view, authedFetch]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    try {
      const r = await sheetsApi.list(authedFetch, view, query.trim());
      setRows(r.documents);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your spreadsheets.');
      setRows([]);
    }
  }, [authedFetch, view, query, enabled]);

  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setError(null);
    try {
      router.push(sheetHref(await fn()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the spreadsheet.');
      setBusy(null);
    }
  }

  const blank = (scope: 'personal' | 'organisational') =>
    run('blank', async () => (await sheetsApi.create(authedFetch, undefined, null, scope)).id);

  const fromTemplate = (t: Template) => run(t.id, () => createWith(authedFetch, t.name, t.build(), 'personal'));

  async function importFile(file: File) {
    if (file.size > MAX_IMPORT_BYTES) { setError('That file is larger than 20 MB, which is more than Sheets can import.'); return; }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xls') || lower.endsWith('.ods')) {
      setError('Old Excel (.xls) and OpenDocument (.ods) files cannot be imported yet. Save the file as .xlsx or .csv and import that.');
      return;
    }
    await run('import', async () => {
      const title = file.name.replace(/\.[^.]+$/, '') || 'Imported spreadsheet';
      let data: WorkbookData;
      if (lower.endsWith('.xlsx')) data = await readXlsx(new Uint8Array(await file.arrayBuffer()));
      else if (/\.(csv|tsv|txt)$/.test(lower)) {
        const s = readCsv(await file.text(), lower.endsWith('.tsv') ? '\t' : undefined);
        s.name = 'Sheet1';
        data = { sheets: [s] };
      } else throw new Error('Choose an .xlsx, .csv or .tsv file.');
      return createWith(authedFetch, title, data, 'personal');
    });
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try { await fn(); await load(); } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally { setBusyId(null); }
  }

  const canEdit = (p: string) => p === 'edit' || p === 'owner';

  if (enabled === null) return <Spinner className="py-16" />;
  if (!enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <SheetGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">Sheets is not switched on for your organisation yet.</p>
        <p className="max-w-md text-sm text-ink-muted">
          It is being introduced one organisation at a time. Your files in Space are unaffected.
        </p>
      </div>
    );
  }

  const templates = showAll ? TEMPLATES : TEMPLATES.slice(0, 4);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 scroll-thin">
      {view !== 'trash' && (
        <section className="rounded-card border border-line bg-surface p-4">
          <div className="mb-3 flex items-center gap-3">
            <h2 className="flex-1 text-sm font-semibold text-ink">Start a new spreadsheet</h2>
            <button type="button" onClick={() => setShowAll((x) => !x)} className="text-xs text-brand-600 hover:underline">
              {showAll ? 'Fewer templates' : `All templates (${TEMPLATES.length})`}
            </button>
          </div>
          <div className="scroll-thin flex gap-4 overflow-x-auto pb-1">
            <Tile label="Blank spreadsheet" hint="In My Space" disabled={busy !== null} busy={busy === 'blank'}
              onClick={() => void blank('personal')}><PlusMark /></Tile>
            <Tile label="Organisation sheet" hint="Everyone in your organisation can edit" disabled={busy !== null}
              onClick={() => void blank('organisational')}><PlusMark /></Tile>
            <Tile label="Import Excel or CSV" hint=".xlsx, .csv, .tsv" disabled={busy !== null} busy={busy === 'import'}
              onClick={() => fileInput.current?.click()}><SI.upload className="h-10 w-10 text-[#188038]" /></Tile>
            {templates.map((t) => (
              <Tile key={t.id} label={t.name} hint={`${t.group} · ${t.description}`} disabled={busy !== null} busy={busy === t.id}
                onClick={() => void fromTemplate(t)}><TemplateMark /></Tile>
            ))}
          </div>
          <input ref={fileInput} type="file" hidden accept=".xlsx,.csv,.tsv,.txt,.xls,.ods"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </section>
      )}

      <section className="flex min-h-0 flex-col rounded-card border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{TITLES[view]}</h1>
          <div className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5">
            <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search spreadsheets" aria-label="Search spreadsheets"
              className="w-32 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-48" />
          </div>
        </header>

        {error && <p role="alert" className="border-b border-line px-4 py-2 text-sm text-danger">{error}</p>}
        {view === 'trash' && (
          <p className="border-b border-line bg-canvas/50 px-4 py-1.5 text-xs text-ink-muted">
            Spreadsheets here are deleted forever{retentionDays ? ` after ${retentionDays} days` : ' after a while'}, with their history and comments.
          </p>
        )}

        {rows === null ? <Spinner className="py-16" /> : rows.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-ink-faint">{query ? 'No spreadsheet matches that search.' : EMPTY[view]}</p>
        ) : (
          <div role="table" aria-label={TITLES[view]}>
            <div role="row" className="hidden border-b border-line px-4 py-2 text-xs font-medium text-ink-muted sm:flex">
              <span role="columnheader" className="flex-1">Name</span>
              <span role="columnheader" className="w-40">Owner</span>
              <span role="columnheader" className="w-28 text-right">{view === 'trash' ? 'Deleted' : 'Last modified'}</span>
              <span className="w-24" />
            </div>
            {rows.map((d) => {
              const b = busyId === d.id;
              const owner = d.ownerUserId === user?.id ? 'me' : d.ownershipType === 'organisational' ? 'Organisation' : d.ownerDisplayName ?? '—';
              return (
                <div role="row" key={d.id} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 transition hover:bg-canvas/70">
                  <SheetGlyph className="h-5 w-5 shrink-0" />
                  <span role="cell" className="min-w-0 flex-1">
                    {view === 'trash' ? <span className="block truncate text-sm text-ink">{d.name}</span> : (
                      <Link href={sheetHref(d.id)} className="block truncate text-sm font-medium text-ink hover:underline">{d.name}</Link>
                    )}
                    {d.parentName && <span className="block truncate text-xs text-ink-faint">{d.parentName}</span>}
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
                        <RowButton label="Restore" icon="refresh" disabled={b} onClick={() => void act(d.id, () => spaceApi.restoreFile(authedFetch, d.id))} />
                        <RowButton label="Delete forever" icon="trash" danger disabled={b} onClick={() => {
                          if (!window.confirm(`Delete "${d.name}" forever? Its history and comments go with it. This cannot be undone.`)) return;
                          void act(d.id, () => spaceApi.purgeFile(authedFetch, d.id));
                        }} />
                      </>
                    ) : (
                      <>
                        <RowButton label={d.isStarred ? 'Remove star' : 'Star'} icon={d.isStarred ? 'star-filled' : 'star'} disabled={b}
                          onClick={() => void act(d.id, () => authedFetch(`/space/files/${d.id}/star`, { method: d.isStarred ? 'DELETE' : 'PUT' }))} />
                        {canEdit(d.myPermission) && (
                          <RowButton label="Move to trash" icon="trash" danger disabled={b} onClick={() => void act(d.id, () => spaceApi.trashFile(authedFetch, d.id))} />
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

const PlusMark = () => (
  <svg viewBox="0 0 24 24" className="h-12 w-12" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="#188038" strokeWidth="1.8" strokeLinecap="round" /></svg>
);
const TemplateMark = () => (
  <svg viewBox="0 0 48 48" className="h-16 w-16" aria-hidden="true">
    <rect x="6" y="8" width="36" height="32" rx="2" fill="#e6f4ea" stroke="#188038" />
    <path d="M6 16h36M6 24h36M6 32h36M18 8v32M30 8v32" stroke="#188038" strokeWidth="0.8" />
  </svg>
);

function Tile({ label, hint, onClick, disabled, busy, children }: {
  label: string; hint: string; onClick: () => void; disabled?: boolean; busy?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={hint}
      className="group flex w-36 shrink-0 flex-col items-start gap-2 text-left disabled:opacity-50">
      <span className="flex h-40 w-36 items-center justify-center rounded-lg border border-line bg-white transition group-hover:border-[#188038] dark:bg-canvas">
        {busy ? <Spinner /> : children}
      </span>
      <span className="text-sm font-medium text-ink">{label}</span>
      <span className="-mt-1.5 line-clamp-2 text-xs text-ink-faint">{hint}</span>
    </button>
  );
}

function RowButton({ label, icon, onClick, danger, disabled }: {
  label: string; icon: React.ComponentProps<typeof Icon>['name']; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-canvas ${danger ? 'hover:text-danger' : 'hover:text-ink'} disabled:opacity-40`}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}
