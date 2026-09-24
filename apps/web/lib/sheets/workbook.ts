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
}

export interface WorkbookData {
  sheets: SheetData[];
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
