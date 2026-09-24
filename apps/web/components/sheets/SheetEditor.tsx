'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as Y from 'yjs';

import { useAuth } from '@/lib/auth';
import { toBase64, fromBase64, type CommentThread, type DocumentMeta, type DocVersion } from '@/lib/docs';
import { DocsLiveProvider, type LiveEvent } from '@/lib/docsLive';
import { formatDateTime } from '@/lib/dates';
import { sheetsApi, SheetsError, sheetHref } from '@/lib/sheets/api';
import { SheetsModel } from '@/lib/sheets/model';
import { parseRect, rectName, colName, type Rect } from '@/lib/sheets/engine/address';
import { formatValue } from '@/lib/sheets/engine/format';
import { workbookHtml, workbookText, rangeForAi } from '@/lib/sheets/render';
import { printSheet } from '@/lib/sheets/print';
import { readXlsx, writeXlsx } from '@/lib/sheets/io/xlsx';
import { readCsv, writeCsv } from '@/lib/sheets/io/csv';
import type { CellFormat } from '@/lib/sheets/workbook';
import { ShareDialog } from '@/components/space/ShareDialog';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Kit';
import { MenuBar, type MenuItem } from '@/components/docs/Toolbar';
import { CommentsPanel } from '@/components/docs/CommentsPanel';
import { HistoryPanel } from '@/components/docs/HistoryPanel';
import { I } from '@/components/docs/icons';
import '@/components/docs/docs.css';

import { Grid, cellLabel, displayText, type GridHandle, type Selection } from './Grid';
import { FormulaBar } from './FormulaBar';
import { SheetsToolbar, NUMBER_FORMATS } from './SheetsToolbar';
import { SheetTabs } from './SheetTabs';
import { SheetsAiPanel, type AiContext } from './SheetsAiPanel';
import { SheetGlyph } from './icons';
import type { Remote } from './paint';

// ============================================================================
//  The spreadsheet editor.
//
//  SheetEditor loads the metadata and owns the live connection (the same
//  DocsLiveProvider Docs uses — a spreadsheet is a Docs file with a
//  different editor); Workspace is the editor, created once a connection
//  exists so the model is bound to the right Y.Doc from its first render.
//
//  Saving is automatic, in two layers, exactly as in Docs:
//    · every edit goes over the live channel and is stored when acked
//      ("All changes saved");
//    · a CHECKPOINT a few seconds after editing stops sends the whole state
//      plus an .xlsx, so the copy in Space (download, attach to mail) is a
//      real Excel file and version history stays current.
// ============================================================================

