// ============================================================================
//  TatvaOS Sheets — the calculation engine's vocabulary
// ============================================================================
//
//  The engine (this folder) is plain TypeScript: no React, no DOM, no Yjs.
//  It reads cell inputs through the WorkbookSource interface below and hands
//  back values, so the same code can run in a browser tab today and in a
//  Node worker later (ERP refresh, AI actions without a tab open). Keep it
//  that way — an import of anything browser-only here breaks that promise.
//
//  Erasable TypeScript only (no enums, no parameter properties): the tests
//  run these files directly under Node's type stripping.
// ============================================================================

export type ErrorCode =
  | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#ERROR!' | '#NULL!';

/** An error value. Errors are values in a spreadsheet: they flow through formulas. */
export class CellError {
  readonly code: ErrorCode;
  readonly message: string;
  constructor(code: ErrorCode, message?: string) {
    this.code = code;
    this.message = message ?? DEFAULT_MESSAGES[code];
  }
  toString(): string { return this.code; }
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  '#DIV/0!': 'Division by zero.',
  '#VALUE!': 'A value in this formula is the wrong type.',
  '#REF!': 'Cell reference is invalid.',
  '#NAME?': 'Unknown function or name.',
  '#N/A': 'Value not available.',
  '#NUM!': 'The number is out of range.',
  '#ERROR!': 'Formula parse error.',
  '#NULL!': 'The ranges do not intersect.',
};

/** What one cell holds once calculated. null is an empty cell. */
export type Scalar = number | string | boolean | CellError | null;

/** A rectangle of values: an array literal, or a function's array result. */
export interface Matrix {
  readonly kind: 'matrix';
  readonly rows: Scalar[][];
}

/**
 * A reference, kept as a reference so functions can tell a range from an
 * array (COUNTA, ROW, INDEX) and read it lazily. Coordinates are zero-based
 * and inclusive; sheet is the sheet's stable id, not its display name.
 */
export interface RefValue {
  readonly kind: 'ref';
  readonly sheet: string;
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export type EvalResult = Scalar | Matrix | RefValue;

export const isMatrix = (v: unknown): v is Matrix =>
  typeof v === 'object' && v !== null && (v as Matrix).kind === 'matrix';
export const isRef = (v: unknown): v is RefValue =>
  typeof v === 'object' && v !== null && (v as RefValue).kind === 'ref';
export const isError = (v: unknown): v is CellError => v instanceof CellError;

/**
 * Where the engine reads the workbook from. The Yjs model implements it in
 * the browser; tests implement it with a plain object.
 */
export interface WorkbookSource {
  /** Stable id of the sheet with this display name (case-insensitive), or null. */
  sheetIdByName(name: string): string | null;
  /** Display name of a sheet id, for messages and formula text. */
  sheetName(id: string): string | null;
  /** The raw input of a cell as typed ("=SUM(A1:A3)", "15000", "Paid"), or null when empty. */
  raw(sheet: string, row: number, col: number): string | null;
  /** How many rows and columns the sheet has. References past these are empty, not errors. */
  size(sheet: string): { rows: number; cols: number };
  /** Named range → a reference, or null. Optional: slice 1 has none. */
  namedRange?(name: string): RefValue | null;
}

/** Workbook-wide settings that change how input is read and numbers are shown. */
export interface Locale {
  /** 'en-IN' groups 1,25,000; 'en-US' groups 125,000. */
  grouping: 'indian' | 'western';
  /** Date order when reading typed dates: 'dmy' (24/09/2026) or 'mdy'. */
  dateOrder: 'dmy' | 'mdy';
  currency: string;
}

export const INDIA: Locale = { grouping: 'indian', dateOrder: 'dmy', currency: '₹' };
