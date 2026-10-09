'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as Y from 'yjs';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import {
  absolutePositionToRelativePosition, relativePositionToAbsolutePosition,
  yXmlFragmentToProsemirrorJSON, ySyncPluginKey,
} from '@tiptap/y-tiptap';
import type { EditorState } from '@tiptap/pm/state';

import { useAuth } from '@/lib/auth';
import {
  docsApi, fromBase64, DocsError,
  type CommentThread, type DocumentMeta, type DocVersion,
} from '@/lib/docs';
import { DocsLiveProvider, type LiveEvent } from '@/lib/docsLive';
import { formatDateTime } from '@/lib/dates';
import { ShareDialog } from '@/components/space/ShareDialog';
import { AccountButton } from '@/components/shell/AccountButton';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Kit';

import { CommentHighlights, type CommentRange } from './extensions';
import { documentExtensions } from './schema';
import { MenuBar, Toolbar, applyStyle, type MenuItem } from './Toolbar';
import { CommentsPanel } from './CommentsPanel';
import { HistoryPanel } from './HistoryPanel';
import { AiPanel } from './AiPanel';
import { DocGlyph, I } from './icons';
import './docs.css';

// ============================================================================
//  The document editor.
//
//  DocEditor loads the document's metadata and owns the live connection;
//  Workspace is the editor itself, created only once a connection exists so
//  the editor is bound to the right Y.Doc from its first render.
//
//  Saving has two layers, both automatic:
//    · every edit goes over the live channel and is stored as it is acked
//      (that is what "All changes saved" means — see lib/docsLive.ts);
//    · a CHECKPOINT a few seconds after typing stops sends the whole state
//      plus its HTML, so Space's copy, search text and version history stay
//      current and the update log stays short.
// ============================================================================

const CHECKPOINT_IDLE_MS = 4_000;
const CHECKPOINT_MAX_MS = 20_000;

const A4 = { label: 'A4 (21 × 29.7 cm)', w: 210, h: 297 };
const PAPER: Record<string, { label: string; w: number; h: number }> = {
  A4,
  Letter: { label: 'Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
  Legal: { label: 'Legal (8.5 × 14 in)', w: 215.9, h: 355.6 },
  A3: { label: 'A3 (29.7 × 42 cm)', w: 297, h: 420 },
};
const NORMAL_MARGIN = { label: 'Normal (2.54 cm)', mm: 25.4 };
const MARGINS: Record<string, { label: string; mm: number }> = {
  normal: NORMAL_MARGIN,
  narrow: { label: 'Narrow (1.27 cm)', mm: 12.7 },
  wide: { label: 'Wide (5.08 cm)', mm: 50.8 },
};

interface PageSettings { size: string; orientation: 'portrait' | 'landscape'; margin: string; pageNumbers: boolean }
const DEFAULT_PAGE: PageSettings = { size: 'A4', orientation: 'portrait', margin: 'normal', pageNumbers: true };

const CARET_COLOURS = ['#e8710a', '#1e8e3e', '#d93025', '#9334e6', '#12b5cb', '#f538a0', '#188038', '#1a73e8'];
const colourFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CARET_COLOURS[h % CARET_COLOURS.length];
};

type Panel = 'comments' | 'history' | 'ai' | null;

/** Rebuild a stored Yjs state as editor JSON, without touching the live document. */
function stateToJson(stateB64: string): { json: JSONContent; settings: Record<string, unknown> } {
  const old = new Y.Doc();
  try {
    Y.applyUpdate(old, fromBase64(stateB64));
    return {
      json: yXmlFragmentToProsemirrorJSON(old.getXmlFragment('default')) as JSONContent,
      settings: old.getMap<unknown>('settings').toJSON(),
    };
  } finally {
    old.destroy();
  }
}

function VersionView({ json, loadImage }: { json: JSONContent; loadImage: (src: string) => Promise<string> }) {
  const view = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: documentExtensions(loadImage),
    content: json,
    editorProps: { attributes: { class: 'docs-content', 'aria-label': 'Earlier version (read only)' } },
  }, [json]);
  return <EditorContent editor={view} />;
}

/**
 * An answer with no kind at all is from an API older than kinds, when every
 * file it could return was a document — so only a kind that is PRESENT and
 * is not "document" is refused.
 */
function notADocument(meta: DocumentMeta): boolean {
  return meta.kind !== undefined && meta.kind !== 'document';
}