const CHECKPOINT_IDLE_MS = 4_000;
const CHECKPOINT_MAX_MS = 20_000;
/** Largest file accepted for import. The engine is in the tab; this keeps a mistake from freezing it. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const CURSOR_COLOURS = ['#e8710a', '#1e8e3e', '#d93025', '#9334e6', '#12b5cb', '#f538a0', '#188038', '#1a73e8'];
const colourFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CURSOR_COLOURS[h % CURSOR_COLOURS.length]!;
};

type Panel = 'comments' | 'history' | 'ai' | null;

interface CellAnchor { sheet: string; row: string; col: string }

export function SheetEditor({ id }: { id: string }) {
  const { authedFetch } = useAuth();
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [live, setLive] = useState<{ provider: DocsLiveProvider; model: SheetsModel } | null>(null);
  const eventSink = useRef<(e: LiveEvent) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    sheetsApi.get(authedFetch, id)
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch((e: unknown) => {
        if (!cancelled) setError({
          message: e instanceof Error ? e.message : 'Could not open this spreadsheet.',
          status: e instanceof SheetsError || (e as { status?: number }).status ? (e as { status: number }).status : 0,
        });
      });
    return () => { cancelled = true; };
  }, [authedFetch, id]);

  useEffect(() => {
    if (!meta || meta.deletedAt) return;
    // The model is created and destroyed WITH the connection, in one
    // effect. Created in a useMemo and destroyed in a separate cleanup, it
    // was torn down by React's development double-run and never rebuilt —
    // edits were saved but the grid stopped showing them.
    const p = new DocsLiveProvider(id, () => sheetsApi.ticket(authedFetch, id), (e) => eventSink.current(e));
    const m = new SheetsModel(p.doc);
    setLive({ provider: p, model: m });
    return () => { m.destroy(); p.destroy(); setLive(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.deletedAt, id]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
        <SheetGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">
          {error.status === 404 ? 'This spreadsheet does not exist, or you do not have access to it.' : error.message}
        </p>
        <Link href="/sheets" className="text-sm text-brand-600 hover:underline">Go to Sheets</Link>
      </div>
    );
  }
  if (!meta) return <div className="flex h-screen items-center justify-center bg-canvas"><Spinner /></div>;
  if (meta.deletedAt) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
        <SheetGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">&ldquo;{meta.title}&rdquo; is in the trash.</p>
        <p className="text-sm text-ink-muted">Restore it from the trash in Sheets or Space to open it again.</p>
        <Link href="/sheets/trash" className="text-sm text-brand-600 hover:underline">Open the trash</Link>
      </div>
    );
  }
  if (!live) return <div className="flex h-screen items-center justify-center bg-canvas"><Spinner /></div>;
  return <Workspace key={live.provider.doc.guid} meta={meta} setMeta={setMeta} provider={live.provider} model={live.model} eventSink={eventSink} />;
}

// ---------------------------------------------------------------------------

function Workspace({ meta, setMeta, provider, model, eventSink }: {
  meta: DocumentMeta;
  setMeta: React.Dispatch<React.SetStateAction<DocumentMeta | null>>;
  provider: DocsLiveProvider;
  model: SheetsModel;
  eventSink: React.MutableRefObject<(e: LiveEvent) => void>;
}) {
  const { authedFetch } = useAuth();
  const id = meta.id;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => provider.subscribe(rerender), [provider]);

  // Development only: the live model on window, so a check in the browser
  // console can read what the grid should be showing. Never in production.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    (window as unknown as { __sheets?: SheetsModel }).__sheets = model;
  }, [model]);

  const perm = provider.status === 'connecting' && provider.perm === 'view' ? meta.myPermission : provider.perm;
  const canEdit = perm === 'edit' || perm === 'owner';
  const canComment = canEdit || perm === 'comment';
  const canShare = meta.myPermission === 'owner' || (meta.ownershipType === 'organisational' && canEdit);
  const lostAccess = perm === 'none';
  const synced = provider.status === 'synced';

  // A brand-new spreadsheet has no sheets until someone seeds one. Every
  // editor that finds it empty seeds the SAME update (model.ts, seedUpdate),
  // so two people opening it at once still get one Sheet1.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!synced || ready) return;
    if (canEdit) model.ensureSeeded();
    if (model.sheetIds().length > 0) setReady(true);
  }, [synced, ready, canEdit, model, provider.lastSeq]);
  useEffect(() => model.subscribe(() => { if (model.sheetIds().length > 0) setReady(true); }), [model]);

  const [sheetId, setSheetId] = useState<string>('');
  const [tick, modelTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => model.subscribe((e) => { if (e.structural || e.layout) modelTick(); }), [model]);
  // tick is the signal that the Y.Doc's sheets changed; the list is read from the model.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sheets = useMemo(() => (ready ? model.sheets() : []), [ready, model, tick]);
  useEffect(() => {
    // Keep the active sheet valid: first visible one if ours was deleted or hidden.
    if (!ready) return;
    const current = model.meta(sheetId);
    if (!current || current.hidden) {
      const first = model.sheets().find((s) => !s.hidden) ?? model.sheets()[0];
      if (first) setSheetId(first.id);
    }
  }, [ready, model, sheetId, sheets]);

  const [panel, setPanel] = useState<Panel>(null);
  const [zoom, setZoom] = useState(100);
  const [title, setTitle] = useState(meta.title);
  const [sharing, setSharing] = useState(false);
  const [dialog, setDialog] = useState<null | 'keys' | 'numberFormat' | 'find' | 'sort' | 'settings' | 'nameVersion' | 'import' | 'print'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [selection, setSelection] = useState<Selection>({ rect: { r1: 0, c1: 0, r2: 0, c2: 0 }, active: { r: 0, c: 0 }, rowSel: false, colSel: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: 'cell' | 'row' | 'col' } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const grid = useRef<GridHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);

  // Undo availability for the toolbar.
  const [undoState, setUndoState] = useState({ undo: false, redo: false });
  useEffect(() => {
    const read = () => setUndoState({ undo: model.undo.undoStack.length > 0, redo: model.undo.redoStack.length > 0 });
    model.undo.on('stack-item-added', read);
    model.undo.on('stack-item-popped', read);
    model.undo.on('stack-cleared', read);
    return () => {
      model.undo.off('stack-item-added', read);
      model.undo.off('stack-item-popped', read);
      model.undo.off('stack-cleared', read);
    };
  }, [model]);

  const me = meta.me;
  const colour = colourFor(me.id);

  // ---- presence --------------------------------------------------------------
  useEffect(() => {
    provider.awareness.setLocalStateField('user', {
      name: me.displayName || 'Someone', color: colour, id: me.id,
      mode: canEdit ? 'editing' : canComment ? 'commenting' : 'viewing',
    });
  }, [provider, me.displayName, me.id, colour, canEdit, canComment]);

  useEffect(() => {
    if (!sheetId) return;
    const s = selection.rect;
    const a = model.idsAt(sheetId, selection.active.r, selection.active.c);
    const b1 = model.idsAt(sheetId, s.r1, s.c1);
    const b2 = model.idsAt(sheetId, s.r2, s.c2);
    if (!a || !b1 || !b2) return;
    provider.awareness.setLocalStateField('cursor', { sheet: sheetId, a, b1, b2 });
  }, [provider, model, sheetId, selection]);

  const [people, setPeople] = useState<{ key: number; name: string; color: string; mode: string; sheet?: string }[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  useEffect(() => {
    const read = () => {
      const list: typeof people = [];
      const rs: Remote[] = [];
      provider.awareness.getStates().forEach((st, key) => {
        if (key === provider.doc.clientID) return;
        const u = (st as { user?: { name?: string; color?: string; mode?: string } }).user;
        const cur = (st as { cursor?: { sheet: string; a: { row: string; col: string }; b1: { row: string; col: string }; b2: { row: string; col: string } } }).cursor;
        if (u?.name) list.push({ key, name: u.name, color: u.color ?? '#888', mode: u.mode ?? 'viewing', sheet: cur?.sheet });
        if (u?.name && cur && cur.sheet === sheetId) {
          const a = model.positionOf(cur.sheet, cur.a.row, cur.a.col);
          const p1 = model.positionOf(cur.sheet, cur.b1.row, cur.b1.col);
          const p2 = model.positionOf(cur.sheet, cur.b2.row, cur.b2.col);
          if (a && p1 && p2) rs.push({ name: u.name, color: u.color ?? '#888', active: a, rect: { r1: p1.r, c1: p1.c, r2: p2.r, c2: p2.c } });
        }
      });
      setPeople(list);
      setRemotes(rs);
    };
    read();
    provider.awareness.on('change', read);
    return () => provider.awareness.off('change', read);
  }, [provider, model, sheetId]);

  // ---- comments ----------------------------------------------------------------
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<{ quote: string; anchor: string } | null>(null);
  const loadComments = useCallback(() => {
    sheetsApi.comments(authedFetch, id).then(setThreads).catch(() => {});
  }, [authedFetch, id]);
  useEffect(() => { loadComments(); }, [loadComments]);

  const anchorOf = (t: CommentThread): CellAnchor | null => {
    try { return t.anchor ? JSON.parse(t.anchor) as CellAnchor : null; } catch { return null; }
  };
  const commentCells = useMemo(() => {
    const set = new Set<string>();
    for (const t of threads) {
      if (t.resolvedAt) continue;
      const a = anchorOf(t);
      if (!a || a.sheet !== sheetId) continue;
      const p = model.positionOf(a.sheet, a.row, a.col);
      if (p) set.add(`${p.r},${p.c}`);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, sheetId, model, sheets.length]);
  const orphaned = useMemo(() => {
    const set = new Set<string>();
    for (const t of threads) {
      const a = anchorOf(t);
      if (a && !model.positionOf(a.sheet, a.row, a.col)) set.add(t.id);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, model, sheets.length]);
  useEffect(() => grid.current?.repaint(), [commentCells]);

  function startComment() {
    if (!canComment || !sheetId) return;
    const { r, c } = selection.active;
    const ids = model.idsAt(sheetId, r, c);
    if (!ids) return;
    const name = model.meta(sheetId)?.name ?? '';
    const shown = displayText(model, sheetId, r, c);
    setCommentDraft({
      quote: `${name}!${cellLabel(r, c)}${shown ? ` — ${shown}` : ''}`.slice(0, 2000),
      anchor: JSON.stringify({ sheet: sheetId, row: ids.row, col: ids.col } satisfies CellAnchor),
    });
    setActiveThread(null);
    setPanel('comments');
  }

  function focusThread(tid: string) {
    setActiveThread(tid);
    const t = threads.find((x) => x.id === tid);
    const a = t ? anchorOf(t) : null;
    if (!a) return;
    const p = model.positionOf(a.sheet, a.row, a.col);
    if (!p) return;
    if (a.sheet !== sheetId) setSheetId(a.sheet);
    requestAnimationFrame(() => grid.current?.select({ r1: p.r, c1: p.c, r2: p.r, c2: p.c }));
  }

  // ---- versions ------------------------------------------------------------------
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [namedOnly, setNamedOnly] = useState(false);
  const [preview, setPreview] = useState<{ v: DocVersion; model: SheetsModel; doc: Y.Doc } | null>(null);
  const loadVersions = useCallback(() => {
    sheetsApi.versions(authedFetch, id).then(setVersions).catch(() => setVersions([]));
  }, [authedFetch, id]);
  useEffect(() => { if (panel === 'history') loadVersions(); }, [panel, loadVersions]);
  useEffect(() => () => { preview?.model.destroy(); preview?.doc.destroy(); }, [preview]);

  async function openVersion(v: DocVersion | null) {
    if (!v) { setPreview(null); return; }
    try {
      const full = await sheetsApi.version(authedFetch, id, v.id);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, fromBase64(full.state));
      const pm = new SheetsModel(doc);
      setPreview({ v, model: pm, doc });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load that version.');
    }
  }

  async function restore() {
    if (!preview || !canEdit) return;
    const when = preview.v.name ?? formatDateTime(preview.v.createdAt);
    if (!window.confirm(`Restore the version from ${when}? The current spreadsheet is kept in version history first, so this can be undone.`)) return;
    try {
      const snap = model.snapshot();
      await sheetsApi.saveVersion(authedFetch, id, {
        kind: 'restore', name: `Before restoring ${when}`,
        state: toBase64(Y.encodeStateAsUpdate(provider.doc)), html: workbookHtml(snap, model.locale()),
      });
      const old = preview.model.snapshot();
      setPreview(null);
      const first = model.load(old, 'replace');
      if (first) setSheetId(first);
      loadVersions();
      setNotice(`Restored the version from ${when}.`);
      void checkpoint();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not restore that version.');
    }
  }

  // ---- live events -----------------------------------------------------------------
  eventSink.current = (e: LiveEvent) => {
    switch (e.type) {
      case 'comments': loadComments(); break;
      case 'versions': if (panel === 'history') loadVersions(); break;
      case 'meta':
        if (typeof e.title === 'string') {
          const t = e.title;
          setTitle(t);
          setMeta((m) => (m ? { ...m, title: t } : m));
        }
        break;
      case 'readonly':
        setNotice('Your access to this spreadsheet changed. Your latest edit was not saved.');
        break;
    }
  };

  // ---- checkpoints -------------------------------------------------------------------
  const checkpointing = useRef(false);
  const checkpoint = useCallback(async () => {
    if (checkpointing.current || !provider.canEdit || provider.status !== 'synced') return false;
    if (model.sheetIds().length === 0) return false;
    checkpointing.current = true;
    try {
      const upToSeq = provider.lastSeq;
      const state = Y.encodeStateAsUpdate(provider.doc);
      const snap = model.snapshot();
      const xlsx = await writeXlsx(snap);
      const locale = model.locale();
      await sheetsApi.checkpointSheet(authedFetch, id, {
        state: toBase64(state), upToSeq,
        html: workbookHtml(snap, locale),
        text: workbookText(snap, locale).slice(0, 2_000_000),
        xlsx: toBase64(xlsx),
      });
      setSavedAt(new Date());
      return true;
    } catch {
      return false; // edits are already stored as updates; the next checkpoint retries
    } finally {
      checkpointing.current = false;
    }
  }, [provider, model, authedFetch, id]);

  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | null = null;
    let firstDirty = 0;
    const run = () => { idle = null; firstDirty = 0; void checkpoint(); };
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === provider) return; // a colleague's edit: their browser checkpoints it
      const now = Date.now();
      if (!firstDirty) firstDirty = now;
      if (idle) clearTimeout(idle);
      idle = setTimeout(run, now - firstDirty > CHECKPOINT_MAX_MS ? 0 : CHECKPOINT_IDLE_MS);
    };
    provider.doc.on('update', onUpdate);
    return () => {
      provider.doc.off('update', onUpdate);
      if (idle) { clearTimeout(idle); void checkpoint(); }
    };
  }, [provider, checkpoint]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (provider.pending) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const online = () => provider.reconnectNow();
    window.addEventListener('online', online);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('online', online); };
  }, [provider]);

  // ---- actions -------------------------------------------------------------------------
  const rect = selection.rect;
  const active = selection.active;
  const activeFormat: CellFormat = (sheetId && model.format(sheetId, active.r, active.c)) || {};
  const activeInput = sheetId ? model.input(sheetId, active.r, active.c) ?? '' : '';
  const editOk = canEdit && synced && !preview;

  function guard(): boolean {
    if (!editOk) { setNotice(canEdit ? 'Wait a moment — the spreadsheet is still connecting.' : 'You can view this spreadsheet but not change it.'); return false; }
    return true;
  }

  const fmt = (patch: Partial<CellFormat>) => { if (guard()) model.setFormat(sheetId, rect, patch); };

  function changeDecimals(delta: 1 | -1) {
    if (!guard()) return;
    const v = model.value(sheetId, active.r, active.c);
    let code = activeFormat.nf;
    if (!code || code === 'General') {
      const places = typeof v === 'number' && !Number.isInteger(v) ? Math.min(10, (String(v).split('.')[1] ?? '').length) : 0;
      code = places > 0 ? `0.${'0'.repeat(places)}` : '0';
    }
    // Add or remove one 0 after the decimal point of every section.
    const next = code.split(';').map((sec) => {
      const m = /(0|#)(\.([0#]*))?/.exec(sec);
      if (!m) return sec;
      const decs = m[3] ?? '';
      const nd = delta > 0 ? `${decs}0` : decs.slice(0, -1);
      return sec.replace(m[0], `${m[1]}${nd ? `.${nd}` : ''}`);
    }).join(';');
    model.setFormat(sheetId, rect, { nf: next });
  }

  async function saveTitle() {
    const t = title.trim();
    if (!canEdit || !t || t === meta.title) { setTitle(meta.title); return; }
    try {
      const r = await sheetsApi.rename(authedFetch, id, t);
      setTitle(r.title);
      setMeta((m) => (m ? { ...m, title: r.title } : m));
    } catch (e) {
      setTitle(meta.title);
      setNotice(e instanceof Error ? e.message : 'Could not rename the spreadsheet.');
    }
  }

  async function toggleStar() {
    const res = await authedFetch(`/space/files/${id}/star`, { method: meta.isStarred ? 'DELETE' : 'PUT' });
    if (res.ok) setMeta((m) => (m ? { ...m, isStarred: !m.isStarred } : m));
  }

  async function moveToTrash() {
    if (!window.confirm(`Move “${meta.title}” to the trash? Anyone it is shared with loses access until it is restored.`)) return;
    const res = await authedFetch(`/space/files/${id}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/sheets';
    else setNotice('Could not move the spreadsheet to the trash.');
  }

  async function newSpreadsheet() {
    try {
      const d = await sheetsApi.create(authedFetch);
      window.open(sheetHref(d.id), '_blank', 'noopener');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create a spreadsheet.');
    }
  }

  function save(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const safeTitle = (meta.title || 'Spreadsheet').replace(/[\\/:*?"<>|]/g, '-');

  async function download(kind: 'xlsx' | 'csv' | 'tsv') {
    const snap = model.snapshot();
    if (kind === 'xlsx') {
      save(new Blob([await writeXlsx(snap) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeTitle}.xlsx`);
      return;
    }
    const s = snap.sheets.find((x) => x.name === model.meta(sheetId)?.name) ?? snap.sheets[0]!;
    const text = writeCsv(s, kind === 'csv' ? ',' : '\t');
    // A BOM so Excel on Windows reads the rupee sign and Indian names correctly.
    save(new Blob([`﻿${text}`], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8' }),
      `${safeTitle} - ${s.name}.${kind}`);
  }

  async function importFile(file: File, mode: 'replace' | 'append') {
    setDialog(null);
    setPendingImport(null);
    if (!guard()) return;
    if (file.size > MAX_IMPORT_BYTES) { setNotice('That file is larger than 20 MB, which is more than Sheets can import.'); return; }
    const name = file.name.toLowerCase();
    try {
      let data;
      if (name.endsWith('.xlsx')) {
        data = await readXlsx(new Uint8Array(await file.arrayBuffer()));
      } else if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
        const s = readCsv(await file.text(), name.endsWith('.tsv') ? '\t' : undefined);
        s.name = file.name.replace(/\.[^.]+$/, '').slice(0, 90) || 'Imported';
        data = { sheets: [s] };
      } else if (name.endsWith('.xls') || name.endsWith('.ods')) {
        setNotice('Old Excel (.xls) and OpenDocument (.ods) files cannot be imported yet. Save the file as .xlsx or .csv and import that.');
        return;
      } else {
        setNotice('Choose an .xlsx, .csv or .tsv file.');
        return;
      }
      const first = model.load(data, mode);
      if (first) setSheetId(first);
      setNotice(`Imported ${data.sheets.length} sheet${data.sheets.length === 1 ? '' : 's'} from ${file.name}.`);
    } catch (e) {
      setNotice(`Could not read ${file.name}: ${e instanceof Error ? e.message : 'the file is damaged or not a spreadsheet.'}`);
    }
  }

  function jump(target: string): boolean {
    let t = target;
    let sid = sheetId;
    const bang = t.lastIndexOf('!');
    if (bang > 0) {
      const name = t.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
      const found = model.sheets().find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!found) { setNotice(`There is no sheet called "${name}".`); return false; }
      sid = found.id;
      t = t.slice(bang + 1);
    }
    const r = parseRect(t);
    if (!r) { setNotice(`"${target}" is not a cell or range. Try B5 or A1:C10.`); return false; }
    if (sid !== sheetId) setSheetId(sid);
    requestAnimationFrame(() => { grid.current?.select(r); grid.current?.focus(); });
    return true;
  }

  function insertRowsCols(axis: 'row' | 'col', where: 'before' | 'after') {
    if (!guard()) return;
    const n = axis === 'row' ? rect.r2 - rect.r1 + 1 : rect.c2 - rect.c1 + 1;
    const at = axis === 'row' ? (where === 'before' ? rect.r1 : rect.r2 + 1) : (where === 'before' ? rect.c1 : rect.c2 + 1);
    model.insert(sheetId, axis, at, n);
  }

  function deleteRowsCols(axis: 'row' | 'col') {
    if (!guard()) return;
    const at = axis === 'row' ? rect.r1 : rect.c1;
    const n = axis === 'row' ? rect.r2 - rect.r1 + 1 : rect.c2 - rect.c1 + 1;
    model.remove(sheetId, axis, at, n);
    grid.current?.select({ r1: rect.r1, c1: rect.c1, r2: rect.r1, c2: rect.c1 });
  }

  function sortBy(desc: boolean) {
    if (!guard()) return;
    const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
    let r: Rect = rect;
    if (single || selection.colSel) {
      // A single cell or whole column: sort the block of data around it, header kept if row 1 looks like one.
      const ext = model.extent(sheetId);
      r = { r1: 0, c1: 0, r2: Math.max(0, ext.lastRow), c2: Math.max(0, ext.lastCol) };
      if (looksLikeHeader(r)) r = { ...r, r1: 1 };
    }
    model.sortRange(sheetId, r, [{ col: active.c, desc }]);
  }

  function looksLikeHeader(r: Rect): boolean {
    // Row 1 is a header when it is all text and the row below has a number somewhere.
    let text = 0; let nums = 0;
    for (let c = r.c1; c <= r.c2; c += 1) {
      const v = model.value(sheetId, r.r1, c);
      if (typeof v === 'string' && v !== '') text += 1;
      if (typeof model.value(sheetId, r.r1 + 1, c) === 'number') nums += 1;
    }
    return text > 0 && nums > 0;
  }

  function insertFunction(name: string) {
    if (!guard()) return;
    // Sheets' toolbar shortcut: SUM etc. over the selection, or an empty call to fill in.
    const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2;
    if (multi && ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].includes(name)) {
      const below = { r: rect.r2 + 1, c: rect.c1 };
      model.setInputs(sheetId, [{ r: below.r, c: below.c, input: `=${name}(${rectName(rect)})` }]);
      grid.current?.select({ r1: below.r, c1: below.c, r2: below.r, c2: below.c });
      return;
    }
    grid.current?.edit(`=${name}(`);
  }

  // ---- AI context ------------------------------------------------------------------------
  const aiCtx: AiContext = {
    cell: cellLabel(active.r, active.c),
    formula: activeInput.startsWith('=') ? activeInput : null,
    describeSheet: () => {
      const name = model.meta(sheetId)?.name ?? '';
      const ext = model.extent(sheetId);
      const lastRow = Math.min(ext.lastRow, 24);
      const g = rangeForAi((r, c) => displayText(model, sheetId, r, c), 0, 0, Math.max(0, lastRow), Math.max(0, ext.lastCol), 20_000);
      return `Sheet: ${name}\nData occupies rows 1 to ${ext.lastRow + 1}, columns A to ${colName(Math.max(0, ext.lastCol))}.\n`
        + `Other sheets: ${model.sheets().filter((s) => s.id !== sheetId).map((s) => s.name).join(', ') || 'none'}\n`
        + `First rows (column letters on top, row numbers on the left):\n${g.text}`;
    },
    selection: () => {
      const r = rect;
      const ext = model.extent(sheetId);
      const r2 = Math.min(r.r2, Math.max(0, ext.lastRow));
      const c2 = Math.min(r.c2, Math.max(0, ext.lastCol));
      const g = rangeForAi((rr, cc) => displayText(model, sheetId, rr, cc), r.r1, r.c1, r2, c2);
      return { ...g, cells: (r2 - r.r1 + 1) * (c2 - r.c1 + 1) };
    },
  };

  // ---- menus ---------------------------------------------------------------------------
  const nRows = rect.r2 - rect.r1 + 1;
  const nCols = rect.c2 - rect.c1 + 1;
  const rowsLabel = nRows === 1 ? '1 row' : `${nRows} rows`;
  const colsLabel = nCols === 1 ? '1 column' : `${nCols} columns`;
  const frozen = model.meta(sheetId);
  const menus: { name: string; items: MenuItem[] }[] = ready ? [
    { name: 'File', items: [
      { label: 'New spreadsheet', onClick: () => void newSpreadsheet() },
      { label: 'Open Sheets home', onClick: () => { window.location.href = '/sheets'; } },
      { label: 'Import…', disabled: !editOk, onClick: () => fileInput.current?.click() },
      'sep',
      { label: 'Rename', disabled: !canEdit, onClick: () => document.getElementById('sheets-title')?.focus() },
      { label: 'Name current version', disabled: !canEdit, onClick: () => setDialog('nameVersion') },
      { label: 'Version history', onClick: () => setPanel('history') },
      'sep',
      { label: 'Download as Excel (.xlsx)', onClick: () => void download('xlsx') },
      { label: 'Download this sheet as .csv', onClick: () => void download('csv') },
      { label: 'Download this sheet as .tsv', onClick: () => void download('tsv') },
      { label: 'Download as PDF', shortcut: 'via Print', onClick: () => setDialog('print') },
      'sep',
      { label: 'Spreadsheet settings', disabled: !canEdit, onClick: () => setDialog('settings') },
      { label: 'Print', shortcut: 'Ctrl+P', onClick: () => setDialog('print') },
      'sep',
      { label: 'Move to trash', disabled: !canEdit, onClick: () => void moveToTrash() },
    ] },
    { name: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !editOk || !undoState.undo, onClick: () => model.undo.undo() },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !editOk || !undoState.redo, onClick: () => model.undo.redo() },
      'sep',
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !editOk, onClick: () => grid.current?.copy(true) },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => grid.current?.copy(false) },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !editOk, onClick: () => setNotice('Use Ctrl+V to paste — browsers only hand the clipboard to the keyboard shortcut.') },
      'sep',
      { label: 'Find and replace', shortcut: 'Ctrl+H', onClick: () => setDialog('find') },
      'sep',
      { label: 'Delete values', shortcut: 'Delete', disabled: !editOk, onClick: () => model.clear(sheetId, rect, 'values') },
      { label: `Delete ${rowsLabel} ${rect.r1 + 1}${nRows > 1 ? `–${rect.r2 + 1}` : ''}`, disabled: !editOk, onClick: () => deleteRowsCols('row') },
      { label: `Delete ${colsLabel} ${colName(rect.c1)}${nCols > 1 ? `–${colName(rect.c2)}` : ''}`, disabled: !editOk, onClick: () => deleteRowsCols('col') },
    ] },
    { name: 'View', items: [
      { label: 'Freeze: no rows', disabled: !editOk || !frozen?.frozenRows, onClick: () => model.freeze(sheetId, 0, null) },
      { label: 'Freeze: 1 row', disabled: !editOk, onClick: () => model.freeze(sheetId, 1, null) },
      { label: 'Freeze: 2 rows', disabled: !editOk, onClick: () => model.freeze(sheetId, 2, null) },
      { label: `Freeze: up to row ${active.r + 1}`, disabled: !editOk, onClick: () => model.freeze(sheetId, active.r + 1, null) },
      { label: 'Freeze: no columns', disabled: !editOk || !frozen?.frozenCols, onClick: () => model.freeze(sheetId, null, 0) },
      { label: 'Freeze: 1 column', disabled: !editOk, onClick: () => model.freeze(sheetId, null, 1) },
      { label: 'Freeze: 2 columns', disabled: !editOk, onClick: () => model.freeze(sheetId, null, 2) },
      { label: `Freeze: up to column ${colName(active.c)}`, disabled: !editOk, onClick: () => model.freeze(sheetId, null, active.c + 1) },
      'sep',
      { label: 'Comments', onClick: () => setPanel('comments') },
      { label: 'Version history', onClick: () => setPanel('history') },
      'sep',
      { label: 'Zoom 75%', onClick: () => setZoom(75) },
      { label: 'Zoom 100%', onClick: () => setZoom(100) },
      { label: 'Zoom 125%', onClick: () => setZoom(125) },
    ] },
    { name: 'Insert', items: [
      { label: `${nRows === 1 ? 'Row' : `${nRows} rows`} above`, disabled: !editOk, onClick: () => insertRowsCols('row', 'before') },
      { label: `${nRows === 1 ? 'Row' : `${nRows} rows`} below`, disabled: !editOk, onClick: () => insertRowsCols('row', 'after') },
      { label: `${nCols === 1 ? 'Column' : `${nCols} columns`} left`, disabled: !editOk, onClick: () => insertRowsCols('col', 'before') },
      { label: `${nCols === 1 ? 'Column' : `${nCols} columns`} right`, disabled: !editOk, onClick: () => insertRowsCols('col', 'after') },
      'sep',
      { label: 'Sheet', shortcut: 'Shift+F11', disabled: !editOk, onClick: () => { const s = model.addSheet(sheetId); setSheetId(s); } },
      'sep',
      { label: 'Function: SUM', disabled: !editOk, onClick: () => insertFunction('SUM') },
      { label: 'Today’s date', shortcut: 'Ctrl+;', disabled: !editOk, onClick: () => {
        const d = new Date();
        model.setInputs(sheetId, [{ r: active.r, c: active.c, input: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` }]);
      } },
      'sep',
      { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: !canComment, onClick: startComment },
    ] },
    { name: 'Format', items: [
      ...NUMBER_FORMATS.slice(0, 11).map((n): MenuItem => ({ label: `Number: ${n.label}`, disabled: !editOk, onClick: () => fmt({ nf: n.code }) })),
      { label: 'Number: custom format…', disabled: !editOk, onClick: () => setDialog('numberFormat') },
      'sep',
      { label: 'Bold', shortcut: 'Ctrl+B', disabled: !editOk, onClick: () => fmt({ b: activeFormat.b ? undefined : true }) },
      { label: 'Italic', shortcut: 'Ctrl+I', disabled: !editOk, onClick: () => fmt({ i: activeFormat.i ? undefined : true }) },
      { label: 'Underline', shortcut: 'Ctrl+U', disabled: !editOk, onClick: () => fmt({ u: activeFormat.u ? undefined : true }) },
      { label: 'Strikethrough', shortcut: 'Ctrl+5', disabled: !editOk, onClick: () => fmt({ s: activeFormat.s ? undefined : true }) },
      'sep',
      { label: 'Wrap text', disabled: !editOk, onClick: () => fmt({ wrap: 'wrap' }) },
      { label: 'Merge all', disabled: !editOk, onClick: () => { if (guard()) model.merge(sheetId, rect, 'all'); } },
      { label: 'Unmerge', disabled: !editOk, onClick: () => { if (guard()) model.unmergeIn(sheetId, rect); } },
      'sep',
      { label: 'Clear formatting', shortcut: 'Ctrl+\\', disabled: !editOk, onClick: () => model.clear(sheetId, rect, 'formats') },
    ] },
    { name: 'Data', items: [
      { label: `Sort A → Z by column ${colName(active.c)}`, disabled: !editOk, onClick: () => sortBy(false) },
      { label: `Sort Z → A by column ${colName(active.c)}`, disabled: !editOk, onClick: () => sortBy(true) },
      { label: 'Sort range…', disabled: !editOk, onClick: () => setDialog('sort') },
    ] },
    { name: 'Tools', items: [
      { label: 'TatvaOS AI', onClick: () => setPanel('ai') },
      { label: 'Spreadsheet settings', disabled: !canEdit, onClick: () => setDialog('settings') },
    ] },
    { name: 'Help', items: [
      { label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', onClick: () => setDialog('keys') },
    ] },
  ] : [];

  // Shortcuts the grid does not own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); startComment(); }
      else if (mod && !e.shiftKey && (e.key === 'h' || e.key === 'H' || e.key === 'f' || e.key === 'F') && !e.altKey) { e.preventDefault(); setDialog('find'); }
      else if (mod && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); setDialog('print'); }
      else if (mod && e.key === '/') { e.preventDefault(); setDialog('keys'); }
      else if (mod && e.key === '\\' && editOk) { e.preventDefault(); model.clear(sheetId, rect, 'formats'); }
      else if (e.shiftKey && e.key === 'F11' && editOk) { e.preventDefault(); setSheetId(model.addSheet(sheetId)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- status line -----------------------------------------------------------------------
  const status = lostAccess ? { text: 'You no longer have access', tone: 'text-danger', icon: <I.cloudOff className="h-4 w-4" /> }
    : provider.status === 'offline' ? { text: provider.pending ? 'Offline — your edits are kept in this tab' : 'Offline', tone: 'text-warn', icon: <I.cloudOff className="h-4 w-4" /> }
    : provider.status === 'connecting' ? { text: 'Connecting…', tone: 'text-ink-faint', icon: null }
    : provider.pending ? { text: 'Saving…', tone: 'text-ink-faint', icon: null }
    : !canEdit ? { text: perm === 'comment' ? 'Commenting' : 'View only', tone: 'text-ink-faint', icon: null }
    : { text: savedAt ? 'All changes saved' : 'Saved to TatvaOS Space', tone: 'text-ink-faint', icon: <I.cloudOk className="h-4 w-4" /> };

  const address = selection.rect.r1 === selection.rect.r2 && selection.rect.c1 === selection.rect.c2
    ? cellLabel(active.r, active.c)
    : rectName(selection.rect);

  // Selection summary, bottom right: Sum / Average / Count, as in Sheets.
  const summary = useMemo(() => {
    if (!sheetId || (rect.r1 === rect.r2 && rect.c1 === rect.c2)) return null;
    const ext = model.extent(sheetId);
    const r2 = Math.min(rect.r2, ext.lastRow); const c2 = Math.min(rect.c2, ext.lastCol);
    let sum = 0; let n = 0; let count = 0;
    for (let r = rect.r1; r <= r2; r += 1) for (let c = rect.c1; c <= c2; c += 1) {
      const v = model.value(sheetId, r, c);
      if (v !== null && v !== '') count += 1;
      if (typeof v === 'number') { sum += v; n += 1; }
    }
    if (count === 0) return null;
    const f = model.format(sheetId, active.r, active.c)?.nf;
    const show = (x: number) => formatValue(Number(x.toPrecision(12)), f && !/[dmyhs]/i.test(f) ? f : '#,##0.##', model.locale()).text;
    return n > 0 ? `Sum: ${show(sum)}   Average: ${show(sum / n)}   Count: ${count}` : `Count: ${count}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, sheetId, model, provider.lastSeq]);

  const panelOpen = panel !== null;
  const shownModel = preview ? preview.model : model;
  const shownSheet = preview ? (preview.model.meta(sheetId) ? sheetId : preview.model.sheetIds()[0] ?? '') : sheetId;

  return (
    <div className="docs-app sheets-app flex h-screen flex-col overflow-hidden">
      {/* ---- header -------------------------------------------------------- */}
      <header className="flex items-start gap-2 px-3 pt-2">
        <Link href="/sheets" title="Sheets home" aria-label="Sheets home" className="mt-1 shrink-0 rounded p-1 hover:bg-canvas">
          <SheetGlyph className="h-8 w-8" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <input id="sheets-title" value={title} readOnly={!canEdit} aria-label="Spreadsheet name"
              onChange={(ev) => setTitle(ev.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') { setTitle(meta.title); (ev.target as HTMLInputElement).blur(); } }}
              size={Math.max(8, Math.min(60, title.length + 1))}
              className="min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-lg text-ink outline-none hover:border-line focus:border-brand-600" />
            <button type="button" onClick={() => void toggleStar()}
              title={meta.isStarred ? 'Remove star' : 'Star'} aria-label={meta.isStarred ? 'Remove star' : 'Star'} aria-pressed={meta.isStarred}
              className={`rounded p-1 hover:bg-canvas ${meta.isStarred ? 'text-[#f5a623]' : 'text-ink-faint'}`}>
              <I.star className={`h-4 w-4 ${meta.isStarred ? 'fill-current' : ''}`} />
            </button>
            <span className={`ml-2 hidden items-center gap-1 text-xs sm:flex ${status.tone}`} role="status" aria-live="polite">
              {status.icon}{status.text}
            </span>
            {provider.status === 'offline' && (
              <button type="button" onClick={() => provider.reconnectNow()} className="ml-1 text-xs text-brand-600 hover:underline">Reconnect</button>
            )}
          </div>
          <MenuBar menus={menus} />
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1.5">
          <div className="hidden items-center -space-x-1.5 md:flex" aria-label="People in this spreadsheet">
            {people.slice(0, 5).map((p) => (
              <span key={p.key} title={`${p.name} is ${p.mode}${p.sheet && p.sheet !== sheetId && model.meta(p.sheet) ? ` on ${model.meta(p.sheet)!.name}` : ''}`}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white"
                style={{ background: p.color }}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {people.length > 5 && (
              <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-ink-faint text-xs text-white">+{people.length - 5}</span>
            )}
          </div>
          <HeaderButton title="Version history" active={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}><I.history /></HeaderButton>
          <HeaderButton title="Comments" active={panel === 'comments'} onClick={() => setPanel(panel === 'comments' ? null : 'comments')}><I.comment /></HeaderButton>
          <HeaderButton title="TatvaOS AI" active={panel === 'ai'} onClick={() => setPanel(panel === 'ai' ? null : 'ai')}><I.sparkle /></HeaderButton>
          {canShare ? (
            <button type="button" onClick={() => setSharing(true)}
              className="flex items-center gap-2 rounded-full bg-[#c2e7ff] px-5 py-2 text-sm font-medium text-[#001d35] hover:shadow">
              <I.share className="h-4 w-4" /> Share
            </button>
          ) : (
            <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-muted">
              {canEdit ? 'Editor' : perm === 'comment' ? 'Commenter' : 'Viewer'}
            </span>
          )}
        </div>
      </header>

      {/* ---- toolbar ------------------------------------------------------- */}
      <div className="px-3 py-1.5">
        <SheetsToolbar f={activeFormat} canEdit={editOk} canComment={canComment && !preview} zoom={zoom} onZoom={setZoom}
          canUndo={undoState.undo} canRedo={undoState.redo}
          a={{
            undo: () => model.undo.undo(),
            redo: () => model.undo.redo(),
            print: () => setDialog('print'),
            format: fmt,
            borders: (which, side) => { if (guard()) model.setBorders(sheetId, rect, which, side); },
            merge: (how) => { if (!guard()) return; if (how === 'none') model.unmergeIn(sheetId, rect); else model.merge(sheetId, rect, how); },
            decimals: changeDecimals,
            clearFormat: () => { if (guard()) model.clear(sheetId, rect, 'formats'); },
            insertFunction,
            comment: startComment,
            customFormat: () => setDialog('numberFormat'),
          }} />
      </div>
      <input ref={fileInput} type="file" hidden accept=".xlsx,.csv,.tsv,.txt,.xls,.ods"
        onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) { setPendingImport(f); setDialog('import'); } }} />

      {(notice || lostAccess) && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-[#fef7e0] px-3 py-1.5 text-sm text-[#3c2c00]">
          <span className="flex-1">{lostAccess ? 'You no longer have access to this spreadsheet. Anything you type now will not be saved.' : notice}</span>
          {!lostAccess && <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="p-0.5"><I.close className="h-4 w-4" /></button>}
        </div>
      )}
      {preview && (
        <div className="mx-3 mb-1 flex flex-wrap items-center gap-3 rounded-lg bg-[#e8f0fe] px-4 py-2 text-sm text-[#174ea6]">
          <span className="flex-1">Viewing {preview.v.name ? `“${preview.v.name}”` : 'the version'} from {formatDateTime(preview.v.createdAt)} (read only)</span>
          {canEdit && <button type="button" onClick={() => void restore()} className="rounded-full bg-brand-600 px-4 py-1 text-xs font-semibold text-white">Restore this version</button>}
          <button type="button" onClick={() => setPreview(null)} className="rounded-full border border-[#174ea6]/40 px-4 py-1 text-xs font-semibold">Back to current</button>
        </div>
      )}

      {/* ---- formula bar + grid + side panel -------------------------------- */}
      <FormulaBar address={address} value={draft ?? activeInput} editing={draft !== null} readOnly={!editOk}
        onJump={jump}
        onFocusEdit={() => { grid.current?.setDraft(activeInput); setDraft(activeInput); }}
        onChange={(t) => { grid.current?.setDraft(t); setDraft(t); }}
        onCommit={(mv) => { grid.current?.commit(mv); grid.current?.focus(); }}
        onCancel={() => { grid.current?.cancel(); }} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          {!ready || !shownSheet ? (
            <div className="flex flex-1 items-center justify-center"><Spinner /></div>
          ) : (
            <Grid ref={grid} key={preview ? `v-${preview.v.id}` : 'live'} model={shownModel} sheetId={shownSheet} zoom={zoom / 100}
              readOnly={!editOk} remotes={preview ? [] : remotes}
              onSelection={setSelection} onDraft={setDraft}
              onContextMenu={(x, y, target) => setMenu({ x, y, target })}
              onNotice={setNotice} onHover={setHover}
              hasComment={preview ? undefined : (r, c) => commentCells.has(`${r},${c}`)} />
          )}
        </div>
        {panelOpen && (
          <div className="w-[22rem] max-w-[90vw] shrink-0 border-l border-line bg-surface">
            {panel === 'comments' && (
              <CommentsPanel threads={threads} meId={me.id} canComment={canComment} canEdit={canEdit}
                activeId={activeThread} onActivate={focusThread} orphaned={orphaned}
                draft={commentDraft}
                onDraftCancel={() => setCommentDraft(null)}
                onDraftSubmit={async (body) => {
                  if (!commentDraft) return;
                  await sheetsApi.comment(authedFetch, id, body, commentDraft.anchor, commentDraft.quote);
                  setCommentDraft(null);
                  loadComments();
                }}
                onReply={async (tid, body) => { await sheetsApi.reply(authedFetch, id, tid, body); loadComments(); }}
                onResolve={async (tid, r) => { await sheetsApi.resolve(authedFetch, id, tid, r); loadComments(); }}
                onDelete={async (cid) => { await sheetsApi.deleteComment(authedFetch, id, cid); loadComments(); }}
                onEdit={async (cid, body) => { await sheetsApi.editComment(authedFetch, id, cid, body); loadComments(); }}
                onClose={() => { setPanel(null); setCommentDraft(null); }} />
            )}
            {panel === 'history' && (
              <HistoryPanel versions={versions} selectedId={preview?.v.id ?? null} canEdit={canEdit}
                namedOnly={namedOnly} onNamedOnly={setNamedOnly}
                onSelect={(v) => void openVersion(v)}
                onName={async (v, name) => { await sheetsApi.nameVersion(authedFetch, id, v.id, name); loadVersions(); }}
                onNameCurrent={() => setDialog('nameVersion')}
                onClose={() => { setPanel(null); setPreview(null); }} />
            )}
            {panel === 'ai' && (
              <SheetsAiPanel fileId={id} available={meta.ai.available} reason={meta.ai.reason} canEdit={editOk}
                ctx={aiCtx}
                onInsert={(formula) => {
                  if (!guard()) return;
                  model.setInputs(sheetId, [{ r: active.r, c: active.c, input: formula }]);
                  grid.current?.focus();
                }}
                onClose={() => setPanel(null)} />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          {ready && (
            <SheetTabs sheets={preview ? preview.model.sheets() : sheets} active={shownSheet} canEdit={editOk}
              onSelect={(s) => { setSheetId(s); requestAnimationFrame(() => grid.current?.focus()); }}
              a={{
                add: () => setSheetId(model.addSheet(sheetId)),
                rename: (sid, name) => model.renameSheet(sid, name),
                remove: (sid) => {
                  const name = model.meta(sid)?.name ?? 'this sheet';
                  if (!window.confirm(`Delete "${name}"? Formulas on other sheets that use it will show #REF!. You can undo this.`)) return;
                  const err = model.deleteSheet(sid);
                  if (err) setNotice(err);
                },
                duplicate: (sid) => setSheetId(model.duplicateSheet(sid)),
                move: (sid, d) => model.moveSheet(sid, d),
                color: (sid, c) => model.setSheetProp(sid, 'tabColor', c),
                hide: (sid, h) => {
                  if (h && model.sheets().filter((s) => !s.hidden).length <= 1) { setNotice('A spreadsheet must keep at least one visible sheet.'); return; }
                  model.setSheetProp(sid, 'hidden', h);
                },
              }} />
          )}
        </div>
        {summary && <span className="hidden shrink-0 border-t border-line bg-canvas px-4 py-2.5 text-xs text-ink-muted md:block">{summary}</span>}
      </div>

      {hover && (
        <div role="tooltip" className="pointer-events-none fixed z-50 max-w-xs rounded-md bg-[#3c4043] px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => { setMenu(null); grid.current?.focus(); }} items={[
          { label: 'Cut', shortcut: 'Ctrl+X', disabled: !editOk, onClick: () => grid.current?.copy(true) },
          { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => grid.current?.copy(false) },
          'sep',
          ...(menu.target !== 'col' ? [
            { label: `Insert ${rowsLabel} above`, disabled: !editOk, onClick: () => insertRowsCols('row', 'before') },
            { label: `Insert ${rowsLabel} below`, disabled: !editOk, onClick: () => insertRowsCols('row', 'after') },
          ] as MenuItem[] : []),
          ...(menu.target !== 'row' ? [
            { label: `Insert ${colsLabel} left`, disabled: !editOk, onClick: () => insertRowsCols('col', 'before') },
            { label: `Insert ${colsLabel} right`, disabled: !editOk, onClick: () => insertRowsCols('col', 'after') },
          ] as MenuItem[] : []),
          'sep',
          ...(menu.target !== 'col' ? [{ label: `Delete ${rowsLabel}`, disabled: !editOk, onClick: () => deleteRowsCols('row') }] as MenuItem[] : []),
          ...(menu.target !== 'row' ? [{ label: `Delete ${colsLabel}`, disabled: !editOk, onClick: () => deleteRowsCols('col') }] as MenuItem[] : []),
          { label: 'Clear contents', disabled: !editOk, onClick: () => model.clear(sheetId, rect, 'values') },
          'sep',
          ...(menu.target === 'col' ? [
            { label: 'Sort sheet A → Z', disabled: !editOk, onClick: () => sortBy(false) },
            { label: 'Sort sheet Z → A', disabled: !editOk, onClick: () => sortBy(true) },
            { label: 'Resize to fit data', disabled: !editOk, onClick: () => model.setColWidth(sheetId, range(rect.c1, rect.c2), null) },
            'sep',
          ] as MenuItem[] : []),
          { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: !canComment, onClick: startComment },
        ]} />
      )}

      {/* ---- dialogs --------------------------------------------------------- */}
      {sharing && (
        <ShareDialog kind="files" item={{ id, name: meta.title, ownershipType: meta.ownershipType }}
          publicLinks={false}
          onClose={() => setSharing(false)}
          onChanged={() => setMeta((m) => (m ? { ...m, isShared: true } : m))} />
      )}
      {dialog === 'keys' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'numberFormat' && (
        <NumberFormatDialog initial={activeFormat.nf ?? ''} sample={model.value(sheetId, active.r, active.c)} locale={model.locale()}
          onClose={() => setDialog(null)} onApply={(code) => { fmt({ nf: code || undefined }); setDialog(null); }} />
      )}
      {dialog === 'find' && (
        <FindDialog model={model} sheetId={sheetId} canEdit={editOk}
          onGo={(sid, r, c) => { if (sid !== sheetId) setSheetId(sid); requestAnimationFrame(() => grid.current?.select({ r1: r, c1: c, r2: r, c2: c })); }}
          onNotice={setNotice} onClose={() => { setDialog(null); grid.current?.focus(); }} />
      )}
      {dialog === 'sort' && (
        <SortDialog rect={rect} onClose={() => setDialog(null)}
          headerGuess={looksLikeHeader(rect)}
          onSort={(hasHeader, keys) => {
            setDialog(null);
            if (!guard()) return;
            model.sortRange(sheetId, hasHeader ? { ...rect, r1: rect.r1 + 1 } : rect, keys);
          }} />
      )}
      {dialog === 'settings' && (
        <SettingsDialog grouping={model.locale().grouping} dateOrder={model.locale().dateOrder}
          onClose={() => setDialog(null)}
          onSave={(g, d) => { model.setLocale(g, d); setDialog(null); }} />
      )}
      {dialog === 'print' && (
        <PrintDialog hasSelection={rect.r1 !== rect.r2 || rect.c1 !== rect.c2} onClose={() => setDialog(null)}
          onPrint={(o) => {
            setDialog(null);
            printSheet(model, sheetId, meta.title, { ...o, range: o.selectionOnly ? rect : undefined });
          }} />
      )}
      {dialog === 'import' && pendingImport && (
        <Modal title="Import a file" onClose={() => { setDialog(null); setPendingImport(null); }} size="sm">
          <p className="mb-4 text-sm text-ink">{pendingImport.name}</p>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={() => void importFile(pendingImport, 'append')}
              className="rounded-lg border border-line px-4 py-2 text-left text-sm hover:bg-canvas">
              <span className="block font-medium text-ink">Insert as new sheets</span>
              <span className="text-xs text-ink-muted">Your existing sheets stay as they are.</span>
            </button>
            <button type="button" onClick={() => {
              if (window.confirm('Replace every sheet in this spreadsheet with the file? The current version is kept in version history.')) void importFile(pendingImport, 'replace');
            }} className="rounded-lg border border-line px-4 py-2 text-left text-sm hover:bg-canvas">
              <span className="block font-medium text-ink">Replace spreadsheet</span>
              <span className="text-xs text-ink-muted">Everything here is replaced by the file.</span>
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'nameVersion' && (
        <NameVersionDialog onClose={() => setDialog(null)} onSave={async (name) => {
          setDialog(null);
          await sheetsApi.saveVersion(authedFetch, id, {
            kind: 'named', name, state: toBase64(Y.encodeStateAsUpdate(provider.doc)), html: workbookHtml(model.snapshot(), model.locale()),
          });
          loadVersions();
          setNotice(`Saved as “${name}”.`);
        }} />
      )}
    </div>
  );
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

function HeaderButton({ title, active, onClick, children }: { title: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-full ${active ? 'bg-[#d3e3fd] text-[#0b57d0]' : 'text-ink hover:bg-canvas'}`}>
      {children}
    </button>
  );
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const b = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - b.width - 8), y: Math.min(y, window.innerHeight - b.height - 8) });
    }
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [x, y, onClose]);
  return (
    <div ref={ref} role="menu" className="fixed z-50 min-w-[15rem] rounded-lg border border-line bg-surface py-1 shadow-raised" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => it === 'sep' ? (
        <div key={`s${i}`} className="my-1 h-px bg-line" role="separator" />
      ) : (
        <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onClose(); it.onClick(); }}
          className="flex w-full items-center justify-between gap-6 px-4 py-1.5 text-left text-sm text-ink hover:bg-canvas disabled:text-ink-faint disabled:hover:bg-transparent">
          <span>{it.label}</span>
          {it.shortcut && <span className="text-xs text-ink-faint">{it.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Dialogs
// ---------------------------------------------------------------------------

function NumberFormatDialog({ initial, sample, locale, onClose, onApply }: {
  initial: string; sample: unknown; locale: ReturnType<SheetsModel['locale']>; onClose: () => void; onApply: (code: string) => void;
}) {
  const [code, setCode] = useState(initial);
  const v = typeof sample === 'number' ? sample : 125000.5;
  const preview = formatValue(v, code || undefined, locale).text;
  return (
    <Modal title="Custom number format" onClose={onClose} size="sm">
      <label htmlFor="nf-code" className="mb-1 block text-xs text-ink-muted">Format code (Excel style)</label>
      <input id="nf-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onApply(code.trim()); }}
        placeholder='e.g. ₹#,##0.00 or dd mmm yyyy or 0.0%'
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none focus:border-brand-600" />
      <p className="mt-3 text-xs text-ink-muted">Preview</p>
      <p className="mt-1 rounded bg-canvas px-3 py-2 font-mono text-sm text-ink">{preview || '(empty)'}</p>
      <p className="mt-3 text-xs text-ink-faint">
        0 digit · # optional digit · , grouping (Indian or western, from Spreadsheet settings) · % percent ·
        dd mm yyyy date · h:mm AM/PM time · &quot;text&quot; literal · positive;negative;zero
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
        <button type="button" onClick={() => onApply(code.trim())} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white">Apply</button>
      </div>
    </Modal>
  );
}

function FindDialog({ model, sheetId, canEdit, onGo, onNotice, onClose }: {
  model: SheetsModel; sheetId: string; canEdit: boolean;
  onGo: (sheet: string, r: number, c: number) => void; onNotice: (m: string) => void; onClose: () => void;
}) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [scope, setScope] = useState<'sheet' | 'all'>('sheet');
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [regex, setRegex] = useState(false);
  const [inFormulas, setInFormulas] = useState(false);
  const [pos, setPos] = useState(-1);
  const [msg, setMsg] = useState<string | null>(null);

  const pattern = useMemo(() => {
    if (!find) return null;
    try {
      const src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(whole ? `^(?:${src})$` : src, matchCase ? 'g' : 'gi');
    } catch { return null; }
  }, [find, regex, whole, matchCase]);

  /** Every matching cell, in reading order, across the chosen scope. */
  function matches(): { sheet: string; r: number; c: number; input: string }[] {
    if (!pattern) return [];
    const out: { sheet: string; r: number; c: number; input: string }[] = [];
    const ids = scope === 'all' ? model.sheetIds() : [sheetId];
    for (const sid of ids) {
      const cells = [...model.filled(sid)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (const [r, c, input] of cells) {
        const isF = input.startsWith('=');
        const hay = isF && !inFormulas ? displayText(model, sid, r, c) : input;
        pattern.lastIndex = 0;
        if (pattern.test(hay)) out.push({ sheet: sid, r, c, input });
      }
    }
    return out;
  }

  function next() {
    const m = matches();
    if (m.length === 0) { setMsg('No matches.'); return; }
    const i = (pos + 1) % m.length;
    setPos(i);
    setMsg(`${i + 1} of ${m.length}`);
    onGo(m[i]!.sheet, m[i]!.r, m[i]!.c);
  }

  function replaceAll() {
    if (!canEdit || !pattern) return;
    const m = matches().filter((x) => !x.input.startsWith('=') || inFormulas);
    const bySheet = new Map<string, { r: number; c: number; input: string | null }[]>();
    for (const x of m) {
      pattern.lastIndex = 0;
      const nextInput = x.input.replace(pattern, replace);
      if (!bySheet.has(x.sheet)) bySheet.set(x.sheet, []);
      bySheet.get(x.sheet)!.push({ r: x.r, c: x.c, input: nextInput });
    }
    for (const [sid, entries] of bySheet) model.setInputs(sid, entries);
    const n = m.length;
    setMsg(n === 0 ? 'Nothing to replace.' : `Replaced ${n} cell${n === 1 ? '' : 's'}.`);
    if (n > 0) onNotice(`Replaced ${n} cell${n === 1 ? '' : 's'}. Ctrl+Z undoes it.`);
  }

  return (
    <Modal title="Find and replace" onClose={onClose} size="sm">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Find</span>
          <input autoFocus value={find} onChange={(e) => { setFind(e.target.value); setPos(-1); setMsg(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') next(); }}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink outline-none focus:border-brand-600" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Replace with</span>
          <input value={replace} onChange={(e) => setReplace(e.target.value)} disabled={!canEdit}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-ink outline-none focus:border-brand-600" />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">Search</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'sheet' | 'all')} className="rounded border border-line bg-surface px-2 py-1 text-ink">
            <option value="sheet">This sheet</option>
            <option value="all">All sheets</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-1">
          <Check label="Match case" v={matchCase} set={setMatchCase} />
          <Check label="Match entire cell" v={whole} set={setWhole} />
          <Check label="Regular expression" v={regex} set={setRegex} />
          <Check label="Also search in formulas" v={inFormulas} set={setInFormulas} />
        </div>
        {regex && find && !pattern && <p className="text-xs text-danger">That is not a valid regular expression.</p>}
        {msg && <p role="status" className="text-xs text-ink-muted">{msg}</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={next} disabled={!pattern} className="rounded-full border border-line px-4 py-2 text-sm text-ink disabled:opacity-50">Find next</button>
        <button type="button" onClick={replaceAll} disabled={!pattern || !canEdit} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Replace all</button>
      </div>
    </Modal>
  );
}

function Check({ label, v, set }: { label: string; v: boolean; set: (b: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink">
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
}

function SortDialog({ rect, headerGuess, onSort, onClose }: {
  rect: Rect; headerGuess: boolean; onSort: (hasHeader: boolean, keys: { col: number; desc: boolean }[]) => void; onClose: () => void;
}) {
  const [hasHeader, setHasHeader] = useState(headerGuess);
  const [keys, setKeys] = useState<{ col: number; desc: boolean }[]>([{ col: rect.c1, desc: false }]);
  const cols = range(rect.c1, rect.c2);
  return (
    <Modal title={`Sort range ${rectName(rect)}`} onClose={onClose} size="sm">
      <label className="mb-3 flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> Data has a header row
      </label>
      {keys.map((k, i) => (
        <div key={i} className="mb-2 flex items-center gap-2 text-sm">
          <span className="w-16 text-ink-muted">{i === 0 ? 'Sort by' : 'then by'}</span>
          <select value={k.col} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, col: Number(e.target.value) } : x)))}
            className="rounded border border-line bg-surface px-2 py-1 text-ink">
            {cols.map((c) => <option key={c} value={c}>Column {colName(c)}</option>)}
          </select>
          <select value={k.desc ? 'desc' : 'asc'} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === 'desc' } : x)))}
            className="rounded border border-line bg-surface px-2 py-1 text-ink">
            <option value="asc">A → Z</option>
            <option value="desc">Z → A</option>
          </select>
          {i > 0 && <button type="button" aria-label="Remove" onClick={() => setKeys(keys.filter((_, j) => j !== i))} className="p-1 text-ink-faint"><I.close className="h-4 w-4" /></button>}
        </div>
      ))}
      {keys.length < cols.length && (
        <button type="button" onClick={() => setKeys([...keys, { col: cols.find((c) => !keys.some((k) => k.col === c)) ?? rect.c1, desc: false }])}
          className="text-sm text-brand-600 hover:underline">Add another sort column</button>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
        <button type="button" onClick={() => onSort(hasHeader, keys)} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white">Sort</button>
      </div>
    </Modal>
  );
}

function SettingsDialog({ grouping, dateOrder, onSave, onClose }: {
  grouping: 'indian' | 'western'; dateOrder: 'dmy' | 'mdy';
  onSave: (g: 'indian' | 'western', d: 'dmy' | 'mdy') => void; onClose: () => void;
}) {
  const [g, setG] = useState(grouping);
  const [d, setD] = useState(dateOrder);
  return (
    <Modal title="Spreadsheet settings" onClose={onClose} size="sm">
      <p className="mb-3 text-xs text-ink-muted">These apply to everyone who opens this spreadsheet.</p>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium text-ink">Number grouping</legend>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" checked={g === 'indian'} onChange={() => setG('indian')} /> Indian — 1,25,000</label>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" checked={g === 'western'} onChange={() => setG('western')} /> International — 125,000</label>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink">Reading typed dates</legend>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" checked={d === 'dmy'} onChange={() => setD('dmy')} /> Day first — 24/09/2026</label>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="radio" checked={d === 'mdy'} onChange={() => setD('mdy')} /> Month first — 09/24/2026</label>
      </fieldset>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
        <button type="button" onClick={() => onSave(g, d)} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white">Save</button>
      </div>
    </Modal>
  );
}

function PrintDialog({ hasSelection, onPrint, onClose }: {
  hasSelection: boolean;
  onPrint: (o: { orientation: 'portrait' | 'landscape'; paper: 'A4' | 'A3' | 'Letter' | 'Legal'; gridlines: boolean; headings: boolean; selectionOnly: boolean }) => void;
  onClose: () => void;
}) {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [paper, setPaper] = useState<'A4' | 'A3' | 'Letter' | 'Legal'>('A4');
  const [gridlines, setGridlines] = useState(true);
  const [headings, setHeadings] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  return (
    <Modal title="Print" onClose={onClose} size="sm">
      <div className="space-y-3 text-sm text-ink">
        <label className="flex items-center gap-2">Paper
          <select value={paper} onChange={(e) => setPaper(e.target.value as typeof paper)} className="rounded border border-line bg-surface px-2 py-1">
            <option>A4</option><option>A3</option><option>Letter</option><option>Legal</option>
          </select>
        </label>
        <label className="flex items-center gap-2">Orientation
          <select value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)} className="rounded border border-line bg-surface px-2 py-1">
            <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
          </select>
        </label>
        <Check label="Show gridlines" v={gridlines} set={setGridlines} />
        <Check label="Show row and column headings" v={headings} set={setHeadings} />
        {hasSelection && <Check label="Selected cells only" v={selectionOnly} set={setSelectionOnly} />}
        <p className="text-xs text-ink-faint">To save a PDF, choose “Save as PDF” as the printer.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
        <button type="button" onClick={() => onPrint({ orientation, paper, gridlines, headings, selectionOnly })}
          className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white">Print</button>
      </div>
    </Modal>
  );
}

function NameVersionDialog({ onSave, onClose }: { onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  return (
    <Modal title="Name current version" onClose={onClose} size="sm">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()); }}
        placeholder="e.g. Fees as on 30 September"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
        <button type="button" disabled={!name.trim()} onClick={() => onSave(name.trim())}
          className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save</button>
      </div>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Move', 'Arrow keys · Tab · Enter'], ['Extend selection', 'Shift + arrows'], ['Jump to edge of data', 'Ctrl + arrows'],
    ['Edit cell', 'F2 · Enter · double-click · just type'], ['New line in a cell', 'Alt + Enter'], ['Cancel editing', 'Esc'],
    ['Copy · Cut · Paste', 'Ctrl + C · X · V'], ['Undo · Redo', 'Ctrl + Z · Y'], ['Bold · Italic · Underline', 'Ctrl + B · I · U'],
    ['Strikethrough', 'Ctrl + 5'], ['Select all', 'Ctrl + A'], ['Delete values', 'Delete'], ["Today's date · time", 'Ctrl + ; · Ctrl + Shift + ;'],
    ['Fill selection with active cell', 'Ctrl + Enter'], ['Find and replace', 'Ctrl + H'], ['Comment', 'Ctrl + Alt + M'],
    ['New sheet', 'Shift + F11'], ['Print', 'Ctrl + P'], ['Clear formatting', 'Ctrl + \\'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
        {rows.map(([a, b]) => (
          <div key={a} className="contents"><dt className="text-ink">{a}</dt><dd className="text-right text-ink-muted">{b}</dd></div>
        ))}
      </dl>
    </Modal>
  );
}
