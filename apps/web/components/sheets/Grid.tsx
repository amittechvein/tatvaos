'use client';

// ============================================================================
//  The grid: a canvas for the cells, a native scroll container for the
//  scrollbars, and one textarea for typing.
//
//  WHY A CANVAS. A sheet of 1,000 rows × 26 columns would be 26,000 DOM
//  nodes; the target is 100,000 rows. The canvas draws only what is on
//  screen (paint.ts), so scrolling costs the same at row 10 or row 90,000.
//
//  WHY NATIVE SCROLLING. A spacer the size of the whole sheet sits inside
//  an overflow:auto box, and the canvas is pinned over it with position:
//  sticky. Scrollbars, wheel, trackpad inertia and touch all come from the
//  browser — none of it is reimplemented, and none of it can drift.
//
//  THE KEYBOARD. Focus lives on a hidden textarea (the "sink"). Arrow keys
//  and shortcuts are read from its keydown; TYPED TEXT arrives through its
//  input event, which is the only way IME (Hindi, Tamil…) and mobile
//  keyboards deliver characters. Copy and paste come through its clipboard
//  events, the only place the browser hands over clipboard data without a
//  permission prompt.
//
//  STATE. Selection and scroll live in refs and repaint the canvas directly;
//  React only hears about the ACTIVE CELL changing (for the formula bar).
//  A mouse drag across a thousand cells does not re-render React once per cell.
// ============================================================================

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { lex } from '@/lib/sheets/engine/lexer';
import { formatValue } from '@/lib/sheets/engine/format';
import { formulaIsSafe } from '@/lib/sheets/io/safety';
import { parseCell, norm, type Rect } from '@/lib/sheets/engine/address';
import type { SheetsModel, Clip } from '@/lib/sheets/model';
import { ruleStyleAt, withRuleStyle } from '@/lib/sheets/rules';
import { Geometry } from './geometry';
import { paint, fontFor, type Remote } from './paint';

export interface Selection { rect: Rect; active: { r: number; c: number }; rowSel: boolean; colSel: boolean }

export interface GridHandle {
  focus(): void;
  select(rect: Rect, active?: { r: number; c: number }): void;
  selection(): Selection;
  /** Start editing the active cell, optionally replacing its content. */
  edit(initial?: string): void;
  /** Called by the formula bar as the person types there. */
  setDraft(text: string | null): void;
  commit(move?: 'down' | 'right' | 'none'): void;
  cancel(): void;
  copy(cut: boolean): void;
  scrollToActive(): void;
  repaint(): void;
}

export interface GridProps {
  model: SheetsModel;
  sheetId: string;
  zoom: number;
  readOnly: boolean;
  remotes: Remote[];
  onSelection: (s: Selection) => void;
  /** The in-cell editor's text changed (formula bar mirrors it); null when editing stops. */
  onDraft: (text: string | null) => void;
  onContextMenu: (x: number, y: number, target: 'cell' | 'row' | 'col') => void;
  onNotice: (message: string) => void;
  /** An error cell is hovered: its message, or null. */
  onHover: (info: { x: number; y: number; text: string } | null) => void;
  hasComment?: (r: number, c: number) => boolean;
  /** Hovering a commented cell. */
  onCommentHover?: (r: number, c: number) => void;
}

const REF_COLOURS = ['#1a73e8', '#e37400', '#188038', '#9334e6', '#d93025', '#12b5cb'];

/** Where the clipboard remembers what we copied, so a paste back in keeps formulas and formats. */
let internalClip: { text: string; clip: Clip } | null = null;

