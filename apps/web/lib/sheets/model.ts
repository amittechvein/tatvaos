// ============================================================================
//  TatvaOS Sheets — the live spreadsheet, on Yjs.
//
//  THE LAYOUT OF THE Y.Doc
//
//    order     Y.Array<sheetId>            tab order
//    sheets    Y.Map<sheetId, Y.Map>       one map per sheet:
//                name, tabColor, hidden, frozenRows, frozenCols
//                rows       Y.Array<rowId>          top to bottom
//                cols       Y.Array<colId>          left to right
//                values     Y.Map<"rowId|colId", string>        input as typed
//                formats    Y.Map<"rowId|colId", CellFormat>
//                colWidths  Y.Map<colId, px>    rowHeights  Y.Map<rowId, px>
//                merges     Y.Map<mergeId, { r1, c1, r2, c2 }>  (ids, not positions)
//                rules      Y.Map<ruleId, { r1, c1, r2, c2, kind, a, b, style, n }>
//                           colour rules (rules.ts); OPTIONAL — sheets made
//                           before 9 Oct 2026 have none
//                lists      Y.Map<listId, { r1, c1, r2, c2, items, strict, n }>
//                           dropdowns (dropdowns.ts); OPTIONAL, as rules
//                filter     Y.Map { range: { r1, c1, r2, c2 }, <colId>: hidden values[] }
//                           the sheet's one filter (filter.ts); OPTIONAL
//    settings  Y.Map                        locale grouping, date order
//
//  WHY IDS AND NOT POSITIONS. Cells are keyed by the ids of their row and
//  column, never by "B7". If Priya inserts a row above row 5 while Amit is
//  typing into B7, Amit's text still lands in the row he was typing in:
//  Yjs merges the insertion into the rows array, and his key never
//  mentioned "7". Keyed by position, one of them would silently overwrite
//  the wrong cell — the worst failure a shared spreadsheet can have.
//
//  WHAT IS STILL LAST-WRITER-WINS. Two people typing into the same cell at
//  the same moment: one value survives, as in Google Sheets. Values and
//  formats are separate maps, so one person's typing never undoes another's
//  bolding of the same cell.
//
//  WHAT FORMULAS SEE. Formulas are written in positions (=SUM(B2:B9)), so
//  on an insert or delete the person doing it rewrites every affected
//  formula in the same transaction (engine/rewrite.ts). A formula typed by
//  someone else in the very same instant is not rewritten — the one gap
//  left, and it needs two people and the same half-second.
//
//  UNDO is per person (Y.UndoManager tracking only our own transactions),
//  so Ctrl+Z never undoes a colleague.
// ============================================================================

import * as Y from 'yjs';
import { Engine } from './engine/engine';
import { parseInput } from './engine/input';
import { quoteSheet, type Rect, norm } from './engine/address';
import { INDIA, type Locale, type Scalar, type WorkbookSource } from './engine/types';
import { compare } from './engine/values';
import {
  translateFormula, shiftFormula, renameSheetInFormula, dropSheetInFormula,
} from './engine/rewrite';
import {
  DEFAULT_COLS, DEFAULT_ROWS, cellKey, parseCellKey,
  cleanFormat, type CellFormat, type SheetData, type WorkbookData,
} from './workbook';
import { cleanRule, type ColourRule, type PlacedRule } from './rules';
import { cleanDropdown, dropdownAt as findDropdown, type Dropdown, type PlacedDropdown } from './dropdowns';
import { cleanHiddenValues, filterKey, hiddenRows, type FilterData, type PlacedFilter } from './filter';
import { formatValue } from './engine/format';

/** The per-sheet maps of ranges with something attached (see placed()). */
type PlacedField = 'rules' | 'lists';
const PLACED_FIELDS: readonly PlacedField[] = ['rules', 'lists'];

/** Transactions from this tab carry this origin; the undo manager tracks only these. */
export const LOCAL = { local: true };

export interface SheetMeta {
  id: string;
  name: string;
  tabColor?: string;
  hidden?: boolean;
  frozenRows: number;
  frozenCols: number;
}

export interface MergeRect extends Rect { id: string }

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * The first sheet of a new spreadsheet, built identically by every browser.
 * Written by a Y.Doc with a fixed clientID and fixed ids, so two people who
 * open a brand-new spreadsheet at the same moment produce the SAME update —
 * Yjs sees one sheet, not two "Sheet1"s.
 */