export function DocEditor({ id }: { id: string }) {
  const { authedFetch } = useAuth();
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [provider, setProvider] = useState<DocsLiveProvider | null>(null);
  const eventSink = useRef<(e: LiveEvent) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    docsApi.get(authedFetch, id)
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch((e: unknown) => {
        if (!cancelled) setError({
          message: e instanceof Error ? e.message : 'Could not open this document.',
          status: e instanceof DocsError ? e.status : 0,
        });
      });
    return () => { cancelled = true; };
  }, [authedFetch, id]);

  // One live connection per page, created after the metadata says the
  // document exists and is not in the trash.
  useEffect(() => {
    if (!meta || meta.deletedAt || notADocument(meta)) return;
    const p = new DocsLiveProvider(id, () => docsApi.ticket(authedFetch, id), (e) => eventSink.current(e));
    setProvider(p);
    return () => { p.destroy(); setProvider(null); };
    // authedFetch is stable for the session; meta.id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.deletedAt, id]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
        <DocGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">
          {error.status === 404 ? 'This document does not exist, or you do not have access to it.' : error.message}
        </p>
        <Link href="/docs" className="text-sm text-brand-600 hover:underline">Go to Docs</Link>
      </div>
    );
  }
  if (!meta) return <div className="flex h-screen items-center justify-center bg-canvas"><Spinner /></div>;

  // A spreadsheet opened at a Docs address (/docs/d/<its id>). This editor
  // would read its content as an empty document, and the first keystroke
  // would write a document's structure into a spreadsheet's file. The
  // server cannot tell which editor a browser runs (it never reads the
  // content), so the refusal lives here, as Sheets' editor refuses
  // documents. No live connection is opened for it either (effect above).
  if (notADocument(meta)) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
        <DocGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">&ldquo;{meta.title}&rdquo; is a spreadsheet, not a document.</p>
        <Link href={`/sheets/s/${meta.id}`} className="text-sm text-brand-600 hover:underline">Open it in Sheets</Link>
      </div>
    );
  }

  if (meta.deletedAt) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
        <DocGlyph className="h-12 w-12 opacity-60" />
        <p className="text-base font-medium text-ink">&ldquo;{meta.title}&rdquo; is in the trash.</p>
        <p className="text-sm text-ink-muted">Restore it from the trash in Docs or Space to open it again.</p>
        <Link href="/docs/trash" className="text-sm text-brand-600 hover:underline">Open the trash</Link>
      </div>
    );
  }
  if (!provider) return <div className="flex h-screen items-center justify-center bg-canvas"><Spinner /></div>;

  return <Workspace key={provider.doc.guid} meta={meta} setMeta={setMeta} provider={provider} eventSink={eventSink} />;
}

// ---------------------------------------------------------------------------