export const Grid = forwardRef<GridHandle, GridProps>(function Grid(props, ref) {
  const { model, sheetId, zoom } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [version, setVersion] = useState(0);         // bumps on structural change → new geometry
  const [editing, setEditing] = useState<{ r: number; c: number; text: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const sel = useRef<Selection>({ rect: { r1: 0, c1: 0, r2: 0, c2: 0 }, active: { r: 0, c: 0 }, rowSel: false, colSel: false });
  const copyRect = useRef<Rect | null>(null);
  /** Column a run of Tab-commits started in (see commit). */
  const tabStart = useRef<number | null>(null);
  const fillPreview = useRef<Rect | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const meta = model.meta(sheetId);
  const frozenRows = meta?.frozenRows ?? 0;
  const frozenCols = meta?.frozenCols ?? 0;

  const geom = useMemo(() => {
    const s = model.size(sheetId);
    return new Geometry({
      rows: s.rows, cols: s.cols, frozenRows, frozenCols, zoom,
      colWidth: (c) => model.colWidth(sheetId, c),
      rowHeight: (r) => model.rowHeight(sheetId, r),
    });
    // version is the structural-change signal; model/sheetId identify the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sheetId, zoom, version, frozenRows, frozenCols]);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  // ---- painting ------------------------------------------------------------
  const frame = useRef<number | null>(null);
  const draw = useCallback(() => {
    frame.current = null;
    const cv = canvas.current;
    const sc = scroller.current;
    if (!cv || !sc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = sc.clientWidth;
    const h = sc.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = propsRef.current;
    const s = sel.current;
    const refBoxes = formulaRefBoxes(editingRef.current?.text ?? null, p.model, p.sheetId);
    // Colour rules are read once per frame, then laid over each cell's own
    // format as it is painted (rules.ts); a sheet with none pays nothing.
    const rules = p.model.colourRules(p.sheetId);
    const locale = p.model.locale();
    paint(ctx, geomRef.current, {
      value: (r, c) => p.model.value(p.sheetId, r, c),
      format: rules.length === 0
        ? (r, c) => p.model.format(p.sheetId, r, c)
        : (r, c) => withRuleStyle(p.model.format(p.sheetId, r, c),
          ruleStyleAt(rules, r, c, () => p.model.value(p.sheetId, r, c), locale)),
      merges: p.model.merges(p.sheetId),
      locale: p.model.locale(),
      hasComment: p.hasComment,
      textInDownloads: (r, c) => textInDownloads(p.model.input(p.sheetId, r, c)),
    }, {
      scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop, width: w, height: h,
      selection: s.rect, active: s.active, rowSel: s.rowSel, colSel: s.colSel,
      copyRect: copyRect.current, fillPreview: fillPreview.current,
      remotes: p.remotes, refBoxes,
      dark: document.documentElement.classList.contains('dark'),
    });
  }, []);

  const repaint = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useLayoutEffect(() => { repaint(); }, [geom, props.remotes, editing, repaint]);

  // Model changes: structural ones rebuild geometry, others just repaint.
  useEffect(() => model.subscribe((e) => {
    if (e.layout) setVersion((v) => v + 1);
    repaint();
    // A colleague deleted the rows under our selection: keep it on the sheet.
    clampSelection();
  }), [model, repaint]);  

  // Size of the viewport.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: sc.clientWidth, h: sc.clientHeight });
      repaint();
    });
    ro.observe(sc);
    return () => ro.disconnect();
  }, [repaint]);

  // Switching sheets: back to A1, top-left.
  useEffect(() => {
    sel.current = { rect: { r1: 0, c1: 0, r2: 0, c2: 0 }, active: { r: 0, c: 0 }, rowSel: false, colSel: false };
    copyRect.current = null;
    setEditing(null);
    if (scroller.current) { scroller.current.scrollLeft = 0; scroller.current.scrollTop = 0; }
    announce();
    repaint();
  }, [sheetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // TODAY()/NOW() keep time while the sheet is open.
  useEffect(() => {
    const t = setInterval(() => { model.engine.tickVolatile(); repaint(); }, 60_000);
    return () => clearInterval(t);
  }, [model, repaint]);

  function clampSelection() {
    const g = geomRef.current;
    const s = sel.current;
    const r = { r1: Math.min(s.rect.r1, g.rows - 1), c1: Math.min(s.rect.c1, g.cols - 1), r2: Math.min(s.rect.r2, g.rows - 1), c2: Math.min(s.rect.c2, g.cols - 1) };
    sel.current = { ...s, rect: r, active: { r: Math.min(s.active.r, g.rows - 1), c: Math.min(s.active.c, g.cols - 1) } };
  }

  function announce() {
    propsRef.current.onSelection({ ...sel.current });
  }

  // ---- selection helpers -----------------------------------------------------
  const mergeAt = useCallback((r: number, c: number) =>
    propsRef.current.model.merges(propsRef.current.sheetId).find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2), []);

  /** Grow a rectangle until no merge sticks out of it, as Sheets does. */
  const expandForMerges = useCallback((rect: Rect): Rect => {
    let r = norm(rect);
    const merges = propsRef.current.model.merges(propsRef.current.sheetId);
    for (let changed = true; changed;) {
      changed = false;
      for (const m of merges) {
        const overlaps = m.r1 <= r.r2 && m.r2 >= r.r1 && m.c1 <= r.c2 && m.c2 >= r.c1;
        if (!overlaps) continue;
        const n = { r1: Math.min(r.r1, m.r1), c1: Math.min(r.c1, m.c1), r2: Math.max(r.r2, m.r2), c2: Math.max(r.c2, m.c2) };
        if (n.r1 !== r.r1 || n.c1 !== r.c1 || n.r2 !== r.r2 || n.c2 !== r.c2) { r = n; changed = true; }
      }
    }
    return r;
  }, []);

  const setSel = useCallback((rect: Rect, active: { r: number; c: number }, opts: { rowSel?: boolean; colSel?: boolean; scroll?: boolean } = {}) => {
    const g = geomRef.current;
    const clamp = (x: Rect): Rect => ({
      r1: Math.max(0, Math.min(x.r1, g.rows - 1)), r2: Math.max(0, Math.min(x.r2, g.rows - 1)),
      c1: Math.max(0, Math.min(x.c1, g.cols - 1)), c2: Math.max(0, Math.min(x.c2, g.cols - 1)),
    });
    sel.current = {
      rect: expandForMerges(clamp(norm(rect))),
      active: { r: Math.max(0, Math.min(active.r, g.rows - 1)), c: Math.max(0, Math.min(active.c, g.cols - 1)) },
      rowSel: !!opts.rowSel, colSel: !!opts.colSel,
    };
    if (opts.scroll !== false) scrollTo(sel.current.active.r, sel.current.active.c);
    announce();
    repaint();
  }, [expandForMerges, repaint]);  

  function scrollTo(r: number, c: number) {
    const sc = scroller.current;
    if (!sc) return;
    const to = geomRef.current.scrollToShow(r, c, sc.scrollLeft, sc.scrollTop, sc.clientWidth, sc.clientHeight);
    if (to) { sc.scrollLeft = to.left; sc.scrollTop = to.top; }
  }

  // ---- editing ---------------------------------------------------------------
  const startEdit = useCallback((initial?: string) => {
    if (propsRef.current.readOnly) {
      propsRef.current.onNotice('You can view this spreadsheet but not change it.');
      return;
    }
    const { r, c } = sel.current.active;
    const existing = propsRef.current.model.input(propsRef.current.sheetId, r, c) ?? '';
    const text = initial ?? existing;
    // Set the ref NOW, not on the next render: keys typed before the cell
    // editor mounts still land in the sink, and onSinkInput must see that an
    // edit is already open and append to it rather than start another.
    editingRef.current = { r, c, text };
    setEditing({ r, c, text });
    propsRef.current.onDraft(text);
    scrollTo(r, c);
    requestAnimationFrame(() => {
      // The edit may already be over (fast typing: text, then Tab, before
      // this frame). Focusing a closing editor would strand focus on
      // nothing and every key after it would be lost.
      const ed = editor.current;
      if (!ed || !editingRef.current || !ed.isConnected) return;
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    });
  }, []);  

  const commit = useCallback((move: 'down' | 'right' | 'up' | 'left' | 'none' = 'down') => {
    const e = editingRef.current;
    if (!e) return;
    const p = propsRef.current;
    const before = p.model.input(p.sheetId, e.r, e.c) ?? '';
    let text = e.text;
    // A formula left with unclosed brackets is closed for the person, as in Sheets.
    if (text.startsWith('=')) {
      const open = (text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
      if (open > 0 && !/"[^"]*$/.test(text)) text += ')'.repeat(open);
    }
    if (text !== before) p.model.setInputs(p.sheetId, [{ r: e.r, c: e.c, input: text === '' ? null : text }]);
    setEditing(null);
    p.onDraft(null);
    const d = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1], none: [0, 0] }[move] as [number, number];
    const m = mergeAt(e.r, e.c);
    const r = move === 'down' && m ? m.r2 + 1 : e.r + d[0];
    let c = move === 'right' && m ? m.c2 + 1 : e.c + d[1];
    // Typing across a row with Tab, then Enter, goes to the start of the
    // next row — the column the Tabs began in — as in Sheets and Excel.
    if (move === 'right') tabStart.current ??= e.c;
    else if (move === 'down' && tabStart.current !== null) { c = tabStart.current; tabStart.current = null; }
    else tabStart.current = null;
    editingRef.current = null;
    setSel({ r1: r, c1: c, r2: r, c2: c }, { r, c });
    sink.current?.focus();
  }, [mergeAt, setSel]);

  const cancel = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
    propsRef.current.onDraft(null);
    sink.current?.focus();
    repaint();
  }, [repaint]);

  // ---- clipboard ---------------------------------------------------------------
  const doCopy = useCallback((cut: boolean, data: DataTransfer | null) => {
    const p = propsRef.current;
    const rect = sel.current.rect;
    const clip = p.model.copy(p.sheetId, rect);
    // As text: the DISPLAYED values, tab-separated — what another program expects.
    const rows: string[] = [];
    for (let r = rect.r1; r <= rect.r2; r += 1) {
      const cells: string[] = [];
      for (let c = rect.c1; c <= rect.c2; c += 1) cells.push(displayText(p.model, p.sheetId, r, c));
      rows.push(cells.join('\t'));
    }
    const text = rows.join('\n');
    internalClip = { text, clip };
    copyRect.current = rect;
    if (data) {
      data.setData('text/plain', text);
      data.setData('text/html', htmlTable(p.model, p.sheetId, rect));
    } else {
      void navigator.clipboard?.writeText(text).catch(() => {});
    }
    if (cut && !p.readOnly) {
      p.model.clear(p.sheetId, rect, 'all');
      copyRect.current = null;
      internalClip = null; // a cut pastes as values, the formulas' source is gone
      if (data) data.setData('text/plain', text);
    }
    repaint();
  }, [repaint]);

  const doPaste = useCallback((text: string, html: string | null, mode: 'all' | 'values' | 'formats' = 'all') => {
    const p = propsRef.current;
    if (p.readOnly) { p.onNotice('You can view this spreadsheet but not change it.'); return; }
    const { r, c } = sel.current.active;
    if (internalClip && internalClip.text === text) {
      const src = internalClip.clip;
      p.model.paste(p.sheetId, r, c, src, mode, (rr, cc) => p.model.value(src.sheetId, rr, cc));
      const h = src.cells.length; const w = src.cells[0]?.length ?? 1;
      setSel({ r1: r, c1: c, r2: r + h - 1, c2: c + w - 1 }, { r, c });
      return;
    }
    const rows = html ? parseHtmlTable(html) ?? parseTsv(text) : parseTsv(text);
    if (rows.length === 0) return;
    p.model.pasteText(p.sheetId, r, c, rows);
    setSel({ r1: r, c1: c, r2: r + rows.length - 1, c2: c + Math.max(...rows.map((x) => x.length)) - 1 }, { r, c });
  }, [setSel]);

  // ---- imperative handle -------------------------------------------------------
  useImperativeHandle(ref, () => ({
    focus: () => sink.current?.focus(),
    select: (rect, active) => setSel(rect, active ?? { r: rect.r1, c: rect.c1 }),
    selection: () => ({ ...sel.current }),
    edit: (initial) => startEdit(initial),
    setDraft: (text) => {
      if (text === null) { setEditing(null); return; }
      const { r, c } = sel.current.active;
      setEditing({ r, c, text });
    },
    commit: (move = 'down') => commit(move),
    cancel,
    copy: (cut) => doCopy(cut, null),
    scrollToActive: () => scrollTo(sel.current.active.r, sel.current.active.c),
    repaint,
  }), [setSel, startEdit, commit, cancel, doCopy, repaint]);  

  // ---- keyboard ------------------------------------------------------------------
  function dataEdge(r: number, c: number, dr: number, dc: number): { r: number; c: number } {
    // Ctrl+arrow: to the edge of the current block of data, or the next block.
    const p = propsRef.current;
    const g = geomRef.current;
    const filled = (rr: number, cc: number) => {
      const v = p.model.input(p.sheetId, rr, cc);
      return v !== null && v !== '';
    };
    let rr = r; let cc = c;
    const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < g.rows && y < g.cols;
    if (filled(rr, cc) && inb(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) {
      while (inb(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) { rr += dr; cc += dc; }
      return { r: rr, c: cc };
    }
    rr += dr; cc += dc;
    while (inb(rr, cc) && !filled(rr, cc)) { rr += dr; cc += dc; }
    if (!inb(rr, cc)) return { r: Math.max(0, Math.min(g.rows - 1, rr - dr)), c: Math.max(0, Math.min(g.cols - 1, cc - dc)) };
    return { r: rr, c: cc };
  }

  function onSinkKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // An edit opened by typing, whose editor has not taken focus yet: the
    // keys that end or change an edit act on it here, as they would there.
    if (editingRef.current) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        if (e.key === 'Escape') cancel();
        else if (e.key === 'Backspace') appendToEdit(null);
        else commit(e.key === 'Tab' ? (e.shiftKey ? 'left' : 'right') : (e.shiftKey ? 'up' : 'down'));
      }
      return;
    }
    const p = propsRef.current;
    const g = geomRef.current;
    const s = sel.current;
    const mod = e.ctrlKey || e.metaKey;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      if (e.shiftKey) {
        // Extend: the far corner moves, the active cell stays.
        const far = { r: s.rect.r1 === s.active.r ? s.rect.r2 : s.rect.r1, c: s.rect.c1 === s.active.c ? s.rect.c2 : s.rect.c1 };
        const to = mod ? dataEdge(far.r, far.c, dr, dc) : { r: far.r + dr, c: far.c + dc };
        setSel({ r1: s.active.r, c1: s.active.c, r2: to.r, c2: to.c }, s.active, { scroll: false });
        scrollTo(Math.max(0, Math.min(g.rows - 1, to.r)), Math.max(0, Math.min(g.cols - 1, to.c)));
        return;
      }
      let to = mod ? dataEdge(s.active.r, s.active.c, dr, dc) : { r: s.active.r + dr, c: s.active.c + dc };
      const m = mergeAt(s.active.r, s.active.c);
      if (!mod && m) to = { r: dr > 0 ? m.r2 + 1 : dr < 0 ? m.r1 - 1 : s.active.r, c: dc > 0 ? m.c2 + 1 : dc < 0 ? m.c1 - 1 : s.active.c };
      setSel({ r1: to.r, c1: to.c, r2: to.r, c2: to.c }, to);
    };

    switch (e.key) {
      case 'ArrowDown': return move(1, 0);
      case 'ArrowUp': return move(-1, 0);
      case 'ArrowRight': return move(0, 1);
      case 'ArrowLeft': return move(0, -1);
      case 'Tab': return move(0, e.shiftKey ? -1 : 1);
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) return move(-1, 0);
        startEdit();
        return;
      case 'F2': e.preventDefault(); startEdit(); return;
      case 'Home': {
        e.preventDefault();
        const to = { r: mod ? 0 : s.active.r, c: 0 };
        setSel({ r1: to.r, c1: 0, r2: to.r, c2: 0 }, to);
        return;
      }
      case 'End': {
        e.preventDefault();
        const ext = p.model.extent(p.sheetId);
        const to = { r: mod ? Math.max(0, ext.lastRow) : s.active.r, c: Math.max(0, ext.lastCol) };
        setSel({ r1: to.r, c1: to.c, r2: to.r, c2: to.c }, to);
        return;
      }
      case 'PageDown': case 'PageUp': {
        e.preventDefault();
        const rowsOnScreen = Math.max(1, Math.floor((scroller.current!.clientHeight - g.headerH) / (21 * zoom)) - 1);
        return move(e.key === 'PageDown' ? rowsOnScreen : -rowsOnScreen, 0);
      }
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (p.readOnly) return p.onNotice('You can view this spreadsheet but not change it.');
        p.model.clear(p.sheetId, s.rect, 'values');
        return;
      case 'Escape':
        copyRect.current = null;
        repaint();
        return;
    }

    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); setSel({ r1: 0, c1: 0, r2: g.rows - 1, c2: g.cols - 1 }, s.active, { rowSel: true, colSel: true, scroll: false }); return; }
      if (k === 'z' && !p.readOnly) { e.preventDefault(); if (e.shiftKey) p.model.undo.redo(); else p.model.undo.undo(); return; }
      if (k === 'y' && !p.readOnly) { e.preventDefault(); p.model.undo.redo(); return; }
      if (p.readOnly) return;
      const toggle = (field: 'b' | 'i' | 'u' | 's') => {
        e.preventDefault();
        const cur = p.model.format(p.sheetId, s.active.r, s.active.c)?.[field];
        p.model.setFormat(p.sheetId, s.rect, { [field]: cur ? undefined : true });
      };
      if (k === 'b') return toggle('b');
      if (k === 'i') return toggle('i');
      if (k === 'u') return toggle('u');
      if (k === '5' && e.shiftKey === false && e.altKey === false) return toggle('s');
      if (k === ';') {
        // Ctrl+; today's date, Ctrl+Shift+; the time — as in Sheets and Excel.
        e.preventDefault();
        const now = new Date();
        const text = e.shiftKey
          ? now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase()
          : `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
        p.model.setInputs(p.sheetId, [{ r: s.active.r, c: s.active.c, input: text }]);
        return;
      }
      if (k === 'enter') {
        // Ctrl+Enter: fill the selection with the active cell.
        e.preventDefault();
        p.model.fill(p.sheetId, { r1: s.active.r, c1: s.active.c, r2: s.active.r, c2: s.active.c }, s.rect);
      }
    }
  }

  // Typed characters arrive here (see the header on IME).
  function onSinkInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget.value;
    e.currentTarget.value = '';
    if (!t) return;
    if (editingRef.current) appendToEdit(t); else startEdit(t);
  }

  /** Add typed text to (or, for null, take one character off) an edit still owned by the sink. */
  function appendToEdit(t: string | null) {
    const cur = editingRef.current;
    if (!cur) return;
    const text = t === null ? cur.text.slice(0, -1) : cur.text + t;
    editingRef.current = { ...cur, text };
    setEditing({ ...cur, text });
    propsRef.current.onDraft(text);
  }

  function onEditorKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); commit(e.shiftKey ? 'up' : 'down'); return; }
    if (e.key === 'Enter' && (e.altKey || e.ctrlKey || e.metaKey)) {
      // A line break inside the cell.
      e.preventDefault();
      const ed = e.currentTarget;
      const v = `${ed.value.slice(0, ed.selectionStart)}\n${ed.value.slice(ed.selectionEnd)}`;
      const at = ed.selectionStart + 1;
      setEditing((x) => (x ? { ...x, text: v } : x));
      propsRef.current.onDraft(v);
      requestAnimationFrame(() => ed.setSelectionRange(at, at));
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'left' : 'right'); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    const ed = e.currentTarget;
    // Arrow keys leave the cell when typing a fresh value (not a formula), as in Sheets.
    if (['ArrowUp', 'ArrowDown'].includes(e.key) && !ed.value.startsWith('=') && !ed.value.includes('\n')) {
      e.preventDefault();
      commit(e.key === 'ArrowUp' ? 'up' : 'down');
    }
  }

  // ---- mouse -----------------------------------------------------------------------
  const drag = useRef<null | {
    kind: 'cells' | 'rows' | 'cols' | 'fill' | 'resize-col' | 'resize-row' | 'ref';
    start: { r: number; c: number };
    index?: number; origin?: number; size?: number;
    refStart?: number; refEnd?: number;
  }>(null);

  function hit(e: { clientX: number; clientY: number }) {
    const cv = canvas.current!;
    const b = cv.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    const g = geomRef.current;
    const sc = scroller.current!;
    const sx = g.sheetX(x, sc.scrollLeft);
    const sy = g.sheetY(y, sc.scrollTop);
    return { x, y, r: g.rowAt(sy), c: g.colAt(sx), sx, sy, inRowHeader: x < g.headerW, inColHeader: y < g.headerH };
  }

  /** Near a column or row divider in the headers? Returns which one. */
  function divider(h: ReturnType<typeof hit>): { kind: 'col' | 'row'; index: number } | null {
    const g = geomRef.current;
    if (h.inColHeader && !h.inRowHeader) {
      const right = g.colX[h.c + 1]!;
      const left = g.colX[h.c]!;
      if (Math.abs(h.sx - right) <= 4) return { kind: 'col', index: h.c };
      if (Math.abs(h.sx - left) <= 4 && h.c > 0) return { kind: 'col', index: h.c - 1 };
    }
    if (h.inRowHeader && !h.inColHeader) {
      const bottom = g.rowY[h.r + 1]!;
      const top = g.rowY[h.r]!;
      if (Math.abs(h.sy - bottom) <= 3) return { kind: 'row', index: h.r };
      if (Math.abs(h.sy - top) <= 3 && h.r > 0) return { kind: 'row', index: h.r - 1 };
    }
    return null;
  }

  function onFillHandle(h: ReturnType<typeof hit>): boolean {
    const g = geomRef.current;
    const sc = scroller.current!;
    const s = sel.current.rect;
    const x = g.viewX(g.colX[s.c2 + 1]!, sc.scrollLeft);
    const y = g.viewY(g.rowY[s.r2 + 1]!, sc.scrollTop);
    return Math.abs(h.x - x) <= 5 && Math.abs(h.y - y) <= 5;
  }

  /** While editing a formula, is the caret where a reference could go (after an operator or "(")? */
  function refInsertPoint(): { start: number; end: number } | null {
    const e = editingRef.current;
    const ed = editor.current;
    if (!e || !ed || !e.text.startsWith('=')) return null;
    const caret = ed.selectionStart;
    const before = e.text.slice(0, caret);
    // Replace a reference the caret is just after (so dragging refines it).
    const m = /(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(before);
    if (m && /[=(,+\-*/^&<>:;\s]$/.test(before.slice(0, before.length - m[1]!.length))) {
      return { start: caret - m[1]!.length, end: caret };
    }
    if (/[=(,+\-*/^&<>;\s]$/.test(before)) return { start: caret, end: caret };
    return null;
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button === 2) return; // context menu handles it
    tabStart.current = null;
    const h = hit(e);
    const g = geomRef.current;
    const p = propsRef.current;

    // Clicking a cell while typing a formula puts its reference in the formula.
    if (editingRef.current && !h.inColHeader && !h.inRowHeader) {
      const at = refInsertPoint();
      if (at) {
        e.preventDefault();
        insertRef(at, { r1: h.r, c1: h.c, r2: h.r, c2: h.c });
        drag.current = { kind: 'ref', start: { r: h.r, c: h.c }, refStart: at.start };
        return;
      }
      commit('none');
    }

    const dv = divider(h);
    if (dv && !p.readOnly) {
      e.preventDefault();
      drag.current = dv.kind === 'col'
        ? { kind: 'resize-col', start: { r: 0, c: dv.index }, index: dv.index, origin: e.clientX, size: g.colWidth(dv.index) / zoom }
        : { kind: 'resize-row', start: { r: dv.index, c: 0 }, index: dv.index, origin: e.clientY, size: g.rowHeight(dv.index) / zoom };
      return;
    }

    sink.current?.focus({ preventScroll: true });
    e.preventDefault();

    if (h.inColHeader && h.inRowHeader) {
      setSel({ r1: 0, c1: 0, r2: g.rows - 1, c2: g.cols - 1 }, { r: 0, c: 0 }, { rowSel: true, colSel: true, scroll: false });
      return;
    }
    if (h.inColHeader) {
      const s = sel.current;
      const c1 = e.shiftKey ? s.active.c : h.c;
      setSel({ r1: 0, c1, r2: g.rows - 1, c2: h.c }, { r: 0, c: c1 }, { colSel: true, scroll: false });
      drag.current = { kind: 'cols', start: { r: 0, c: c1 } };
      return;
    }
    if (h.inRowHeader) {
      const s = sel.current;
      const r1 = e.shiftKey ? s.active.r : h.r;
      setSel({ r1, c1: 0, r2: h.r, c2: g.cols - 1 }, { r: r1, c: 0 }, { rowSel: true, scroll: false });
      drag.current = { kind: 'rows', start: { r: r1, c: 0 } };
      return;
    }
    if (onFillHandle(h) && !p.readOnly) {
      drag.current = { kind: 'fill', start: { r: h.r, c: h.c } };
      return;
    }
    if (e.shiftKey) {
      const a = sel.current.active;
      setSel({ r1: a.r, c1: a.c, r2: h.r, c2: h.c }, a, { scroll: false });
    } else {
      const m = mergeAt(h.r, h.c);
      const at = m ? { r: m.r1, c: m.c1 } : { r: h.r, c: h.c };
      setSel({ r1: at.r, c1: at.c, r2: at.r, c2: at.c }, at, { scroll: false });
    }
    drag.current = { kind: 'cells', start: sel.current.active };
  }

  function insertRef(at: { start: number; end: number }, rect: Rect) {
    const e = editingRef.current;
    if (!e) return;
    const g = geomRef.current;
    const name = rect.r1 === rect.r2 && rect.c1 === rect.c2
      ? cellLabel(rect.r1, rect.c1)
      : `${cellLabel(rect.r1, rect.c1)}:${cellLabel(Math.min(rect.r2, g.rows - 1), Math.min(rect.c2, g.cols - 1))}`;
    const text = e.text.slice(0, at.start) + name + e.text.slice(at.end);
    setEditing({ ...e, text });
    propsRef.current.onDraft(text);
    const caret = at.start + name.length;
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(caret, caret); });
    if (drag.current?.kind === 'ref') drag.current.refEnd = caret;
  }

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) {
        // Hover: cursors for dividers and the fill handle, and error messages.
        if (!canvas.current) return;
        const b = canvas.current.getBoundingClientRect();
        if (e.clientX < b.left || e.clientY < b.top || e.clientX > b.right || e.clientY > b.bottom) return;
        const h = hit(e);
        const dv = divider(h);
        canvas.current.style.cursor = dv ? (dv.kind === 'col' ? 'col-resize' : 'row-resize')
          : onFillHandle(h) ? 'crosshair' : h.inColHeader || h.inRowHeader ? 'default' : 'cell';
        const p = propsRef.current;
        if (!h.inColHeader && !h.inRowHeader) {
          const v = p.model.value(p.sheetId, h.r, h.c);
          if (v !== null && typeof v === 'object') {
            p.onHover({ x: e.clientX, y: e.clientY, text: `${v.code} — ${v.message}` });
            return;
          }
          if (textInDownloads(p.model.input(p.sheetId, h.r, h.c))) {
            p.onHover({ x: e.clientX, y: e.clientY, text: TEXT_IN_DOWNLOADS });
            return;
          }
        }
        p.onHover(null);
        return;
      }
      const h = hit(e);
      const g = geomRef.current;
      const p = propsRef.current;
      switch (d.kind) {
        case 'cells':
          setSel({ r1: d.start.r, c1: d.start.c, r2: h.r, c2: h.c }, d.start, { scroll: false });
          break;
        case 'rows':
          setSel({ r1: d.start.r, c1: 0, r2: h.r, c2: g.cols - 1 }, d.start, { rowSel: true, scroll: false });
          break;
        case 'cols':
          setSel({ r1: 0, c1: d.start.c, r2: g.rows - 1, c2: h.c }, d.start, { colSel: true, scroll: false });
          break;
        case 'ref':
          if (d.refStart !== undefined) {
            insertRef({ start: d.refStart, end: d.refEnd ?? d.refStart }, norm({ r1: d.start.r, c1: d.start.c, r2: h.r, c2: h.c }));
          }
          break;
        case 'fill': {
          // Fill extends along whichever axis the pointer has moved further out on.
          const s = sel.current.rect;
          const down = h.r > s.r2 ? h.r - s.r2 : h.r < s.r1 ? s.r1 - h.r : 0;
          const across = h.c > s.c2 ? h.c - s.c2 : h.c < s.c1 ? s.c1 - h.c : 0;
          fillPreview.current = down === 0 && across === 0 ? null
            : down >= across
              ? { r1: Math.min(s.r1, h.r), c1: s.c1, r2: Math.max(s.r2, h.r), c2: s.c2 }
              : { r1: s.r1, c1: Math.min(s.c1, h.c), r2: s.r2, c2: Math.max(s.c2, h.c) };
          repaint();
          break;
        }
        case 'resize-col': {
          const w = Math.max(20, d.size! + (e.clientX - d.origin!) / zoom);
          p.model.setColWidth(p.sheetId, colsToResize(d.index!), w);
          break;
        }
        case 'resize-row': {
          const hh = Math.max(12, d.size! + (e.clientY - d.origin!) / zoom);
          p.model.setRowHeight(p.sheetId, rowsToResize(d.index!), hh);
          break;
        }
      }
      // Auto-scroll while dragging past the edge.
      const sc = scroller.current;
      if (sc && ['cells', 'rows', 'cols', 'fill', 'ref'].includes(d.kind)) {
        const b = sc.getBoundingClientRect();
        if (e.clientY > b.bottom - 20) sc.scrollTop += 20;
        else if (e.clientY < b.top + geomRef.current.headerH + 10) sc.scrollTop -= 20;
        if (e.clientX > b.right - 20) sc.scrollLeft += 20;
        else if (e.clientX < b.left + geomRef.current.headerW + 10) sc.scrollLeft -= 20;
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.kind === 'fill' && fillPreview.current) {
        const p = propsRef.current;
        const dest = fillPreview.current;
        fillPreview.current = null;
        p.model.fill(p.sheetId, sel.current.rect, dest);
        setSel(dest, sel.current.active, { scroll: false });
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [setSel, repaint, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resizing one column of a multi-column selection resizes them all, as in Sheets. */
  function colsToResize(c: number): number[] {
    const s = sel.current;
    if (s.colSel && c >= s.rect.c1 && c <= s.rect.c2) return range(s.rect.c1, s.rect.c2);
    return [c];
  }
  function rowsToResize(r: number): number[] {
    const s = sel.current;
    if (s.rowSel && r >= s.rect.r1 && r <= s.rect.r2) return range(s.rect.r1, s.rect.r2);
    return [r];
  }

  function onDoubleClick(e: React.MouseEvent) {
    const h = hit(e);
    const p = propsRef.current;
    const dv = divider(h);
    if (dv && dv.kind === 'col' && !p.readOnly) {
      // Double-click a column divider: fit the column to its widest content.
      p.model.setColWidth(p.sheetId, colsToResize(dv.index), fitWidth(dv.index));
      return;
    }
    if (h.inColHeader || h.inRowHeader) return;
    startEdit();
  }

  function fitWidth(c: number): number {
    const p = propsRef.current;
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return 100;
    let w = 30;
    for (const [r, cc] of p.model.filled(p.sheetId)) {
      if (cc !== c) continue;
      ctx.font = fontFor(p.model.format(p.sheetId, r, c), 1);
      w = Math.max(w, ctx.measureText(displayText(p.model, p.sheetId, r, c)).width + 10);
    }
    return Math.min(1000, w);
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const h = hit(e);
    const s = sel.current;
    const inside = h.r >= s.rect.r1 && h.r <= s.rect.r2 && h.c >= s.rect.c1 && h.c <= s.rect.c2;
    const g = geomRef.current;
    if (h.inColHeader && !h.inRowHeader) {
      if (!(s.colSel && inside)) setSel({ r1: 0, c1: h.c, r2: g.rows - 1, c2: h.c }, { r: 0, c: h.c }, { colSel: true, scroll: false });
      propsRef.current.onContextMenu(e.clientX, e.clientY, 'col');
    } else if (h.inRowHeader && !h.inColHeader) {
      if (!(s.rowSel && inside)) setSel({ r1: h.r, c1: 0, r2: h.r, c2: g.cols - 1 }, { r: h.r, c: 0 }, { rowSel: true, scroll: false });
      propsRef.current.onContextMenu(e.clientX, e.clientY, 'row');
    } else {
      if (!inside) setSel({ r1: h.r, c1: h.c, r2: h.r, c2: h.c }, { r: h.r, c: h.c }, { scroll: false });
      propsRef.current.onContextMenu(e.clientX, e.clientY, 'cell');
    }
    sink.current?.focus({ preventScroll: true });
  }

  // ---- the in-cell editor's box ---------------------------------------------------
  let editorBox: React.CSSProperties | null = null;
  if (editing && scroller.current) {
    const g = geom;
    const sc = scroller.current;
    const m = mergeAt(editing.r, editing.c);
    const r2 = m ? m.r2 : editing.r;
    const c2 = m ? m.c2 : editing.c;
    const x = g.viewX(g.colX[editing.c]!, sc.scrollLeft);
    const y = g.viewY(g.rowY[editing.r]!, sc.scrollTop);
    const f = model.format(sheetId, editing.r, editing.c);
    editorBox = {
      left: x, top: y,
      minWidth: g.colX[c2 + 1]! - g.colX[editing.c]! + 1,
      minHeight: g.rowY[r2 + 1]! - g.rowY[editing.r]! + 1,
      maxWidth: Math.max(120, size.w - x - 8),
      font: fontFor(f, zoom),
      color: f?.color,
      background: f?.bg ?? undefined,
    };
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="sheets-scroller absolute inset-0 overflow-auto"
        onScroll={() => { repaint(); props.onHover(null); }}>
        <div style={{ width: geom.headerW + geom.totalW + 60, height: geom.headerH + geom.totalH + 60 }}>
          <canvas ref={canvas} className="sticky left-0 top-0 block"
            onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
            role="grid" aria-label="Spreadsheet" aria-rowcount={geom.rows} aria-colcount={geom.cols} />
        </div>
      </div>

      {/* Keyboard sink: focused whenever the grid is, never visible. */}
      <textarea ref={sink} aria-label={`Cell ${cellLabel(sel.current.active.r, sel.current.active.c)}`}
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onKeyDown={onSinkKey} onInput={onSinkInput}
        onCopy={(e) => { e.preventDefault(); doCopy(false, e.clipboardData); }}
        onCut={(e) => { e.preventDefault(); doCopy(true, e.clipboardData); }}
        onPaste={(e) => {
          e.preventDefault();
          doPaste(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html') || null);
        }} />

      {editing && editorBox && (
        <textarea ref={editor} value={editing.text} aria-label="Cell contents"
          spellCheck={false}
          onChange={(e) => { const t = e.target.value; setEditing((x) => (x ? { ...x, text: t } : x)); props.onDraft(t); }}
          onKeyDown={onEditorKey}
          onBlur={(e) => {
            // Leaving for the formula bar keeps the edit open; anywhere else commits.
            const to = e.relatedTarget as HTMLElement | null;
            if (to?.dataset.sheetsFormulaBar === 'true') return;
            if (editingRef.current) commit('none');
          }}
          className="sheets-cell-editor absolute z-20 resize-none overflow-hidden whitespace-pre-wrap border-2 border-[#1a73e8] bg-white px-[3px] py-0 text-black shadow-lg outline-none dark:bg-[#1f1f1f] dark:text-[#e8eaed]"
          style={editorBox} rows={Math.max(1, editing.text.split('\n').length)} />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------

/** Said on hover and under the formula bar for a formula safety.ts keeps out of files. */
export const TEXT_IN_DOWNLOADS =
  'This formula works here, but it is saved as plain text in Excel downloads and email attachments, '
  + 'because it would reach outside the file (a command, another file, a web fetch, or a link that is not http, https or mailto).';

const safeCache = new Map<string, boolean>();
/** Is this input a formula the .xlsx writer will turn into text? Cached: it runs for every cell painted. */
export function textInDownloads(input: string | null): boolean {
  if (!input || !input.startsWith('=') || input.length < 2) return false;
  let safe = safeCache.get(input);
  if (safe === undefined) {
    safe = formulaIsSafe(input);
    if (safeCache.size > 5000) safeCache.clear();
    safeCache.set(input, safe);
  }
  return !safe;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

export function cellLabel(r: number, c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return `${s}${r + 1}`;
}

/** The text a cell shows — what copying to another program should carry. */
export function displayText(model: SheetsModel, sheetId: string, r: number, c: number): string {
  const v = model.value(sheetId, r, c);
  if (v === null) return '';
  return formatValue(v, model.format(sheetId, r, c)?.nf, model.locale()).text;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A copied range as an HTML table, so pasting into Docs, Mail or Word keeps the grid. */
function htmlTable(model: SheetsModel, sheetId: string, rect: Rect): string {
  const rows: string[] = [];
  for (let r = rect.r1; r <= rect.r2; r += 1) {
    const cells: string[] = [];
    for (let c = rect.c1; c <= rect.c2; c += 1) {
      const f = model.format(sheetId, r, c);
      const style = [
        f?.b ? 'font-weight:bold' : '', f?.i ? 'font-style:italic' : '',
        f?.color && /^#[0-9a-f]{6}$/i.test(f.color) ? `color:${f.color}` : '',
        f?.bg && /^#[0-9a-f]{6}$/i.test(f.bg) ? `background:${f.bg}` : '',
      ].filter(Boolean).join(';');
      cells.push(`<td${style ? ` style="${style}"` : ''}>${escapeHtml(displayText(model, sheetId, r, c))}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return `<table>${rows.join('')}</table>`;
}