function seedUpdate(): Uint8Array {
  const d = new Y.Doc();
  d.clientID = 1;
  d.transact(() => {
    const sheets = d.getMap<Y.Map<unknown>>('sheets');
    const s = new Y.Map<unknown>();
    sheets.set('s1', s);
    s.set('name', 'Sheet1');
    s.set('frozenRows', 0);
    s.set('frozenCols', 0);
    const rows = new Y.Array<string>();
    rows.push(Array.from({ length: DEFAULT_ROWS }, (_, i) => `r${i}`));
    const cols = new Y.Array<string>();
    cols.push(Array.from({ length: DEFAULT_COLS }, (_, i) => `c${i}`));
    s.set('rows', rows);
    s.set('cols', cols);
    for (const k of ['values', 'formats', 'colWidths', 'rowHeights', 'merges']) s.set(k, new Y.Map());
    d.getArray<string>('order').push(['s1']);
  });
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

/** Per-sheet caches rebuilt from the Y structures when they change. */
interface SheetCache {
  y: Y.Map<unknown>;
  rowIds: string[];
  colIds: string[];
  rowIndex: Map<string, number>;
  colIndex: Map<string, number>;
}

export class SheetsModel {
  readonly doc: Y.Doc;
  readonly engine: Engine;
  readonly undo: Y.UndoManager;
  private readonly sheetsMap: Y.Map<Y.Map<unknown>>;
  private readonly order: Y.Array<string>;
  readonly settings: Y.Map<unknown>;
  private caches = new Map<string, SheetCache>();
  private readonly listeners = new Set<(e: ModelChange) => void>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.sheetsMap = doc.getMap('sheets');
    this.order = doc.getArray('order');
    this.settings = doc.getMap('settings');
    this.engine = new Engine(this.source(), { locale: this.locale() });
    this.undo = new Y.UndoManager([this.sheetsMap, this.order, this.settings], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 400,
    });
    this.sheetsMap.observeDeep(this.onDeep);
    this.order.observe(this.onOrder);
    this.settings.observe(this.onSettings);
  }

  /** Make sure the spreadsheet has a sheet. Safe to call from every browser; see seedUpdate. */
  ensureSeeded() {
    if (this.order.length > 0) return;
    Y.applyUpdate(this.doc, seedUpdate(), LOCAL_SEED);
  }

  destroy() {
    this.sheetsMap.unobserveDeep(this.onDeep);
    this.order.unobserve(this.onOrder);
    this.settings.unobserve(this.onSettings);
    this.undo.destroy();
  }

  subscribe(fn: (e: ModelChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ModelChange) {
    for (const fn of this.listeners) fn(e);
  }

  // ------------------------------------------------------------------
  //  Change tracking → engine invalidation
  // ------------------------------------------------------------------

  private onDeep = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
    let structural = false;
    let layout = false;
    const cells: [string, number, number][] = [];
    for (const ev of events) {
      // path: [sheetId, 'values'] for a cell edit, [sheetId, 'rows'] for a row insert, …
      const path = ev.path as (string | number)[];
      const sheetId = path[0] as string | undefined;
      const field = path[1] as string | undefined;
      if (sheetId === undefined) { structural = true; continue; }
      if (field === 'values') {
        const cache = this.cache(sheetId);
        if (!cache) continue;
        for (const key of (ev as Y.YMapEvent<unknown>).keysChanged) {
          const [rid, cid] = key.split('|') as [string, string];
          const r = cache.rowIndex.get(rid);
          const c = cache.colIndex.get(cid);
          if (r !== undefined && c !== undefined) cells.push([sheetId, r, c]);
        }
      } else if (field === 'colWidths' || field === 'rowHeights' || field === 'merges' || field === 'filter') {
        // 'filter': a column's hidden values changed — which rows show (layout), not any value.
        layout = true;
      } else if (field === 'rows' || field === 'cols' || field === undefined) {
        // A sheet's name, its rows or columns: positions or names moved.
        structural = true;
        this.caches.delete(sheetId);
      }
    }
    if (structural) this.engine.reset();
    else if (cells.length > 0) this.engine.invalidateMany(cells);
    this.engine.tickVolatile();
    this.emit({ structural, layout: layout || structural, remote: tr.origin !== LOCAL && tr.origin !== LOCAL_SEED, local: tr.origin === LOCAL });
  };

  private onOrder = (_e: Y.YArrayEvent<string>, tr: Y.Transaction) => {
    this.engine.reset();
    this.emit({ structural: true, layout: true, remote: tr.origin !== LOCAL, local: tr.origin === LOCAL });
  };

  private onSettings = () => {
    this.engine.locale = this.locale();
    this.engine.reset();
    this.emit({ structural: true, layout: true, remote: false, local: false });
  };

  /**
   * The sheet's map, only if it IS a sheet: a Y.Map whose rows and columns
   * are arrays and whose values, formats, merges and sizes are maps. The
   * Y.Doc is whatever the collaborators' browsers wrote — a hand-made client
   * can write anything (Mr. Singh, 25 Sept 2026) — so every read starts
   * here, and anything else is treated as absent rather than trusted.
   * tests/sheets/malformed.test.ts holds the cases.
   */
  private sheetY(sheetId: string): Y.Map<unknown> | null {
    const y = this.sheetsMap.get(sheetId) as unknown;
    if (!(y instanceof Y.Map)) return null;
    if (!(y.get('rows') instanceof Y.Array) || !(y.get('cols') instanceof Y.Array)) return null;
    for (const k of ['values', 'formats', 'merges', 'colWidths', 'rowHeights']) {
      if (!(y.get(k) instanceof Y.Map)) return null;
    }
    return y as Y.Map<unknown>;
  }

  private cache(sheetId: string): SheetCache | null {
    const hit = this.caches.get(sheetId);
    if (hit) return hit;
    const y = this.sheetY(sheetId);
    if (!y) return null;
    const ids = (field: string) => (y.get(field) as Y.Array<unknown>).toArray().filter((x): x is string => typeof x === 'string');
    const rowIds = ids('rows');
    const colIds = ids('cols');
    const c: SheetCache = {
      y, rowIds, colIds,
      rowIndex: new Map(rowIds.map((id, i) => [id, i])),
      colIndex: new Map(colIds.map((id, i) => [id, i])),
    };
    this.caches.set(sheetId, c);
    return c;
  }

  private sub<T>(sheetId: string, field: string): T {
    return this.sheetsMap.get(sheetId)!.get(field) as T;
  }

  // ------------------------------------------------------------------
  //  Reading
  // ------------------------------------------------------------------

  locale(): Locale {
    const g = this.settings.get('grouping');
    const d = this.settings.get('dateOrder');
    return {
      ...INDIA,
      grouping: g === 'western' ? 'western' : 'indian',
      dateOrder: d === 'mdy' ? 'mdy' : 'dmy',
    };
  }

  sheetIds(): string[] {
    // Only strings, each once, each a real sheet (see sheetY).
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of this.order.toArray() as unknown[]) {
      if (typeof id !== 'string' || seen.has(id) || !this.sheetY(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  sheets(): SheetMeta[] {
    return this.sheetIds().map((id) => this.meta(id)!);
  }

  meta(id: string): SheetMeta | null {
    const y = this.sheetY(id);
    if (!y) return null;
    const name = y.get('name');
    const tab = y.get('tabColor');
    const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : 0);
    return {
      id,
      name: typeof name === 'string' && name.trim() !== '' ? name : 'Sheet',
      tabColor: typeof tab === 'string' && /^#[0-9a-fA-F]{6}$/.test(tab) ? tab : undefined,
      hidden: y.get('hidden') === true,
      frozenRows: count(y.get('frozenRows')),
      frozenCols: count(y.get('frozenCols')),
    };
  }

  size(sheetId: string): { rows: number; cols: number } {
    const c = this.cache(sheetId);
    return c ? { rows: c.rowIds.length, cols: c.colIds.length } : { rows: 0, cols: 0 };
  }

  private key(sheetId: string, r: number, c: number): string | null {
    const cache = this.cache(sheetId);
    const rid = cache?.rowIds[r];
    const cid = cache?.colIds[c];
    return rid && cid ? `${rid}|${cid}` : null;
  }

  /** What the person typed into a cell. */
  input(sheetId: string, r: number, c: number): string | null {
    const k = this.key(sheetId, r, c);
    if (!k) return null;
    const v = this.sub<Y.Map<unknown>>(sheetId, 'values').get(k);
    return typeof v === 'string' ? v : null;
  }

  value(sheetId: string, r: number, c: number): Scalar {
    return this.engine.getValue(sheetId, r, c);
  }

  format(sheetId: string, r: number, c: number): CellFormat | undefined {
    const k = this.key(sheetId, r, c);
    if (!k) return undefined;
    return cleanFormat(this.sub<Y.Map<unknown>>(sheetId, 'formats').get(k));
  }

  colWidth(sheetId: string, c: number): number | undefined {
    const id = this.cache(sheetId)?.colIds[c];
    return id ? pixels(this.sub<Y.Map<unknown>>(sheetId, 'colWidths').get(id)) : undefined;
  }

  rowHeight(sheetId: string, r: number): number | undefined {
    const id = this.cache(sheetId)?.rowIds[r];
    return id ? pixels(this.sub<Y.Map<unknown>>(sheetId, 'rowHeights').get(id)) : undefined;
  }

  /** Every cell with content, as positions. For search, export and AI. */
  *filled(sheetId: string): Generator<[number, number, string]> {
    const cache = this.cache(sheetId);
    if (!cache) return;
    for (const [k, v] of this.sub<Y.Map<unknown>>(sheetId, 'values')) {
      if (typeof v !== 'string') continue;
      const [rid, cid] = k.split('|') as [string, string];
      const r = cache.rowIndex.get(rid);
      const c = cache.colIndex.get(cid);
      if (r !== undefined && c !== undefined) yield [r, c, v];
    }
  }

  /** The last row and column that hold anything, or -1. */
  extent(sheetId: string): { lastRow: number; lastCol: number } {
    let lastRow = -1; let lastCol = -1;
    for (const [r, c] of this.filled(sheetId)) { lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c); }
    return { lastRow, lastCol };
  }

  merges(sheetId: string): MergeRect[] {
    const cache = this.cache(sheetId);
    if (!cache) return [];
    const out: MergeRect[] = [];
    for (const [id, raw] of this.sub<Y.Map<unknown>>(sheetId, 'merges')) {
      const m = raw as { r1?: unknown; c1?: unknown; r2?: unknown; c2?: unknown } | null;
      if (typeof m !== 'object' || m === null) continue;
      if (typeof m.r1 !== 'string' || typeof m.c1 !== 'string' || typeof m.r2 !== 'string' || typeof m.c2 !== 'string') continue;
      const r1 = cache.rowIndex.get(m.r1); const r2 = cache.rowIndex.get(m.r2);
      const c1 = cache.colIndex.get(m.c1); const c2 = cache.colIndex.get(m.c2);
      // A merge whose corner row or column was deleted is gone.
      if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) continue;
      if (r1 > r2 || c1 > c2) continue;
      out.push({ id, r1, c1, r2, c2 });
    }
    return out;
  }

  /** Stable ids for a position, for presence (a colleague's cursor survives a row insert). */
  idsAt(sheetId: string, r: number, c: number): { row: string; col: string } | null {
    const cache = this.cache(sheetId);
    const row = cache?.rowIds[r]; const col = cache?.colIds[c];
    return row && col ? { row, col } : null;
  }

  positionOf(sheetId: string, rowId: string, colId: string): { r: number; c: number } | null {
    const cache = this.cache(sheetId);
    const r = cache?.rowIndex.get(rowId); const c = cache?.colIndex.get(colId);
    return r !== undefined && c !== undefined ? { r, c } : null;
  }

  private source(): WorkbookSource {
    return {
      sheetIdByName: (name) => {
        const l = name.toLowerCase();
        for (const id of this.sheetIds()) if (this.meta(id)!.name.toLowerCase() === l) return id;
        return null;
      },
      sheetName: (id) => this.meta(id)?.name ?? null,
      raw: (sheet, r, c) => this.input(sheet, r, c),
      size: (sheet) => this.size(sheet),
    };
  }

  // ------------------------------------------------------------------
  //  Writing cells
  // ------------------------------------------------------------------

  private write(fn: () => void) {
    this.doc.transact(fn, LOCAL);
  }

  /**
   * Set inputs. An input that implies a format ("₹1,500", "85%", a date)
   * sets that format too, unless the cell already has a number format —
   * which is how typing a date into a date-formatted column behaves.
   */
  setInputs(sheetId: string, entries: { r: number; c: number; input: string | null }[]) {
    const values = this.sub<Y.Map<string>>(sheetId, 'values');
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    const locale = this.locale();
    this.write(() => {
      for (const e of entries) {
        const k = this.key(sheetId, e.r, e.c);
        if (!k) continue;
        if (e.input === null || e.input === '') { values.delete(k); continue; }
        values.set(k, e.input);
        const implied = parseInput(e.input, locale).format;
        if (implied) {
          const f = cleanFormat(formats.get(k));
          if (!f?.nf) formats.set(k, { ...f, nf: implied });
        }
      }
    });
  }

  /** Apply a format change to every cell in a rectangle. undefined in the patch clears that field. */
  setFormat(sheetId: string, rect: Rect, patch: Partial<CellFormat>) {
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    const n = norm(rect);
    this.write(() => {
      for (let r = n.r1; r <= n.r2; r += 1) {
        for (let c = n.c1; c <= n.c2; c += 1) {
          const k = this.key(sheetId, r, c);
          if (!k) continue;
          const next: CellFormat = { ...cleanFormat(formats.get(k)), ...patch };
          for (const f of Object.keys(next) as (keyof CellFormat)[]) if (next[f] === undefined) delete next[f];
          if (Object.keys(next).length === 0) formats.delete(k); else formats.set(k, next);
        }
      }
    });
  }

  /**
   * Borders on a rectangle: 'all', 'outer', 'inner', one side, or 'none'.
   * Each cell keeps its own four sides, as in a .xlsx file.
   */
  setBorders(sheetId: string, rect: Rect, which: BorderPreset, side: CellFormat['bt'] | undefined) {
    const n = norm(rect);
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    this.write(() => {
      for (let r = n.r1; r <= n.r2; r += 1) {
        for (let c = n.c1; c <= n.c2; c += 1) {
          const k = this.key(sheetId, r, c);
          if (!k) continue;
          const f: CellFormat = { ...cleanFormat(formats.get(k)) };
          const top = r === n.r1; const bottom = r === n.r2; const left = c === n.c1; const right = c === n.c2;
          const put = (s: 'bt' | 'bb' | 'bl' | 'br', on: boolean) => { if (on) { if (side) f[s] = side; else delete f[s]; } };
          switch (which) {
            case 'all': case 'none': put('bt', true); put('bb', true); put('bl', true); put('br', true); break;
            case 'outer': put('bt', top); put('bb', bottom); put('bl', left); put('br', right); break;
            case 'inner': put('bt', !top); put('bb', !bottom); put('bl', !left); put('br', !right); break;
            case 'top': put('bt', top); break;
            case 'bottom': put('bb', bottom); break;
            case 'left': put('bl', left); break;
            case 'right': put('br', right); break;
          }
          if (which === 'none') { delete f.bt; delete f.bb; delete f.bl; delete f.br; }
          if (Object.keys(f).length === 0) formats.delete(k); else formats.set(k, f);
        }
      }
    });
  }

  /** Clear contents (and optionally formatting) of a rectangle. */
  clear(sheetId: string, rect: Rect, what: 'values' | 'formats' | 'all' = 'values') {
    const n = norm(rect);
    const values = this.sub<Y.Map<string>>(sheetId, 'values');
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    this.write(() => {
      for (let r = n.r1; r <= n.r2; r += 1) {
        for (let c = n.c1; c <= n.c2; c += 1) {
          const k = this.key(sheetId, r, c);
          if (!k) continue;
          if (what !== 'formats') values.delete(k);
          if (what !== 'values') formats.delete(k);
        }
      }
    });
  }

  // ------------------------------------------------------------------
  //  Copy, paste, fill
  // ------------------------------------------------------------------

  /** A rectangle's inputs and formats, for the clipboard. */
  copy(sheetId: string, rect: Rect): Clip {
    const n = norm(rect);
    const cells: Clip['cells'] = [];
    for (let r = n.r1; r <= n.r2; r += 1) {
      const row: Clip['cells'][number] = [];
      for (let c = n.c1; c <= n.c2; c += 1) row.push({ input: this.input(sheetId, r, c), format: this.format(sheetId, r, c) });
      cells.push(row);
    }
    return { sheetId, origin: { r: n.r1, c: n.c1 }, cells };
  }

  /**
   * Paste a clip with its top-left at (r, c). Formulas move their relative
   * references by the distance pasted. mode 'values' pastes calculated
   * values only; 'formats' only formatting.
   */
  paste(sheetId: string, r: number, c: number, clip: Clip, mode: 'all' | 'values' | 'formats' = 'all',
    valueOf?: (rr: number, cc: number) => Scalar) {
    const values = this.sub<Y.Map<string>>(sheetId, 'values');
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    this.growTo(sheetId, r + clip.cells.length, c + (clip.cells[0]?.length ?? 0));
    const dr = r - clip.origin.r;
    const dc = c - clip.origin.c;
    this.write(() => {
      clip.cells.forEach((row, i) => row.forEach((cell, j) => {
        const k = this.key(sheetId, r + i, c + j);
        if (!k) return;
        if (mode !== 'formats') {
          let input = cell.input;
          if (mode === 'values' && input?.startsWith('=') && valueOf) {
            const v = valueOf(clip.origin.r + i, clip.origin.c + j);
            input = v === null ? null : typeof v === 'object' ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
          } else if (input?.startsWith('=')) {
            input = translateFormula(input, dr, dc);
          }
          if (input === null || input === '') values.delete(k); else values.set(k, input);
        }
        if (mode !== 'values') {
          if (cell.format) formats.set(k, cell.format); else formats.delete(k);
        }
      }));
    });
  }

  /** Paste plain text from another program: tab-separated rows of values. */
  pasteText(sheetId: string, r: number, c: number, rows: string[][]) {
    this.growTo(sheetId, r + rows.length, c + Math.max(0, ...rows.map((x) => x.length)));
    const entries: { r: number; c: number; input: string | null }[] = [];
    rows.forEach((row, i) => row.forEach((v, j) => entries.push({ r: r + i, c: c + j, input: v === '' ? null : v })));
    this.setInputs(sheetId, entries);
  }

  /**
   * Drag-fill from `src` across `dest` (which contains src). Numbers in a
   * single row/column with a steady step continue the series (1, 2 → 3, 4);
   * everything else repeats, formulas moving their references as they go.
   */
  fill(sheetId: string, src: Rect, dest: Rect) {
    const s = norm(src); const d = norm(dest);
    const clip = this.copy(sheetId, s);
    const h = s.r2 - s.r1 + 1; const w = s.c2 - s.c1 + 1;
    const vertical = d.r1 !== s.r1 || d.r2 !== s.r2;
    const values = this.sub<Y.Map<string>>(sheetId, 'values');
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    this.growTo(sheetId, d.r2 + 1, d.c2 + 1);

    const series = (line: (string | null)[]): ((i: number) => string | null) | null => {
      const nums = line.map((x) => (x !== null && !x.startsWith('=') ? Number(x.replace(/,/g, '')) : NaN));
      if (line.length < 2 || nums.some((n) => Number.isNaN(n))) return null;
      const step = nums[1]! - nums[0]!;
      for (let i = 2; i < nums.length; i += 1) if (Math.abs(nums[i]! - nums[i - 1]! - step) > 1e-9) return null;
      return (i) => String(Number((nums[0]! + step * i).toPrecision(15)));
    };

    this.write(() => {
      for (let r = d.r1; r <= d.r2; r += 1) {
        for (let c = d.c1; c <= d.c2; c += 1) {
          if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) continue;
          const i = vertical ? r - s.r1 : c - s.c1;       // offset along the fill
          const srcR = vertical ? s.r1 + (((r - s.r1) % h) + h) % h : r;
          const srcC = vertical ? c : s.c1 + (((c - s.c1) % w) + w) % w;
          const cell = clip.cells[srcR - s.r1]![srcC - s.c1]!;
          const line = vertical
            ? clip.cells.map((row) => row[c - s.c1]!.input)
            : clip.cells[r - s.r1]!.map((x) => x.input);
          const ser = series(line);
          let input = cell.input;
          if (ser) input = ser(i);
          else if (input?.startsWith('=')) input = translateFormula(input, r - srcR, c - srcC);
          const k = this.key(sheetId, r, c);
          if (!k) continue;
          if (input === null) values.delete(k); else values.set(k, input);
          if (cell.format) formats.set(k, cell.format); else formats.delete(k);
        }
      }
    });
  }

  // ------------------------------------------------------------------
  //  Rows and columns
  // ------------------------------------------------------------------

  /** Make sure the sheet has at least this many rows and columns (pasting past the edge). */
  growTo(sheetId: string, rows: number, cols: number) {
    const size = this.size(sheetId);
    if (rows <= size.rows && cols <= size.cols) return;
    this.write(() => {
      if (rows > size.rows) {
        this.sub<Y.Array<string>>(sheetId, 'rows').push(Array.from({ length: rows - size.rows }, newId));
      }
      if (cols > size.cols) {
        this.sub<Y.Array<string>>(sheetId, 'cols').push(Array.from({ length: cols - size.cols }, newId));
      }
    });
  }

  insert(sheetId: string, axis: 'row' | 'col', at: number, count: number) {
    const name = this.meta(sheetId)!.name;
    this.write(() => {
      const arr = this.sub<Y.Array<string>>(sheetId, axis === 'row' ? 'rows' : 'cols');
      arr.insert(at, Array.from({ length: count }, newId));
      this.rewriteAll((input, home) => shiftFormula(input, home, name, axis, at, count));
    });
  }

  remove(sheetId: string, axis: 'row' | 'col', at: number, count: number) {
    const name = this.meta(sheetId)!.name;
    const size = this.size(sheetId);
    const total = axis === 'row' ? size.rows : size.cols;
    // A sheet always keeps one row and one column.
    const n = Math.min(count, total - at, total - 1);
    if (n <= 0) return;
    this.write(() => {
      this.shrinkPlaced(sheetId, axis, at, n);
      this.shrinkFilter(sheetId, axis, at, n);
      const arr = this.sub<Y.Array<string>>(sheetId, axis === 'row' ? 'rows' : 'cols');
      const gone = new Set(arr.slice(at, at + n));
      arr.delete(at, n);
      // Drop the content of the deleted cells so it does not linger invisibly in the file.
      for (const field of ['values', 'formats']) {
        const m = this.sub<Y.Map<unknown>>(sheetId, field);
        for (const k of [...m.keys()]) {
          const [rid, cid] = k.split('|') as [string, string];
          if (gone.has(axis === 'row' ? rid : cid)) m.delete(k);
        }
      }
      const sizes = this.sub<Y.Map<number>>(sheetId, axis === 'row' ? 'rowHeights' : 'colWidths');
      for (const id of gone) sizes.delete(id);
      this.rewriteAll((input, home) => shiftFormula(input, home, name, axis, at, -n));
    });
  }

  setColWidth(sheetId: string, cols: number[], px: number | null) {
    const ids = this.cache(sheetId)!.colIds;
    const m = this.sub<Y.Map<number>>(sheetId, 'colWidths');
    this.write(() => { for (const c of cols) { const id = ids[c]; if (id) { if (px === null) m.delete(id); else m.set(id, Math.max(8, Math.round(px))); } } });
  }

  setRowHeight(sheetId: string, rows: number[], px: number | null) {
    const ids = this.cache(sheetId)!.rowIds;
    const m = this.sub<Y.Map<number>>(sheetId, 'rowHeights');
    this.write(() => { for (const r of rows) { const id = ids[r]; if (id) { if (px === null) m.delete(id); else m.set(id, Math.max(8, Math.round(px))); } } });
  }

  freeze(sheetId: string, rows: number | null, cols: number | null) {
    const y = this.sheetsMap.get(sheetId)!;
    this.write(() => {
      if (rows !== null) y.set('frozenRows', Math.max(0, rows));
      if (cols !== null) y.set('frozenCols', Math.max(0, cols));
    });
  }

  merge(sheetId: string, rect: Rect, how: 'all' | 'horizontal' | 'vertical') {
    const n = norm(rect);
    const cache = this.cache(sheetId)!;
    const m = this.sub<Y.Map<unknown>>(sheetId, 'merges');
    this.write(() => {
      this.unmergeIn(sheetId, n);
      const add = (r1: number, c1: number, r2: number, c2: number) => {
        if (r1 === r2 && c1 === c2) return;
        m.set(newId(), { r1: cache.rowIds[r1], c1: cache.colIds[c1], r2: cache.rowIds[r2], c2: cache.colIds[c2] });
      };
      if (how === 'all') add(n.r1, n.c1, n.r2, n.c2);
      else if (how === 'horizontal') for (let r = n.r1; r <= n.r2; r += 1) add(r, n.c1, r, n.c2);
      else for (let c = n.c1; c <= n.c2; c += 1) add(n.r1, c, n.r2, c);
    });
  }

  unmergeIn(sheetId: string, rect: Rect) {
    const n = norm(rect);
    const m = this.sub<Y.Map<unknown>>(sheetId, 'merges');
    this.write(() => {
      for (const mr of this.merges(sheetId)) {
        const overlaps = mr.r1 <= n.r2 && mr.r2 >= n.r1 && mr.c1 <= n.c2 && mr.c2 >= n.c1;
        if (overlaps) m.delete(mr.id);
      }
    });
  }

  // ------------------------------------------------------------------
  //  Ranges with something attached: colour rules (rules.ts) and dropdowns
  //  (dropdowns.ts). Both are stored the same way — a per-sheet Y.Map of
  //  { r1, c1, r2, c2 (row/col IDS, as merges), …the payload, n (order) } —
  //  and both shrink, rather than vanish, when an edge row is deleted.
  // ------------------------------------------------------------------

  /**
   * A sheet's placed ranges of one kind, in order. The map is OPTIONAL —
   * every sheet made before 9 Oct 2026 has neither — so sheetY does not
   * require it, and a malformed one reads as none. Each payload is cleaned:
   * a hand-made client's junk is dropped, never half-applied.
   */
  private placed<T extends object>(sheetId: string, field: PlacedField, clean: (raw: unknown) => T | undefined): (T & Rect & { id: string })[] {
    const cache = this.cache(sheetId);
    const m = cache?.y.get(field);
    if (!cache || !(m instanceof Y.Map)) return [];
    const out: { item: T & Rect & { id: string }; n: number }[] = [];
    for (const [id, raw] of m as Y.Map<unknown>) {
      const payload = clean(raw);
      if (!payload) continue;
      const p = raw as Record<string, unknown>;
      const at = (v: unknown, index: Map<string, number>) => (typeof v === 'string' ? index.get(v) : undefined);
      const r1 = at(p.r1, cache.rowIndex); const r2 = at(p.r2, cache.rowIndex);
      const c1 = at(p.c1, cache.colIndex); const c2 = at(p.c2, cache.colIndex);
      if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) continue;
      if (r1 > r2 || c1 > c2) continue;
      out.push({ item: { ...payload, id, r1, c1, r2, c2 }, n: typeof p.n === 'number' && Number.isFinite(p.n) ? p.n : 0 });
    }
    return out.sort((x, y) => x.n - y.n || (x.item.id < y.item.id ? -1 : 1)).map((x) => x.item);
  }

  /**
   * The map, made on first use. Two people adding the very first rule (or
   * dropdown) of a sheet in the same instant both make the map, and Yjs
   * keeps one — so one of the two is lost. New sheets get both maps at
   * creation (addSheet), which closes that for them; the seed sheet cannot
   * (seedUpdate must stay byte-identical across every browser version).
   */
  private placedMap(sheetId: string, field: PlacedField): Y.Map<unknown> {
    const y = this.sheetsMap.get(sheetId)!;
    const m = y.get(field);
    if (m instanceof Y.Map) return m as Y.Map<unknown>;
    const fresh = new Y.Map<unknown>();
    y.set(field, fresh);
    return fresh;
  }

  private corners(sheetId: string, rect: Rect) {
    const n = norm(rect);
    const cache = this.cache(sheetId);
    const r1 = cache?.rowIds[n.r1]; const r2 = cache?.rowIds[n.r2];
    const c1 = cache?.colIds[n.c1]; const c2 = cache?.colIds[n.c2];
    return r1 && r2 && c1 && c2 ? { r1, c1, r2, c2 } : null;
  }

  /** The order number after every existing one: a new entry goes last. */
  private nextOrder(sheetId: string, field: PlacedField): number {
    const m = this.sheetsMap.get(sheetId)!.get(field);
    let next = 0;
    if (m instanceof Y.Map) {
      for (const raw of (m as Y.Map<unknown>).values()) {
        const n = (raw as { n?: unknown } | null)?.n;
        if (typeof n === 'number' && Number.isFinite(n)) next = Math.max(next, n + 1);
      }
    }
    return next;
  }

  /**
   * Inside remove(), before the rows or columns go: a rule or dropdown whose
   * first or last row (column) is being deleted shrinks to what remains of
   * its range, and goes only when none of it remains. Without this a rule
   * over A2:A1000 would vanish when row 1000 was deleted — the way a merge
   * does, which is right for a merge and wrong for these.
   */
  private shrinkPlaced(sheetId: string, axis: 'row' | 'col', at: number, n: number) {
    const cache = this.cache(sheetId);
    if (!cache) return;
    const ids = axis === 'row' ? cache.rowIds : cache.colIds;
    const last = at + n - 1;
    for (const field of PLACED_FIELDS) {
      const m = this.sheetsMap.get(sheetId)!.get(field);
      if (!(m instanceof Y.Map)) continue;
      const anyObject = (raw: unknown) => (typeof raw === 'object' && raw !== null ? {} : undefined);
      for (const item of this.placed(sheetId, field, anyObject)) {
        const lo = axis === 'row' ? item.r1 : item.c1;
        const hi = axis === 'row' ? item.r2 : item.c2;
        if (hi < at || lo > last) continue;            // untouched
        if (lo >= at && hi <= last) { m.delete(item.id); continue; } // all of it deleted
        const newLo = lo >= at ? last + 1 : lo;        // first surviving
        const newHi = hi <= last ? at - 1 : hi;        // last surviving
        if (newLo === lo && newHi === hi) continue;    // deleted rows were inside; its corners stay
        const raw = m.get(item.id) as Record<string, unknown>;
        m.set(item.id, axis === 'row'
          ? { ...raw, r1: ids[newLo], r2: ids[newHi] }
          : { ...raw, c1: ids[newLo], c2: ids[newHi] });
      }
    }
  }

  // ---- colour rules (rules.ts) ----

  /** The sheet's colour rules, in the order they apply (first match wins). */
  colourRules(sheetId: string): PlacedRule[] {
    return this.placed(sheetId, 'rules', cleanRule);
  }

  /** Add a rule over a rectangle. It goes last: it applies only where no earlier rule matched. */
  addColourRule(sheetId: string, rect: Rect, rule: ColourRule): string | null {
    const clean = cleanRule(rule);
    const corners = this.corners(sheetId, rect);
    if (!clean || !corners) return null;
    const id = newId();
    const n = this.nextOrder(sheetId, 'rules');
    this.write(() => { this.placedMap(sheetId, 'rules').set(id, { ...clean, ...corners, n }); });
    return id;
  }

  /** Change a rule's range, condition or style. It keeps its place in the list. */
  updateColourRule(sheetId: string, id: string, rect: Rect, rule: ColourRule): boolean {
    const clean = cleanRule(rule);
    const corners = this.corners(sheetId, rect);
    const m = this.sheetsMap.get(sheetId)!.get('rules');
    if (!clean || !corners || !(m instanceof Y.Map) || !m.has(id)) return false;
    const n = (m.get(id) as { n?: unknown } | null)?.n;
    this.write(() => { m.set(id, { ...clean, ...corners, n: typeof n === 'number' ? n : 0 }); });
    return true;
  }

  removeColourRule(sheetId: string, id: string) {
    const m = this.sheetsMap.get(sheetId)!.get('rules');
    if (m instanceof Y.Map) this.write(() => { m.delete(id); });
  }

  // ---- dropdowns (dropdowns.ts) ----

  /** The sheet's dropdowns, oldest first; where two cover a cell the LAST wins (dropdownAt). */
  dropdowns(sheetId: string): PlacedDropdown[] {
    return this.placed(sheetId, 'lists', cleanDropdown);
  }

  dropdownAt(sheetId: string, r: number, c: number): PlacedDropdown | undefined {
    return findDropdown(this.dropdowns(sheetId), r, c);
  }

  /**
   * Put a dropdown on a rectangle. Any dropdown lying wholly inside it is
   * replaced (Sheets does the same); one that only overlaps stays, and this
   * newer one wins where they meet.
   */
  addDropdown(sheetId: string, rect: Rect, dd: Dropdown): string | null {
    const clean = cleanDropdown(dd);
    const corners = this.corners(sheetId, rect);
    if (!clean || !corners) return null;
    const box = norm(rect);
    const id = newId();
    const n = this.nextOrder(sheetId, 'lists');
    this.write(() => {
      const m = this.placedMap(sheetId, 'lists');
      for (const old of this.dropdowns(sheetId)) {
        if (old.r1 >= box.r1 && old.r2 <= box.r2 && old.c1 >= box.c1 && old.c2 <= box.c2) m.delete(old.id);
      }
      m.set(id, { ...clean, ...corners, n });
    });
    return id;
  }

  /** Remove every dropdown that touches the rectangle. Returns how many went. The cells' values stay. */
  removeDropdownsIn(sheetId: string, rect: Rect): number {
    const box = norm(rect);
    const gone = this.dropdowns(sheetId).filter((d) => d.r1 <= box.r2 && d.r2 >= box.r1 && d.c1 <= box.c2 && d.c2 >= box.c1);
    const m = this.sheetsMap.get(sheetId)!.get('lists');
    if (gone.length > 0 && m instanceof Y.Map) this.write(() => { for (const d of gone) m.delete(d.id); });
    return gone.length;
  }

  // ------------------------------------------------------------------
  //  The filter (filter.ts): at most one per sheet, shared.
  //
  //  Stored as a Y.Map under the sheet's 'filter' key:
  //    range   { r1, c1, r2, c2 }  row/col IDS, as merges
  //    <colId> string[]            that column's hidden values
  //  One key per column, so two people filtering different columns at the
  //  same moment both keep their change. OPTIONAL: no key, no filter.
  // ------------------------------------------------------------------

  /** What a cell shows, as text — the value the filter compares (filter.ts). */
  shownText(sheetId: string, r: number, c: number): string {
    return formatValue(this.value(sheetId, r, c), this.format(sheetId, r, c)?.nf, this.locale()).text;
  }

  filter(sheetId: string): PlacedFilter | null {
    const cache = this.cache(sheetId);
    const m = cache?.y.get('filter');
    if (!cache || !(m instanceof Y.Map)) return null;
    const range = m.get('range') as Record<string, unknown> | undefined;
    if (typeof range !== 'object' || range === null) return null;
    const at = (v: unknown, index: Map<string, number>) => (typeof v === 'string' ? index.get(v) : undefined);
    const r1 = at(range.r1, cache.rowIndex); const r2 = at(range.r2, cache.rowIndex);
    const c1 = at(range.c1, cache.colIndex); const c2 = at(range.c2, cache.colIndex);
    if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined || r1 > r2 || c1 > c2) return null;
    const hidden = new Map<number, Set<string>>();
    for (const [key, raw] of m as Y.Map<unknown>) {
      if (key === 'range') continue;
      const c = cache.colIndex.get(key);
      if (c === undefined || c < c1 || c > c2) continue; // a column now outside the range: ignored
      const values = cleanHiddenValues(raw);
      if (values.length > 0) hidden.set(c, new Set(values.map(filterKey)));
    }
    return { r1, c1, r2, c2, hidden };
  }

  /** The filter as plain data for a snapshot: hidden values as stored (original case), by column position. */
  filterData(sheetId: string): FilterData | undefined {
    const f = this.filter(sheetId);
    const m = this.sheetsMap.get(sheetId)!.get('filter');
    const cache = this.cache(sheetId);
    if (!f || !(m instanceof Y.Map) || !cache) return undefined;
    const hidden: Record<number, string[]> = {};
    for (const c of f.hidden.keys()) hidden[c] = cleanHiddenValues(m.get(cache.colIds[c]!));
    return { r1: f.r1, c1: f.c1, r2: f.r2, c2: f.c2, hidden };
  }

  /** Put a whole filter in place — from a file or a duplicated sheet. */
  private placeFilter(sheetId: string, data: FilterData) {
    if (!this.createFilter(sheetId, data)) return;
    for (const [c, values] of Object.entries(data.hidden)) this.setFilterHidden(sheetId, Number(c), values);
  }

  /** The rows the sheet's filter hides now (empty with no filter). */
  filterHiddenRows(sheetId: string): Set<number> {
    const f = this.filter(sheetId);
    return f ? hiddenRows(f, (r, c) => this.shownText(sheetId, r, c)) : new Set();
  }

  /** Put a filter on a range (its first row is the header), replacing any filter the sheet had. */
  createFilter(sheetId: string, rect: Rect): boolean {
    const corners = this.corners(sheetId, rect);
    const n = norm(rect);
    if (!corners || n.r2 <= n.r1) return false; // a header and at least one data row
    this.write(() => {
      const m = new Y.Map<unknown>();
      this.sheetsMap.get(sheetId)!.set('filter', m);
      m.set('range', corners);
    });
    return true;
  }

  removeFilter(sheetId: string) {
    const y = this.sheetsMap.get(sheetId)!;
    if (y.has('filter')) this.write(() => { y.delete('filter'); });
  }

  /** Set the values hidden in one column of the filter; an empty list shows the column's every value. */
  setFilterHidden(sheetId: string, c: number, values: string[]): boolean {
    const m = this.sheetsMap.get(sheetId)!.get('filter');
    const colId = this.cache(sheetId)?.colIds[c];
    const f = this.filter(sheetId);
    if (!(m instanceof Y.Map) || !colId || !f || c < f.c1 || c > f.c2) return false;
    const clean = cleanHiddenValues(values);
    this.write(() => { if (clean.length === 0) m.delete(colId); else m.set(colId, clean); });
    return true;
  }

  /**
   * Inside remove(): the filter's range shrinks like a colour rule's
   * (shrinkPlaced). If its HEADER row goes, the filter goes — the buttons
   * would otherwise move onto a row of data.
   */
  private shrinkFilter(sheetId: string, axis: 'row' | 'col', at: number, n: number) {
    const y = this.sheetsMap.get(sheetId)!;
    const m = y.get('filter');
    const f = this.filter(sheetId);
    const cache = this.cache(sheetId);
    if (!(m instanceof Y.Map) || !f || !cache) return;
    const last = at + n - 1;
    const lo = axis === 'row' ? f.r1 : f.c1;
    const hi = axis === 'row' ? f.r2 : f.c2;
    if (hi < at || lo > last) return;
    if ((axis === 'row' && f.r1 >= at && f.r1 <= last) || (lo >= at && hi <= last)) { y.delete('filter'); return; }
    const newLo = lo >= at ? last + 1 : lo;
    const newHi = hi <= last ? at - 1 : hi;
    if (newLo === lo && newHi === hi) return;
    const ids = axis === 'row' ? cache.rowIds : cache.colIds;
    const range = m.get('range') as Record<string, unknown>;
    m.set('range', axis === 'row'
      ? { ...range, r1: ids[newLo], r2: ids[newHi] }
      : { ...range, c1: ids[newLo], c2: ids[newHi] });
  }

  /**
   * Sort the rows of a rectangle by one or more of its columns. Values are
   * compared as calculated (a formula sorts by its result); empty cells go
   * last either way, as in Sheets. Formulas move with their row.
   */
  sortRange(sheetId: string, rect: Rect, keys: { col: number; desc: boolean }[]) {
    const n = norm(rect);
    const rows: { r: number; cells: { input: string | null; format?: CellFormat }[]; keys: Scalar[] }[] = [];
    for (let r = n.r1; r <= n.r2; r += 1) {
      const cells = [];
      for (let c = n.c1; c <= n.c2; c += 1) cells.push({ input: this.input(sheetId, r, c), format: this.format(sheetId, r, c) });
      rows.push({ r, cells, keys: keys.map((k) => this.value(sheetId, r, k.col)) });
    }
    rows.sort((a, b) => {
      for (let i = 0; i < keys.length; i += 1) {
        const x = a.keys[i]!; const y = b.keys[i]!;
        const ex = x === null || x === ''; const ey = y === null || y === '';
        if (ex !== ey) return ex ? 1 : -1;
        const c = typeof x === 'object' || typeof y === 'object' ? 0 : compare(x, y);
        if (c !== 0) return keys[i]!.desc ? -c : c;
      }
      return a.r - b.r; // stable
    });
    const values = this.sub<Y.Map<string>>(sheetId, 'values');
    const formats = this.sub<Y.Map<CellFormat>>(sheetId, 'formats');
    this.write(() => {
      rows.forEach((row, i) => {
        const r = n.r1 + i;
        row.cells.forEach((cell, j) => {
          const k = this.key(sheetId, r, n.c1 + j);
          if (!k) return;
          const input = cell.input?.startsWith('=') ? translateFormula(cell.input, r - row.r, 0) : cell.input;
          if (input === null) values.delete(k); else values.set(k, input);
          if (cell.format) formats.set(k, cell.format); else formats.delete(k);
        });
      });
    });
  }

  // ------------------------------------------------------------------
  //  Sheets (tabs)
  // ------------------------------------------------------------------

  private uniqueName(base: string): string {
    const taken = new Set(this.sheets().map((s) => s.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i += 1) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  /** A new, empty sheet after `afterId` (or at the end). Returns its id. */
  addSheet(afterId?: string, name?: string, rows = DEFAULT_ROWS, cols = DEFAULT_COLS): string {
    const id = `s${newId()}`;
    let n = this.sheets().length + 1;
    let nm = name ?? `Sheet${n}`;
    while (!name && this.sheets().some((s) => s.name.toLowerCase() === nm.toLowerCase())) { n += 1; nm = `Sheet${n}`; }
    nm = this.uniqueName(nm);
    this.write(() => {
      const s = new Y.Map<unknown>();
      this.sheetsMap.set(id, s);
      s.set('name', nm);
      s.set('frozenRows', 0);
      s.set('frozenCols', 0);
      const ry = new Y.Array<string>(); ry.push(Array.from({ length: rows }, newId));
      const cy = new Y.Array<string>(); cy.push(Array.from({ length: cols }, newId));
      s.set('rows', ry);
      s.set('cols', cy);
      // 'rules' and 'lists' too, so the first two added at once cannot race to create the map (placedMap).
      for (const k of ['values', 'formats', 'colWidths', 'rowHeights', 'merges', ...PLACED_FIELDS]) s.set(k, new Y.Map());
      const at = afterId ? this.order.toArray().indexOf(afterId) + 1 : this.order.length;
      this.order.insert(at > 0 ? at : this.order.length, [id]);
    });
    return id;
  }

  renameSheet(id: string, name: string): string | null {
    // Excel cannot store [ ] : * ? / \ in a sheet name, and a formula in the
    // .xlsx copy may not contain [ ] (safety.ts). Say so while the person is
    // naming the sheet (Mr. Singh, 25 Sept 2026) — never change it silently.
    if (/[[\]:*?/\\]/.test(name)) return 'A sheet name cannot contain [ ] : * ? / or \\ — Excel cannot store them.';
    const clean = name.trim().slice(0, 100);
    if (!clean) return 'A sheet needs a name.';
    const old = this.meta(id)!.name;
    if (clean === old) return null;
    if (this.sheets().some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase())) {
      return `A sheet named "${clean}" already exists.`;
    }
    this.write(() => {
      this.sheetsMap.get(id)!.set('name', clean);
      this.rewriteAll((input) => renameSheetInFormula(input, old, clean));
    });
    return null;
  }

  deleteSheet(id: string): string | null {
    if (this.sheets().filter((s) => !s.hidden).length <= 1 && !this.meta(id)?.hidden) {
      return 'A spreadsheet must keep at least one visible sheet.';
    }
    const name = this.meta(id)!.name;
    this.write(() => {
      const i = this.order.toArray().indexOf(id);
      if (i >= 0) this.order.delete(i, 1);
      this.sheetsMap.delete(id);
      this.rewriteAll((input) => dropSheetInFormula(input, name));
    });
    return null;
  }

  duplicateSheet(id: string): string {
    const src = this.meta(id)!;
    const size = this.size(id);
    const copyId = this.addSheet(id, this.uniqueName(`Copy of ${src.name}`), size.rows, size.cols);
    const merges = this.merges(id);
    this.write(() => {
      const values = this.sub<Y.Map<string>>(copyId, 'values');
      const formats = this.sub<Y.Map<CellFormat>>(copyId, 'formats');
      for (const [r, c, v] of this.filled(id)) {
        const k = this.key(copyId, r, c)!;
        // A formula that named its own sheet keeps naming the original, as in Sheets.
        values.set(k, v);
      }
      const srcCache = this.cache(id)!;
      const fm = this.sub<Y.Map<CellFormat>>(id, 'formats');
      for (const [k, f] of fm) {
        const [rid, cid] = k.split('|') as [string, string];
        const r = srcCache.rowIndex.get(rid); const c = srcCache.colIndex.get(cid);
        const clean = cleanFormat(f);
        if (clean && r !== undefined && c !== undefined) formats.set(this.key(copyId, r, c)!, clean);
      }
      for (let c = 0; c < size.cols; c += 1) { const w = this.colWidth(id, c); if (w) this.setColWidth(copyId, [c], w); }
      for (let r = 0; r < size.rows; r += 1) { const h = this.rowHeight(id, r); if (h) this.setRowHeight(copyId, [r], h); }
      for (const m of merges) this.merge(copyId, m, 'all');
      for (const rule of this.colourRules(id)) this.addColourRule(copyId, rule, rule);
      for (const dd of this.dropdowns(id)) this.addDropdown(copyId, dd, dd);
      const filter = this.filterData(id);
      if (filter) this.placeFilter(copyId, filter);
      this.freeze(copyId, src.frozenRows, src.frozenCols);
      if (src.tabColor) this.sheetsMap.get(copyId)!.set('tabColor', src.tabColor);
    });
    return copyId;
  }

  moveSheet(id: string, delta: number) {
    const arr = this.order.toArray();
    const i = arr.indexOf(id);
    const j = Math.max(0, Math.min(arr.length - 1, i + delta));
    if (i < 0 || i === j) return;
    this.write(() => {
      this.order.delete(i, 1);
      this.order.insert(j, [id]);
    });
  }

  setSheetProp(id: string, prop: 'tabColor' | 'hidden', value: string | boolean | null) {
    this.write(() => {
      const y = this.sheetsMap.get(id)!;
      if (value === null || value === false) y.delete(prop); else y.set(prop, value);
    });
  }

  setLocale(grouping: 'indian' | 'western', dateOrder: 'dmy' | 'mdy') {
    this.write(() => {
      this.settings.set('grouping', grouping);
      this.settings.set('dateOrder', dateOrder);
    });
  }

  /** Rewrite every formula in the workbook (inside the caller's transaction). */
  private rewriteAll(fn: (input: string, homeSheetName: string) => string) {
    for (const id of this.sheetIds()) {
      const home = this.meta(id)!.name;
      const values = this.sub<Y.Map<string>>(id, 'values');
      for (const [k, v] of values) {
        if (!v.startsWith('=')) continue;
        const next = fn(v, home);
        if (next !== v) values.set(k, next);
      }
    }
  }

  // ------------------------------------------------------------------
  //  Snapshots: import and export
  // ------------------------------------------------------------------

  /** The workbook as plain data, with calculated values — for .xlsx, .csv and the Space copy. */
  snapshot(): WorkbookData {
    return {
      sheets: this.sheetIds().map((id) => {
        const meta = this.meta(id)!;
        const size = this.size(id);
        const cells: SheetData['cells'] = new Map();
        for (const [r, c, input] of this.filled(id)) {
          cells.set(cellKey(r, c), { input, value: this.value(id, r, c) });
        }
        const cache = this.cache(id)!;
        for (const [k, f] of this.sub<Y.Map<CellFormat>>(id, 'formats')) {
          const [rid, cid] = k.split('|') as [string, string];
          const r = cache.rowIndex.get(rid); const c = cache.colIndex.get(cid);
          const clean = cleanFormat(f);
          if (!clean || r === undefined || c === undefined) continue;
          const ck = cellKey(r, c);
          const cell = cells.get(ck) ?? { input: null };
          cells.set(ck, { ...cell, format: clean });
        }
        const colWidths: Record<number, number> = {};
        for (let c = 0; c < size.cols; c += 1) { const w = this.colWidth(id, c); if (w) colWidths[c] = w; }
        const rowHeights: Record<number, number> = {};
        for (let r = 0; r < size.rows; r += 1) { const h = this.rowHeight(id, r); if (h) rowHeights[r] = h; }
        const rules = this.colourRules(id).map(({ id: _id, ...rule }) => rule);
        const dropdowns = this.dropdowns(id).map(({ id: _id, ...dd }) => dd);
        const filter = this.filterData(id);
        return {
          name: meta.name, rows: size.rows, cols: size.cols, cells, colWidths, rowHeights,
          merges: this.merges(id).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 })),
          frozenRows: meta.frozenRows, frozenCols: meta.frozenCols,
          tabColor: meta.tabColor, hidden: meta.hidden,
          ...(rules.length > 0 ? { rules } : {}),
          ...(dropdowns.length > 0 ? { dropdowns } : {}),
          ...(filter ? { filter } : {}),
        };
      }),
    };
  }

  /**
   * Bring sheets from a file in. 'replace' swaps the whole workbook (File >
   * Import > Replace spreadsheet); 'append' adds them as new tabs. Returns
   * the id of the first sheet brought in.
   */
  load(data: WorkbookData, mode: 'replace' | 'append'): string | null {
    let first: string | null = null;
    this.write(() => {
      const oldIds = mode === 'replace' ? this.sheetIds() : [];
      const renames: [string, string][] = [];
      for (const s of data.sheets) {
        // Excel makes these characters impossible in a real file's sheet
        // names; a hand-made file may carry them, and they must not reach a
        // formula (safety.ts). Dropped here, where there is no one to ask.
        const want = (typeof s.name === 'string' ? s.name.replace(/[[\]:*?/\\]/g, '').trim().slice(0, 100) : '') || 'Sheet';
        // Names from the file must not collide with sheets we are keeping.
        const nm = mode === 'append' ? this.uniqueName(want) : want;
        // Formulas in the file name the sheet as the FILE did; follow any change.
        if (typeof s.name === 'string' && s.name !== nm) renames.push([s.name, nm]);
        const id = this.addSheet(undefined, `__import_${newId()}`, Math.max(s.rows, 1), Math.max(s.cols, 1));
        this.sheetsMap.get(id)!.set('name', nm);
        first ??= id;
        const values = this.sub<Y.Map<string>>(id, 'values');
        const formats = this.sub<Y.Map<CellFormat>>(id, 'formats');
        for (const [ck, cell] of s.cells) {
          const [r, c] = parseCellKey(ck);
          const k = this.key(id, r, c);
          if (!k) continue;
          if (cell.input !== null && cell.input !== '') values.set(k, cell.input);
          if (cell.format && Object.keys(cell.format).length > 0) formats.set(k, cell.format);
        }
        const cw = this.sub<Y.Map<number>>(id, 'colWidths');
        const cache = this.cache(id)!;
        for (const [c, w] of Object.entries(s.colWidths)) { const cid = cache.colIds[Number(c)]; if (cid) cw.set(cid, w); }
        const rh = this.sub<Y.Map<number>>(id, 'rowHeights');
        for (const [r, h] of Object.entries(s.rowHeights)) { const rid = cache.rowIds[Number(r)]; if (rid) rh.set(rid, h); }
        const mm = this.sub<Y.Map<unknown>>(id, 'merges');
        for (const m of s.merges) {
          const r1 = cache.rowIds[m.r1]; const r2 = cache.rowIds[m.r2]; const c1 = cache.colIds[m.c1]; const c2 = cache.colIds[m.c2];
          if (r1 && r2 && c1 && c2) mm.set(newId(), { r1, c1, r2, c2 });
        }
        // Rules from a file go through addColourRule, so each is cleaned (cleanRule)
        // and placed by id like everything else; their file order is kept.
        for (const rule of s.rules ?? []) this.addColourRule(id, rule, rule);
        for (const dd of s.dropdowns ?? []) this.addDropdown(id, dd, dd);
        if (s.filter) this.placeFilter(id, s.filter);
        const y = this.sheetsMap.get(id)!;
        y.set('frozenRows', s.frozenRows);
        y.set('frozenCols', s.frozenCols);
        if (s.tabColor) y.set('tabColor', s.tabColor);
        if (s.hidden) y.set('hidden', true);
      }
      for (const id of oldIds) {
        const i = this.order.toArray().indexOf(id);
        if (i >= 0) this.order.delete(i, 1);
        this.sheetsMap.delete(id);
      }
      // A file's formulas name its own sheets; follow any we had to rename.
      for (const [from, to] of renames) {
        this.rewriteAll((input) => renameSheetInFormula(input, from, to));
      }
    });
    return first;
  }
}

/** A stored column width or row height, if it is a sensible number of pixels. */
function pixels(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5000 ? v : undefined;
}

/** Seeding is not an edit anyone should be able to undo. */
const LOCAL_SEED = { seed: true };

export type BorderPreset = 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none';

export interface Clip {
  sheetId: string;
  origin: { r: number; c: number };
  cells: { input: string | null; format?: CellFormat }[][];
}

export interface ModelChange {
  /** Rows, columns, sheets or names moved: everything positional must be re-read. */
  structural: boolean;
  /** Sizes or merges changed (or anything structural): geometry must be rebuilt. */
  layout: boolean;
  /** The change came from someone else. */
  remote: boolean;
  /** The change came from this tab (and so is undoable here). */
  local: boolean;
}

/** A sheet name as it would appear in a formula ("'Fee 2026'!"). */
export const sheetPrefix = (name: string) => `${quoteSheet(name)}!`;