function Workspace({ meta, setMeta, provider, eventSink }: {
  meta: DocumentMeta;
  setMeta: React.Dispatch<React.SetStateAction<DocumentMeta | null>>;
  provider: DocsLiveProvider;
  eventSink: React.MutableRefObject<(e: LiveEvent) => void>;
}) {
  const { authedFetch } = useAuth();
  const id = meta.id;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => provider.subscribe(rerender), [provider]);

  // The live level wins over the one loaded with the page: a share can
  // change while the document is open.
  const perm = provider.status === 'connecting' && provider.perm === 'view' ? meta.myPermission : provider.perm;
  const canEdit = perm === 'edit' || perm === 'owner';
  const canComment = canEdit || perm === 'comment';
  const canShare = meta.myPermission === 'owner' || (meta.ownershipType === 'organisational' && canEdit);
  const lostAccess = perm === 'none';

  const [panel, setPanel] = useState<Panel>(null);
  const [zoom, setZoom] = useState(100);
  const [title, setTitle] = useState(meta.title);
  const [sharing, setSharing] = useState(false);
  const [dialog, setDialog] = useState<'link' | 'page' | 'words' | 'keys' | 'nameVersion' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- comments state ----------------------------------------------------
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ quote: string; anchor: string } | null>(null);
  const threadsRef = useRef<CommentThread[]>([]);
  const activeRef = useRef<string | null>(null);
  threadsRef.current = threads;
  activeRef.current = activeThread;

  // ---- versions state ----------------------------------------------------
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [namedOnly, setNamedOnly] = useState(false);
  const [preview, setPreview] = useState<{
    v: DocVersion; json: JSONContent; settings: Record<string, unknown>;
  } | null>(null);

  // ---- page settings: shared by everyone, so they live in the Y.Doc ------
  const settingsMap = useMemo(() => provider.doc.getMap<unknown>('settings'), [provider]);
  const [page, setPage] = useState<PageSettings>(DEFAULT_PAGE);
  useEffect(() => {
    const read = () => setPage({ ...DEFAULT_PAGE, ...(settingsMap.toJSON() as Partial<PageSettings>) });
    read();
    settingsMap.observe(read);
    return () => settingsMap.unobserve(read);
  }, [settingsMap]);

  const loadImage = useCallback(async (src: string) => {
    // src is the API path ("/api/docs/…"); authedFetch takes it without "/api".
    const res = await authedFetch(src.replace(/^\/api/, ''));
    if (!res.ok) throw new Error('image');
    return URL.createObjectURL(await res.blob());
  }, [authedFetch]);

  // ---- comment anchoring ---------------------------------------------------
  const fragment = useMemo(() => provider.doc.getXmlFragment('default'), [provider]);
  const orphanedRef = useRef<Set<string>>(new Set());

  const rangesFor = useCallback((state: EditorState): CommentRange[] => {
    const binding = ySyncPluginKey.getState(state)?.binding;
    if (!binding) return [];
    const out: CommentRange[] = [];
    const orphaned = new Set<string>();
    for (const t of threadsRef.current) {
      if (t.resolvedAt || !t.anchor) continue;
      try {
        const a = JSON.parse(t.anchor) as { from: unknown; to: unknown };
        const from = relativePositionToAbsolutePosition(provider.doc, fragment,
          Y.createRelativePositionFromJSON(a.from), binding.mapping);
        const to = relativePositionToAbsolutePosition(provider.doc, fragment,
          Y.createRelativePositionFromJSON(a.to), binding.mapping);
        if (from === null || to === null || from >= to) { orphaned.add(t.id); continue; }
        out.push({ id: t.id, from, to, active: t.id === activeRef.current });
      } catch {
        orphaned.add(t.id);
      }
    }
    orphanedRef.current = orphaned;
    return out;
  }, [provider, fragment]);

  const me = meta.me;
  const colour = colourFor(me.id);

  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: [
      ...documentExtensions(loadImage),
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start typing, or use TatvaOS AI to write a first draft…' }),
      CommentHighlights.configure({
        ranges: rangesFor,
        onClick: (tid) => { setActiveThread(tid); setPanel('comments'); },
      }),
      Collaboration.configure({ document: provider.doc, field: 'default' }),
      CollaborationCaret.configure({ provider, user: { name: me.displayName || 'Someone', color: colour } }),
    ],
    editorProps: {
      attributes: { class: 'docs-content', spellcheck: 'true', 'aria-label': 'Document' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
    },
  }, [provider]);

  // Editable once the content has arrived at least once, at edit level —
  // and it STAYS editable through a dropped connection. Measured 24 Sept by
  // stopping the API mid-edit (what every deploy does): gating on "synced"
  // made the editor refuse keystrokes for the whole outage, so the typing was
  // silently lost behind a grey "Connecting…". The provider already keeps
  // offline edits and sends them on reconnect (lib/docsLive.ts), so there is
  // no reason to stop anyone typing.
  const hasSynced = useRef(false);
  if (provider.status === 'synced') hasSynced.current = true;
  const disconnected = hasSynced.current && (provider.status === 'offline' || provider.status === 'connecting');
  useEffect(() => {
    if (!editor) return;
    const want = canEdit && hasSynced.current && provider.status !== 'closed' && !preview;
    if (editor.isEditable !== want) editor.setEditable(want);
  }, [editor, canEdit, provider.status, preview]);

  // Say who we are and how we are here, for everyone else's avatars.
  useEffect(() => {
    provider.awareness.setLocalStateField('user', {
      name: me.displayName || 'Someone', color: colour, id: me.id,
      mode: canEdit ? 'editing' : canComment ? 'commenting' : 'viewing',
    });
  }, [provider, me.displayName, me.id, colour, canEdit, canComment]);

  // Other people here right now, for the avatar row.
  const [people, setPeople] = useState<{ key: number; name: string; color: string; mode: string }[]>([]);
  useEffect(() => {
    const read = () => {
      const list: { key: number; name: string; color: string; mode: string }[] = [];
      provider.awareness.getStates().forEach((st, key) => {
        if (key === provider.doc.clientID) return;
        const u = (st as { user?: { name?: string; color?: string; mode?: string } }).user;
        if (u?.name) list.push({ key, name: u.name, color: u.color ?? '#888', mode: u.mode ?? 'viewing' });
      });
      setPeople(list);
    };
    read();
    provider.awareness.on('change', read);
    return () => provider.awareness.off('change', read);
  }, [provider]);

  // ---- data loaders --------------------------------------------------------
  const loadComments = useCallback(() => {
    docsApi.comments(authedFetch, id).then(setThreads).catch(() => {});
  }, [authedFetch, id]);
  const loadVersions = useCallback(() => {
    docsApi.versions(authedFetch, id).then(setVersions).catch(() => setVersions([]));
  }, [authedFetch, id]);

  useEffect(() => { loadComments(); }, [loadComments]);
  useEffect(() => { if (panel === 'history') loadVersions(); }, [panel, loadVersions]);

  // Repaint highlights whenever the thread list or the active thread moves.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('docsCommentsChanged', true));
  }, [editor, threads, activeThread]);

  // ---- live events -----------------------------------------------------------
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
        setNotice('Your access to this document changed. Your latest edit was not saved.');
        break;
    }
  };

  // ---- checkpoints -----------------------------------------------------------
  const checkpointing = useRef(false);
  // Local edits not yet in a successful checkpoint. Set by typing, cleared by
  // a checkpoint that succeeded; a reconnect with this set checkpoints again,
  // or typing done during an outage would reach docs.updates but never
  // Space's copy, search or history until the next keystroke.
  const dirty = useRef(false);
  // The server could not build the document's file (render_failed): SAID, not
  // hidden behind "All changes saved" (Mr. Singh, 30 Sept 2026). The typing
  // itself is stored already; saving retries until it works.
  const [fileError, setFileError] = useState<string | null>(null);
  const checkpoint = useCallback(async () => {
    if (!editor || editor.isDestroyed || checkpointing.current) return false;
    if (!provider.canEdit || provider.status !== 'synced') return false;
    checkpointing.current = true;
    try {
      await docsApi.checkpoint(authedFetch, id, { upToSeq: provider.lastSeq });
      setSavedAt(new Date());
      setFileError(null);
      dirty.current = false;
      return true;
    } catch (e) {
      // Edits are already stored as updates; a later checkpoint retries.
      if (e instanceof DocsError && e.status === 503) setFileError(e.message);
      return false;
    } finally {
      checkpointing.current = false;
    }
  }, [editor, provider, authedFetch, id]);

  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | null = null;
    let firstDirty = 0;
    const run = () => {
      idle = null;
      firstDirty = 0;
      void checkpoint();
    };
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin === provider) return; // someone else's edit: their browser checkpoints it
      dirty.current = true;
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

  // The file could not be built: try again every 10 s until it can, even with
  // no new typing, so the warning clears by itself once the service is back.
  useEffect(() => {
    if (!fileError) return;
    const t = setInterval(() => { dirty.current = true; void checkpoint(); }, 10_000);
    return () => clearInterval(t);
  }, [fileError, checkpoint]);

  // Back from an outage with unsaved typing: checkpoint once the queued edits
  // have been acked, so Space's copy catches up without waiting for a keystroke.
  const wasDisconnected = useRef(false);
  useEffect(() => {
    if (disconnected) { wasDisconnected.current = true; return; }
    if (provider.status !== 'synced' || !wasDisconnected.current) return;
    wasDisconnected.current = false;
    if (!dirty.current) return;
    const t = setTimeout(() => void checkpoint(), 2000);
    return () => clearTimeout(t);
  }, [disconnected, provider.status, checkpoint]);

  // Leaving with edits that have not reached the server: ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (provider.pending) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const online = () => provider.reconnectNow();
    window.addEventListener('online', online);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('online', online); };
  }, [provider]);

  // ---- actions ---------------------------------------------------------------
  async function insertImages(files: File[]) {
    if (!editor || !provider.canEdit) return;
    for (const f of files) {
      try {
        const r = await docsApi.uploadImage(authedFetch, id, f);
        editor.chain().focus().setImage({ src: r.src, alt: f.name }).run();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not add the picture.');
      }
    }
  }

  async function saveTitle() {
    const t = title.trim();
    if (!canEdit || !t || t === meta.title) { setTitle(meta.title); return; }
    try {
      const r = await docsApi.rename(authedFetch, id, t);
      setTitle(r.title);
      setMeta((m) => (m ? { ...m, title: r.title } : m));
    } catch (e) {
      setTitle(meta.title);
      setNotice(e instanceof Error ? e.message : 'Could not rename the document.');
    }
  }

  function startComment() {
    if (!editor || !canComment) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) { setNotice('Select the text you want to comment on.'); return; }
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    if (!binding) return;
    const rel = (pos: number) => Y.relativePositionToJSON(
      absolutePositionToRelativePosition(pos, fragment, binding.mapping) as Y.RelativePosition);
    setDraft({
      quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 2000),
      anchor: JSON.stringify({ from: rel(from), to: rel(to) }),
    });
    setActiveThread(null);
    setPanel('comments');
  }

  function focusThread(tid: string) {
    setActiveThread(tid);
    if (!editor) return;
    const r = rangesFor(editor.state).find((x) => x.id === tid);
    if (r) {
      editor.commands.setTextSelection(r.from);
      editor.commands.scrollIntoView();
    }
  }

  async function toggleStar() {
    const res = await authedFetch(`/space/files/${id}/star`, { method: meta.isStarred ? 'DELETE' : 'PUT' });
    if (res.ok) setMeta((m) => (m ? { ...m, isStarred: !m.isStarred } : m));
  }

  function download(kind: 'html' | 'txt') {
    if (!editor) return;
    const safeTitle = (meta.title || 'Document').replace(/[\\/:*?"<>|]/g, '-');
    const body = kind === 'txt'
      ? editor.getText({ blockSeparator: '\n\n' })
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.title)}</title>`
        + '<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;line-height:1.5}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}img{max-width:100%}</style>'
        + `</head><body>${editor.getHTML()}</body></html>`;
    const blob = new Blob([body], { type: kind === 'txt' ? 'text/plain;charset=utf-8' : 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function print() {
    window.print();
  }

  async function nameCurrentVersion(name: string) {
    if (!editor) return;
    await docsApi.saveVersion(authedFetch, id, {
      kind: 'named', name,
    });
    loadVersions();
    setNotice(`Saved as “${name}”.`);
  }

  async function openVersion(v: DocVersion | null) {
    if (!v) { setPreview(null); return; }
    try {
      const full = await docsApi.version(authedFetch, id, v.id);
      setPreview({ v, ...stateToJson(full.state) });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load that version.');
    }
  }

  async function restore() {
    if (!editor || !preview || !canEdit) return;
    const when = preview.v.name ?? formatDateTime(preview.v.createdAt);
    if (!window.confirm(`Restore the version from ${when}? The current text is kept in version history first, so this can be undone.`)) return;
    try {
      // 1. Keep what is there now.
      await docsApi.saveVersion(authedFetch, id, {
        kind: 'restore', name: `Before restoring ${when}`,
      });
      // 2. Put the old content in as an ordinary edit, so it reaches
      //    everyone in the document like any other change.
      const { json, settings: oldSettings } = preview;
      setPreview(null);
      editor.setEditable(true);
      editor.commands.setContent(json);
      provider.doc.transact(() => {
        for (const [k, v] of Object.entries(oldSettings)) settingsMap.set(k, v);
      });
      loadVersions();
      setNotice(`Restored the version from ${when}.`);
      void checkpoint();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not restore that version.');
    }
  }

  async function moveToTrash() {
    if (!window.confirm(`Move “${meta.title}” to the trash? Anyone it is shared with loses access until it is restored.`)) return;
    const res = await authedFetch(`/space/files/${id}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/docs';
    else setNotice('Could not move the document to the trash.');
  }

  async function newDocument() {
    try {
      const d = await docsApi.create(authedFetch);
      window.open(`/docs/d/${d.id}`, '_blank', 'noopener');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not create a document.');
    }
  }

  // Keyboard shortcuts the editor does not own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); startComment(); }
      else if (mod && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K') && canEdit) { e.preventDefault(); setDialog('link'); }
      else if (mod && e.key === '\\' && canEdit && editor) { e.preventDefault(); editor.chain().focus().unsetAllMarks().run(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- page geometry + print rule -------------------------------------------
  const paper = PAPER[page.size] ?? A4;
  const landscape = page.orientation === 'landscape';
  const widthMm = landscape ? paper.h : paper.w;
  const heightMm = landscape ? paper.w : paper.h;
  const marginMm = (MARGINS[page.margin] ?? NORMAL_MARGIN).mm;

  const printCss = `@page { size: ${widthMm}mm ${heightMm}mm; margin: ${marginMm}mm;${
    page.pageNumbers ? ' @bottom-right { content: counter(page); font: 10pt Arial, sans-serif; color: #555; }' : ''} }`;

  // ---- status line -----------------------------------------------------------
  const status = lostAccess ? { text: provider.closedReason === 'too-many' ? 'Not connected' : 'You no longer have access', tone: 'text-danger', icon: <I.cloudOff className="h-4 w-4" /> }
    // Before "Saving…" and "All changes saved": the typing reached the
    // server, but the file others download was not built. Say so.
    : fileError ? { text: 'Not saved as a file yet — your typing is safe, retrying', tone: 'text-warn', icon: <I.cloudOff className="h-4 w-4" /> }
    : provider.status === 'offline' ? { text: provider.pending ? 'Offline — your edits are kept in this tab' : 'Offline', tone: 'text-warn', icon: <I.cloudOff className="h-4 w-4" /> }
    : provider.status === 'connecting' ? { text: 'Connecting…', tone: 'text-ink-faint', icon: null }
    : provider.pending ? { text: 'Saving…', tone: 'text-ink-faint', icon: null }
    : !canEdit ? { text: perm === 'comment' ? 'Commenting' : 'View only', tone: 'text-ink-faint', icon: null }
    : { text: savedAt ? 'All changes saved' : 'Saved to TatvaOS Space', tone: 'text-ink-faint', icon: <I.cloudOk className="h-4 w-4" /> };

  // ---- menus -----------------------------------------------------------------
  const e = editor;
  const inTable = !!e?.isActive('table');
  const menus: { name: string; items: MenuItem[] }[] = e ? [
    { name: 'File', items: [
      { label: 'New document', onClick: () => void newDocument() },
      { label: 'Open Docs home', onClick: () => { window.location.href = '/docs'; } },
      'sep',
      { label: 'Rename', disabled: !canEdit, onClick: () => document.getElementById('docs-title')?.focus() },
      { label: 'Name current version', disabled: !canEdit, onClick: () => setDialog('nameVersion') },
      { label: 'Version history', onClick: () => setPanel('history') },
      'sep',
      { label: 'Download as PDF', shortcut: 'via Print', onClick: print },
      { label: 'Download as web page (.html)', onClick: () => download('html') },
      { label: 'Download as plain text (.txt)', onClick: () => download('txt') },
      'sep',
      { label: 'Page setup', disabled: !canEdit, onClick: () => setDialog('page') },
      { label: 'Print', shortcut: 'Ctrl+P', onClick: print },
      'sep',
      { label: 'Move to trash', disabled: !canEdit, onClick: () => void moveToTrash() },
    ] },
    { name: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !canEdit, onClick: () => e.chain().focus().undo().run() },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !canEdit, onClick: () => e.chain().focus().redo().run() },
      'sep',
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => e.chain().focus().selectAll().run() },
    ] },
    { name: 'View', items: [
      { label: 'Comments', onClick: () => setPanel('comments') },
      { label: 'Version history', onClick: () => setPanel('history') },
      'sep',
      { label: 'Zoom 100%', onClick: () => setZoom(100) },
      { label: 'Zoom 125%', onClick: () => setZoom(125) },
      { label: 'Zoom 150%', onClick: () => setZoom(150) },
    ] },
    { name: 'Insert', items: [
      { label: 'Image', disabled: !canEdit, onClick: () => fileInput.current?.click() },
      { label: 'Table (3 × 3)', disabled: !canEdit, onClick: () => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { label: 'Link', shortcut: 'Ctrl+K', disabled: !canEdit, onClick: () => setDialog('link') },
      { label: 'Checklist', disabled: !canEdit, onClick: () => e.chain().focus().toggleTaskList().run() },
      { label: 'Horizontal line', disabled: !canEdit, onClick: () => e.chain().focus().setHorizontalRule().run() },
      { label: 'Page break', shortcut: 'Ctrl+Enter', disabled: !canEdit, onClick: () => e.chain().focus().setPageBreak().run() },
      { label: 'Today’s date', disabled: !canEdit, onClick: () => e.chain().focus().insertContent(
        new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })).run() },
      'sep',
      { label: 'Comment', shortcut: 'Ctrl+Alt+M', disabled: !canComment, onClick: startComment },
    ] },
    { name: 'Format', items: [
      { label: 'Bold', shortcut: 'Ctrl+B', disabled: !canEdit, onClick: () => e.chain().focus().toggleBold().run() },
      { label: 'Italic', shortcut: 'Ctrl+I', disabled: !canEdit, onClick: () => e.chain().focus().toggleItalic().run() },
      { label: 'Underline', shortcut: 'Ctrl+U', disabled: !canEdit, onClick: () => e.chain().focus().toggleUnderline().run() },
      { label: 'Strikethrough', disabled: !canEdit, onClick: () => e.chain().focus().toggleStrike().run() },
      { label: 'Superscript', shortcut: 'Ctrl+.', disabled: !canEdit, onClick: () => e.chain().focus().toggleSuperscript().run() },
      { label: 'Subscript', shortcut: 'Ctrl+,', disabled: !canEdit, onClick: () => e.chain().focus().toggleSubscript().run() },
      'sep',
      { label: 'Title', disabled: !canEdit, onClick: () => applyStyle(e, 'title') },
      { label: 'Subtitle', disabled: !canEdit, onClick: () => applyStyle(e, 'subtitle') },
      { label: 'Heading 1', shortcut: 'Ctrl+Alt+1', disabled: !canEdit, onClick: () => applyStyle(e, 'h1') },
      { label: 'Heading 2', shortcut: 'Ctrl+Alt+2', disabled: !canEdit, onClick: () => applyStyle(e, 'h2') },
      { label: 'Heading 3', shortcut: 'Ctrl+Alt+3', disabled: !canEdit, onClick: () => applyStyle(e, 'h3') },
      { label: 'Normal text', shortcut: 'Ctrl+Alt+0', disabled: !canEdit, onClick: () => applyStyle(e, 'normal') },
      'sep',
      { label: 'Quote', disabled: !canEdit, onClick: () => e.chain().focus().toggleBlockquote().run() },
      { label: 'Clear formatting', shortcut: 'Ctrl+\\', disabled: !canEdit, onClick: () => e.chain().focus().unsetAllMarks().setLineHeight(null).run() },
    ] },
    { name: 'Table', items: [
      { label: 'Insert table', disabled: !canEdit, onClick: () => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      'sep',
      { label: 'Insert row above', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().addRowBefore().run() },
      { label: 'Insert row below', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().addRowAfter().run() },
      { label: 'Insert column left', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().addColumnBefore().run() },
      { label: 'Insert column right', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().addColumnAfter().run() },
      'sep',
      { label: 'Delete row', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().deleteRow().run() },
      { label: 'Delete column', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().deleteColumn().run() },
      { label: 'Delete table', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().deleteTable().run() },
      'sep',
      { label: 'Merge cells', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().mergeCells().run() },
      { label: 'Split cell', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().splitCell().run() },
      { label: 'Header row on/off', disabled: !canEdit || !inTable, onClick: () => e.chain().focus().toggleHeaderRow().run() },
    ] },
    { name: 'Tools', items: [
      { label: 'Word count', onClick: () => setDialog('words') },
      { label: 'TatvaOS AI', onClick: () => setPanel('ai') },
    ] },
    { name: 'Help', items: [
      { label: 'Keyboard shortcuts', onClick: () => setDialog('keys') },
    ] },
  ] : [];

  const panelOpen = panel !== null;

  return (
    <div className="docs-app flex h-screen flex-col overflow-hidden">
      <style>{printCss}</style>

      {/* ---- header ------------------------------------------------------ */}
      <header className="flex items-start gap-2 px-3 pt-2">
        <Link href="/docs" title="Docs home" aria-label="Docs home" className="mt-1 shrink-0 rounded p-1 hover:bg-canvas">
          <DocGlyph className="h-8 w-8" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <input id="docs-title" value={title} readOnly={!canEdit} aria-label="Document name"
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
              <button type="button" onClick={() => provider.reconnectNow()}
                className="ml-1 text-xs text-brand-600 hover:underline">Reconnect</button>
            )}
          </div>
          <MenuBar menus={menus} />
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-1.5">
          <div className="hidden items-center -space-x-1.5 md:flex" aria-label="People in this document">
            {people.slice(0, 5).map((p) => (
              <span key={p.key} title={`${p.name} is ${p.mode}`}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white"
                style={{ background: p.color }}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {people.length > 5 && (
              <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-ink-faint text-xs text-white">
                +{people.length - 5}
              </span>
            )}
          </div>
          <HeaderButton title="Version history" active={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}><I.history /></HeaderButton>
          <HeaderButton title="Comments" active={panel === 'comments'} onClick={() => setPanel(panel === 'comments' ? null : 'comments')}><I.comment /></HeaderButton>
          <HeaderButton title="TatvaOS AI" active={panel === 'ai'} onClick={() => setPanel(panel === 'ai' ? null : 'ai')}><I.sparkle /></HeaderButton>
          {canShare ? (
            <button type="button" onClick={() => setSharing(true)}
              className="flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700">
              <I.share className="h-4 w-4" /> Share
            </button>
          ) : (
            <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-muted">
              {canEdit ? 'Editor' : perm === 'comment' ? 'Commenter' : 'Viewer'}
            </span>
          )}
          {/* Who is signed in. The circles further left are the people IN
              the document; this one is you, and opens the account menu. */}
          <AccountButton />
        </div>
      </header>

      {/* ---- toolbar ----------------------------------------------------- */}
      <div className="px-3 py-1.5">
        {editor && (
          <Toolbar editor={editor} canEdit={canEdit && !preview} canComment={canComment && !preview}
            zoom={zoom} onZoom={setZoom}
            onComment={startComment}
            onImage={() => fileInput.current?.click()}
            onLink={() => setDialog('link')}
            onPrint={print} />
        )}
      </div>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
        onChange={(ev) => { void insertImages(Array.from(ev.target.files ?? [])); ev.target.value = ''; }} />

      {disconnected && !lostAccess && (
        <div role="alert" className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-[#fef7e0] px-3 py-1.5 text-sm text-[#3c2c00]">
          <I.cloudOff className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            Reconnecting… You can keep typing. Your changes are kept in this tab and saved as soon as the
            connection returns — do not close this tab until it says saved.
          </span>
          <button type="button" onClick={() => provider.reconnectNow()} className="text-xs font-semibold underline">
            Try now
          </button>
        </div>
      )}
      {(notice || lostAccess) && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-[#fef7e0] px-3 py-1.5 text-sm text-[#3c2c00]">
          <span className="flex-1">{lostAccess
            ? provider.closedReason === 'too-many'
              ? 'You have too many documents open at once. Close some, then reload this one. Anything you type now will not be saved.'
              : 'You no longer have access to this document. Anything you type now will not be saved.'
            : notice}</span>
          {!lostAccess && <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="p-0.5"><I.close className="h-4 w-4" /></button>}
        </div>
      )}

      {/* ---- body -------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 border-t border-line">
        <main className="scroll-thin min-w-0 flex-1 overflow-auto py-6">
          {preview && (
            <div className="sticky top-0 z-20 mx-auto mb-4 flex max-w-3xl flex-wrap items-center gap-3 rounded-lg bg-brand-50 px-4 py-2 text-sm text-brand-700 dark:bg-brand-600/25 dark:text-white shadow">
              <span className="flex-1">
                Viewing {preview.v.name ? `“${preview.v.name}”` : 'the version'} from {formatDateTime(preview.v.createdAt)}
              </span>
              {canEdit && (
                <button type="button" onClick={() => void restore()}
                  className="rounded-full bg-brand-600 px-4 py-1 text-xs font-semibold text-white">Restore this version</button>
              )}
              <button type="button" onClick={() => setPreview(null)}
                className="rounded-full border border-brand-600/40 px-4 py-1 text-xs font-semibold">Back to current</button>
            </div>
          )}
          <div style={{ zoom: zoom / 100 }}>
            <div className={`docs-page ${preview ? '' : 'docs-print'}`}
              style={{ width: `${widthMm}mm`, minHeight: `${heightMm}mm`, padding: `${marginMm}mm` }}>
              {preview ? (
                <VersionView json={preview.json} loadImage={loadImage} />
              ) : (
                <>
                  {provider.status !== 'synced' && !editor?.getText() && (
                    <p className="text-sm text-ink-faint">Loading the document…</p>
                  )}
                  <EditorContent editor={editor} />
                </>
              )}
            </div>
          </div>
        </main>

        {panelOpen && (
          <div className="w-[22rem] max-w-[90vw] shrink-0 border-l border-line bg-surface">
            {panel === 'comments' && (
              <CommentsPanel
                threads={threads} meId={me.id} canComment={canComment} canEdit={canEdit}
                activeId={activeThread} onActivate={focusThread}
                orphaned={orphanedRef.current}
                draft={draft}
                onDraftCancel={() => setDraft(null)}
                onDraftSubmit={async (body) => {
                  if (!draft) return;
                  await docsApi.comment(authedFetch, id, body, draft.anchor, draft.quote);
                  setDraft(null);
                  loadComments();
                }}
                onReply={async (tid, body) => { await docsApi.reply(authedFetch, id, tid, body); loadComments(); }}
                onResolve={async (tid, r) => { await docsApi.resolve(authedFetch, id, tid, r); loadComments(); }}
                onDelete={async (cid) => { await docsApi.deleteComment(authedFetch, id, cid); loadComments(); }}
                onEdit={async (cid, body) => { await docsApi.editComment(authedFetch, id, cid, body); loadComments(); }}
                onClose={() => { setPanel(null); setDraft(null); }} />
            )}
            {panel === 'history' && (
              <HistoryPanel versions={versions} selectedId={preview?.v.id ?? null} canEdit={canEdit}
                namedOnly={namedOnly} onNamedOnly={setNamedOnly}
                onSelect={(v) => void openVersion(v)}
                onName={async (v, name) => { await docsApi.nameVersion(authedFetch, id, v.id, name); loadVersions(); }}
                onNameCurrent={() => setDialog('nameVersion')}
                onClose={() => { setPanel(null); setPreview(null); }} />
            )}
            {panel === 'ai' && editor && (
              <AiPanel fileId={id} available={meta.ai.available} reason={meta.ai.reason} canEdit={canEdit}
                getSelection={() => {
                  const { from, to } = editor.state.selection;
                  return editor.state.doc.textBetween(from, to, '\n');
                }}
                getDocument={() => editor.getText({ blockSeparator: '\n' })}
                onInsert={(html, mode) => {
                  const c = editor.chain().focus();
                  if (mode === 'replace') c.deleteSelection();
                  c.insertContent(html).run();
                }}
                onClose={() => setPanel(null)} />
            )}
          </div>
        )}
      </div>

      {/* ---- dialogs ----------------------------------------------------- */}
      {sharing && (
        <ShareDialog kind="files" item={{ id, name: meta.title, ownershipType: meta.ownershipType }}
          publicLinks={false}
          onClose={() => setSharing(false)}
          onChanged={() => setMeta((m) => (m ? { ...m, isShared: true } : m))} />
      )}
      {dialog === 'link' && editor && <LinkDialog editor={editor} onClose={() => setDialog(null)} />}
      {dialog === 'page' && (
        <PageSetupDialog value={page} onClose={() => setDialog(null)}
          onSave={(p) => {
            provider.doc.transact(() => { for (const [k, v] of Object.entries(p)) settingsMap.set(k, v); });
            setDialog(null);
          }} />
      )}
      {dialog === 'words' && editor && (
        <Modal title="Word count" onClose={() => setDialog(null)} size="sm">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-muted">Words</dt>
            <dd className="text-right font-medium text-ink">{editor.storage.characterCount.words().toLocaleString('en-IN')}</dd>
            <dt className="text-ink-muted">Characters</dt>
            <dd className="text-right font-medium text-ink">{editor.storage.characterCount.characters().toLocaleString('en-IN')}</dd>
          </dl>
        </Modal>
      )}
      {dialog === 'keys' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'nameVersion' && (
        <NameVersionDialog onClose={() => setDialog(null)}
          onSave={async (name) => { await nameCurrentVersion(name); setDialog(null); }} />
      )}
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function HeaderButton({ title, active, onClick, children }: {
  title: string; active?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-ink/[0.06] ${active ? 'bg-brand-100 text-brand-700 dark:bg-brand-600/35 dark:text-white' : 'text-ink'}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
//  Dialogs
// ---------------------------------------------------------------------------

function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing = (editor.getAttributes('link').href as string | undefined) ?? '';
  const { from, to, empty } = editor.state.selection;
  const [url, setUrl] = useState(existing);
  const [text, setText] = useState(empty ? '' : editor.state.doc.textBetween(from, to, ' '));
  const [err, setErr] = useState<string | null>(null);

  function save() {
    let href = url.trim();
    if (!href) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); return; }
    if (!/^(https?:|mailto:)/i.test(href)) {
      // Anything else — javascript:, data:, a relative path — is refused
      // or treated as a web address. A link is an address, never code.
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { setErr('Links must start with http://, https:// or mailto:.'); return; }
      href = `https://${href}`;
    }
    const c = editor.chain().focus();
    if (empty) {
      c.insertContent({ type: 'text', text: text.trim() || href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      c.extendMarkRange('link').setLink({ href }).run();
    }
    onClose();
  }

  return (
    <Modal title={existing ? 'Edit link' : 'Insert link'} onClose={onClose} size="sm"
      footer={(
        <div className="flex justify-between gap-2">
          {existing ? (
            <button type="button" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); }}
              className="text-sm text-danger hover:underline">Remove link</button>
          ) : <span />}
          <button type="button" onClick={save} className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white">Apply</button>
        </div>
      )}>
      <form onSubmit={(ev) => { ev.preventDefault(); save(); }} className="space-y-3">
        {empty && (
          <label className="block text-sm text-ink-muted">Text
            <input value={text} onChange={(ev) => setText(ev.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
          </label>
        )}
        <label className="block text-sm text-ink-muted">Link
          <input autoFocus value={url} onChange={(ev) => { setUrl(ev.target.value); setErr(null); }}
            placeholder="https://example.com"
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
        </label>
        {err && <p className="text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

function PageSetupDialog({ value, onClose, onSave }: {
  value: PageSettings; onClose: () => void; onSave: (p: PageSettings) => void;
}) {
  const [p, setP] = useState(value);
  const sel = 'mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink';
  return (
    <Modal title="Page setup" subtitle="Applies to everyone who opens this document, and to printing and PDF."
      onClose={onClose} size="sm"
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-1.5 text-sm text-brand-600">Cancel</button>
          <button type="button" onClick={() => onSave(p)} className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white">OK</button>
        </div>
      )}>
      <div className="space-y-3">
        <fieldset>
          <legend className="text-sm text-ink-muted">Orientation</legend>
          <div className="mt-1 flex gap-4 text-sm text-ink">
            {(['portrait', 'landscape'] as const).map((o) => (
              <label key={o} className="flex items-center gap-1.5">
                <input type="radio" name="orientation" checked={p.orientation === o} onChange={() => setP({ ...p, orientation: o })} />
                {o === 'portrait' ? 'Portrait' : 'Landscape'}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm text-ink-muted">Paper size
          <select value={p.size} onChange={(ev) => setP({ ...p, size: ev.target.value })} className={sel}>
            {Object.entries(PAPER).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="block text-sm text-ink-muted">Margins
          <select value={p.margin} onChange={(ev) => setP({ ...p, margin: ev.target.value })} className={sel}>
            {Object.entries(MARGINS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={p.pageNumbers} onChange={(ev) => setP({ ...p, pageNumbers: ev.target.checked })} />
          Page numbers when printing
        </label>
      </div>
    </Modal>
  );
}

function NameVersionDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try { await onSave(name.trim()); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save the version.'); setBusy(false); }
  }
  return (
    <Modal title="Name current version" onClose={onClose} size="sm" busy={busy}
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-full px-4 py-1.5 text-sm text-brand-600">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim()}
            className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Save</button>
        </div>
      )}>
      <form onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
        <input autoFocus value={name} onChange={(ev) => setName(ev.target.value)} maxLength={200}
          placeholder="e.g. Approved by the principal" aria-label="Version name"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Bold / Italic / Underline', 'Ctrl+B / Ctrl+I / Ctrl+U'],
    ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'],
    ['Insert link', 'Ctrl+K'],
    ['Add comment', 'Ctrl+Alt+M'],
    ['Heading 1–3 / Normal text', 'Ctrl+Alt+1–3 / Ctrl+Alt+0'],
    ['Bulleted / numbered list', 'Ctrl+Shift+8 / Ctrl+Shift+7'],
    ['Checklist', 'Ctrl+Shift+9'],
    ['Indent / outdent', 'Tab / Shift+Tab'],
    ['Page break', 'Ctrl+Enter'],
    ['Clear formatting', 'Ctrl+\\'],
    ['Print or save as PDF', 'Ctrl+P'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="md">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([a, k]) => (
            <tr key={a} className="border-b border-line/60">
              <td className="py-1.5 text-ink">{a}</td>
              <td className="py-1.5 text-right font-mono text-xs text-ink-muted">{k}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