/** Tab-separated text (Excel, Sheets and most programs copy this), with quoted cells. */
export function parseTsv(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (t === '') return [];
  const rows: string[][] = [[]];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
      continue;
    }
    if (ch === '"' && cur === '') { quoted = true; continue; }
    if (ch === '\t') { rows[rows.length - 1]!.push(cur); cur = ''; continue; }
    if (ch === '\n') { rows[rows.length - 1]!.push(cur); cur = ''; rows.push([]); continue; }
    cur += ch;
  }
  rows[rows.length - 1]!.push(cur);
  return rows;
}

/** A pasted HTML table (from a web page or Google Sheets), as rows of text. Never rendered. */
function parseHtmlTable(html: string): string[][] | null {
  if (!/<table/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows: string[][] = [];
  table.querySelectorAll('tr').forEach((tr) => {
    const row: string[] = [];
    tr.querySelectorAll('td,th').forEach((td) => row.push((td.textContent ?? '').trim()));
    rows.push(row);
  });
  return rows.length > 0 ? rows : null;
}

/** Coloured boxes for the references in a formula being typed, as Sheets draws them. */
function formulaRefBoxes(text: string | null, model: SheetsModel, sheetId: string): { rect: Rect; color: string }[] {
  if (!text || !text.startsWith('=')) return [];
  let toks;
  try { toks = lex(text.slice(1)).filter((t) => t.type !== 'ws'); } catch { return []; }
  const out: { rect: Rect; color: string }[] = [];
  const seen = new Map<string, string>();
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.type === 'sheet') { i += 1; continue; } // other sheets are not on screen
    if (t.type !== 'ident' || toks[i + 1]?.type === 'lparen') continue;
    const a = parseCell(t.text);
    if (!a) continue;
    let rect: Rect = { r1: a.row, c1: a.col, r2: a.row, c2: a.col };
    let label = t.text.toUpperCase();
    if (toks[i + 1]?.text === ':' && toks[i + 2]?.type === 'ident') {
      const b = parseCell(toks[i + 2]!.text);
      if (b) { rect = norm({ r1: a.row, c1: a.col, r2: b.row, c2: b.col }); label += `:${toks[i + 2]!.text.toUpperCase()}`; i += 2; }
    }
    const size = model.size(sheetId);
    if (rect.r1 >= size.rows || rect.c1 >= size.cols) continue;
    const color = seen.get(label) ?? REF_COLOURS[seen.size % REF_COLOURS.length]!;
    seen.set(label, color);
    out.push({ rect, color });
  }
  return out;
}
