// ============================================================================
//  A workbook as plain data — the shape files are read into and written from.
//
//  The live spreadsheet is a Yjs document (lib/sheets/model.ts). Import and
//  export (.xlsx, .csv) never touch Yjs: they convert between a file and
//  this snapshot, and the model converts between this snapshot and Yjs. So
//  a file format can be added or fixed without knowing anything about
//  collaboration, and the other way round.
// ============================================================================

import type { Rect } from './engine/address';
import type { Scalar } from './engine/types';
import type { ColourRule } from './rules';

export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
export interface BorderSide { style: BorderStyle; color: string }

/** A cell's formatting. Every field is optional; absent means the default. */
export interface CellFormat {
  b?: boolean;          // bold
  i?: boolean;          // italic
  u?: boolean;          // underline
  s?: boolean;          // strikethrough
  font?: string;        // family name, e.g. "Arial"
  size?: number;        // points
  color?: string;       // text colour, #rrggbb
  bg?: string;          // fill colour, #rrggbb
  ha?: 'left' | 'center' | 'right';
  va?: 'top' | 'middle' | 'bottom';
  wrap?: 'overflow' | 'wrap' | 'clip';
  nf?: string;          // number format code, Excel syntax ("#,##0.00", "dd/mm/yyyy")
  bt?: BorderSide;      // borders: top, bottom, left, right
  bb?: BorderSide;
  bl?: BorderSide;
  br?: BorderSide;
}

export interface CellData {
  /** Exactly as typed: "15000", "Paid", "=SUM(C2:C20)". null for a cell that only has formatting. */
  input: string | null;
  /** The calculated value, when known. Export writes it as the cached value beside a formula. */
  value?: Scalar;
  format?: CellFormat;
}

export interface SheetData {
  name: string;
  rows: number;
  cols: number;
  /** Keyed "row,col", zero-based. Only cells with content or formatting appear. */
  cells: Map<string, CellData>;
  /** Pixel widths/heights for columns/rows that differ from the default. */
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  merges: Rect[];
  frozenRows: number;
  frozenCols: number;
  tabColor?: string;
  hidden?: boolean;
  /** Colour rules (conditional formatting), first match wins. Absent = none. See rules.ts. */
  rules?: (Rect & ColourRule)[];
}

export interface WorkbookData {
  sheets: SheetData[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const BORDER_STYLES: BorderStyle[] = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];

/**
 * A format rebuilt from known fields with the right types, or undefined.
 * Whatever a hand-made client stored in a cell's format — a string, an
 * object with extra keys, a colour that is not a colour — only this comes
 * out, so no part of the app (grid, print, .xlsx) meets anything else.
 */
export function cleanFormat(raw: unknown): CellFormat | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const f: CellFormat = {};
  for (const k of ['b', 'i', 'u', 's'] as const) if (r[k] === true) f[k] = true;
  if (typeof r.font === 'string' && r.font.length <= 100) f.font = r.font;
  if (typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 1 && r.size <= 400) f.size = r.size;
  if (typeof r.color === 'string' && HEX.test(r.color)) f.color = r.color;
  if (typeof r.bg === 'string' && HEX.test(r.bg)) f.bg = r.bg;
  if (r.ha === 'left' || r.ha === 'center' || r.ha === 'right') f.ha = r.ha;
  if (r.va === 'top' || r.va === 'middle' || r.va === 'bottom') f.va = r.va;
  if (r.wrap === 'overflow' || r.wrap === 'wrap' || r.wrap === 'clip') f.wrap = r.wrap;
  if (typeof r.nf === 'string' && r.nf.length <= 200) f.nf = r.nf;
  for (const k of ['bt', 'bb', 'bl', 'br'] as const) {
    const b = r[k] as { style?: unknown; color?: unknown } | undefined;
    if (b && typeof b === 'object' && BORDER_STYLES.includes(b.style as BorderStyle)) {
      f[k] = { style: b.style as BorderStyle, color: typeof b.color === 'string' && HEX.test(b.color) ? b.color : '#000000' };
    }
  }
  return Object.keys(f).length > 0 ? f : undefined;
}

export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 21;
export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;

export const cellKey = (r: number, c: number) => `${r},${c}`;
export function parseCellKey(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

export function emptySheet(name: string): SheetData {
  return {
    name, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: new Map(),
    colWidths: {}, rowHeights: {}, merges: [], frozenRows: 0, frozenCols: 0,
  };
}
