// ============================================================================
//  Lookup and reference: VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, XMATCH,
//  LOOKUP, CHOOSECOLS, CHOOSEROWS, ROW, COLUMN, ADDRESS.
//
//  Ranges are read cell by cell through ctx.cell, not copied whole with
//  ctx.grid: VLOOKUP(x, A:Z, 2) reads column A and one cell of column B,
//  not 26,000 cells. The range itself was recorded when its argument was
//  evaluated, so these reads need no ctx.record() of their own.
//
//  INDEX, and XLOOKUP when it picks a whole row, hand back a reference
//  rather than values, so =SUM(INDEX(A1:C9, 0, 2)) totals column B.
// ============================================================================

import { isError, isRef, type CellError, type EvalResult, type Scalar } from '../types';
import { compare, toText } from '../values';
import { colName, quoteSheet } from '../address';
import { bool, int, text, NA, REF, VALUE } from './helpers';
import type { FnDef, FnContext } from './index';

/** A range or array argument, read lazily. Zero-based within the range. */
interface Table {
  rows: number;
  cols: number;
  at: (i: number, j: number) => Scalar;
  src: EvalResult;
}

function tableOf(v: EvalResult, ctx: FnContext): Table | CellError {
  if (isError(v)) return v;
  if (isRef(v)) {
    return {
      rows: v.r2 - v.r1 + 1, cols: v.c2 - v.c1 + 1, src: v,
      at: (i, j) => ctx.cell(v.sheet, v.r1 + i, v.c1 + j),
    };
  }
  const g = ctx.grid(v);
  return { rows: g.length, cols: g[0]?.length ?? 0, src: v, at: (i, j) => g[i]?.[j] ?? null };
}

/** Part of a table. A reference stays a reference (so SUM can read it); an array stays an array. */
function part(t: Table, r: number, c: number, rows: number, cols: number): EvalResult {
  const s = t.src;
  if (isRef(s)) {
    return { kind: 'ref', sheet: s.sheet, r1: s.r1 + r, c1: s.c1 + c, r2: s.r1 + r + rows - 1, c2: s.c1 + c + cols - 1 };
  }
  if (rows === 1 && cols === 1) return t.at(r, c);
  const out: Scalar[][] = [];
  for (let i = 0; i < rows; i += 1) {
    const row: Scalar[] = [];
    for (let j = 0; j < cols; j += 1) row.push(t.at(r + i, c + j));
    out.push(row);
  }
  return { kind: 'matrix', rows: out };
}

/** A single row or column as a list; null when the table is two-dimensional. */
interface Line { n: number; at: (i: number) => Scalar }
function lineOf(t: Table): Line | null {
  if (t.cols === 1) return { n: t.rows, at: (i) => t.at(i, 0) };
  if (t.rows === 1) return { n: t.cols, at: (j) => t.at(0, j) };
  return null;
}

/** Wildcards: * any run, ? one character, ~ escapes either. Same rules as COUNTIF's (helpers.ts). */
function wildcardRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '~' && (pattern[i + 1] === '*' || pattern[i + 1] === '?' || pattern[i + 1] === '~')) {
      re += `\\${pattern[i + 1]}`;
      i += 1;
    } else if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

/**
 * How to search:
 *   exact         equal value, same type (the number 10 does not find the text "10")
 *   wild          exact, but text keys may use * ? ~
 *   le            sorted ascending: the last value ≤ the key (VLOOKUP TRUE, MATCH 1)
 *   ge            sorted descending: the last value ≥ the key (MATCH -1)
 *   next-smaller  exact, else the largest value below the key, any order (XLOOKUP -1)
 *   next-larger   exact, else the smallest value above the key (XLOOKUP 1)
 */
type Mode = 'exact' | 'wild' | 'le' | 'ge' | 'next-smaller' | 'next-larger';

/** Position of the key in the line, or -1. Empty cells and errors never match. */
function find(key: Scalar, line: Line, mode: Mode, reverse = false): number {
  const k: Scalar = key === null ? '' : key;
  const same = (v: Scalar) => v !== null && !isError(v) && typeof v === typeof k;

  if (mode === 'le' || mode === 'ge') {
    // Sorted data: walk until the first value past the key. Values of another
    // type (a text heading above numbers) are stepped over, as in Sheets.
    let best = -1;
    for (let i = 0; i < line.n; i += 1) {
      const v = line.at(i);
      if (!same(v)) continue;
      const c = compare(v, k);
      if (mode === 'le' ? c <= 0 : c >= 0) best = i; else break;
    }
    return best;
  }

  const re = mode === 'wild' && typeof k === 'string' && /[*?~]/.test(k) ? wildcardRegex(k) : null;
  let near = -1;
  let nearV: Scalar = null;
  for (let s = 0; s < line.n; s += 1) {
    const i = reverse ? line.n - 1 - s : s;
    const v = line.at(i);
    if (re) {
      if (typeof v === 'string' && re.test(v)) return i;
      continue;
    }
    if (!same(v)) continue;
    const c = compare(v, k);
    if (c === 0) return i;
    if (mode === 'next-smaller' && c < 0 && (near < 0 || compare(v, nearV) > 0)) { near = i; nearV = v; }
    if (mode === 'next-larger' && c > 0 && (near < 0 || compare(v, nearV) < 0)) { near = i; nearV = v; }
  }
  return near;
}

function notFound(fn: string, key: Scalar): CellError {
  const t = toText(key);
  return NA(`Did not find value '${isError(t) ? t.code : t}' in ${fn} evaluation.`);
}

/** XLOOKUP / XMATCH match_mode → how to search. */
function xMode(n: number): Mode | null {
  switch (n) {
    case 0: return 'exact';
    case -1: return 'next-smaller';
    case 1: return 'next-larger';
    case 2: return 'wild';
    default: return null;
  }
}

/**
 * XLOOKUP / XMATCH search_mode. 1 first-to-last, -1 last-to-first. 2 and -2
 * promise sorted data so a spreadsheet may binary-search; on sorted data a
 * front-to-back walk finds the same answer, so they are read as 1.
 */
function xReverse(n: number): boolean | null {
  if (n === 1 || n === 2 || n === -2) return false;
  if (n === -1) return true;
  return null;
}

/** VLOOKUP and HLOOKUP differ only in which way the table is turned. */
function vhLookup(name: 'VLOOKUP' | 'HLOOKUP'): FnDef['fn'] {
  return (a, ctx) => {
    const key = ctx.scalar(a.get(0)); if (isError(key)) return key;
    const t = tableOf(a.get(1), ctx); if (isError(t)) return t;
    const idx = int(a.get(2), ctx); if (isError(idx)) return idx;
    // Left out entirely, is_sorted is TRUE; written but empty (…, 2,) it is FALSE.
    const sorted = a.length < 4 ? true : bool(a.get(3), ctx); if (isError(sorted)) return sorted;
    const v = name === 'VLOOKUP';
    if (idx < 1) return VALUE(`Function ${name} parameter 3 value is ${idx}. It should be greater than or equal to 1.`);
    if (idx > (v ? t.cols : t.rows)) return REF(`${name} evaluates to an out of bounds range.`);
    const line: Line = v ? { n: t.rows, at: (i) => t.at(i, 0) } : { n: t.cols, at: (j) => t.at(0, j) };
    const i = find(key, line, sorted ? 'le' : 'wild');
    if (i < 0) return notFound(name, key);
    return v ? t.at(i, idx - 1) : t.at(idx - 1, i);
  };
}

function chooseLines(name: 'CHOOSECOLS' | 'CHOOSEROWS'): FnDef['fn'] {
  return (a, ctx) => {
    const t = tableOf(a.get(0), ctx); if (isError(t)) return t;
    const cols = name === 'CHOOSECOLS';
    const count = cols ? t.cols : t.rows;
    const picks: number[] = [];
    for (let i = 1; i < a.length; i += 1) {
      const n = int(a.get(i), ctx); if (isError(n)) return n;
      if (n === 0 || Math.abs(n) > count) {
        return VALUE(`${name}: ${n} is out of range. The array has ${count} ${cols ? 'columns' : 'rows'}.`);
      }
      // Negative numbers count from the end: -1 is the last.
      picks.push(n > 0 ? n - 1 : count + n);
    }
    const out: Scalar[][] = cols
      ? Array.from({ length: t.rows }, (_, r) => picks.map((c) => t.at(r, c)))
      : picks.map((r) => Array.from({ length: t.cols }, (_, c) => t.at(r, c)));
    if (out.length === 1 && out[0]!.length === 1) return out[0]![0]!;
    return { kind: 'matrix', rows: out };
  };
}

export const LOOKUP: Record<string, FnDef> = {
  VLOOKUP: {
    min: 3, max: 4, category: 'Lookup', sig: 'VLOOKUP(search_key, range, index, [is_sorted])',
    desc: 'Finds a value in the first column of a range and returns the cell in the chosen column of that row.',
    fn: vhLookup('VLOOKUP'),
  },
  HLOOKUP: {
    min: 3, max: 4, category: 'Lookup', sig: 'HLOOKUP(search_key, range, index, [is_sorted])',
    desc: 'Finds a value in the first row of a range and returns the cell in the chosen row of that column.',
    fn: vhLookup('HLOOKUP'),
  },
  XLOOKUP: {
    min: 3, max: 6, category: 'Lookup',
    sig: 'XLOOKUP(search_key, lookup_range, result_range, [missing_value], [match_mode], [search_mode])',
    desc: 'Finds a value in one row or column and returns what sits in the same place in another.',
    fn: (a, ctx) => {
      const key = ctx.scalar(a.get(0)); if (isError(key)) return key;
      const look = tableOf(a.get(1), ctx); if (isError(look)) return look;
      const res = tableOf(a.get(2), ctx); if (isError(res)) return res;
      const mm = a.missing(4) ? 0 : int(a.get(4), ctx); if (isError(mm)) return mm;
      const sm = a.missing(5) ? 1 : int(a.get(5), ctx); if (isError(sm)) return sm;
      const mode = xMode(mm);
      if (mode === null) return VALUE(`XLOOKUP match_mode ${mm} is not one of 0, -1, 1 or 2.`);
      const reverse = xReverse(sm);
      if (reverse === null) return VALUE(`XLOOKUP search_mode ${sm} is not one of 1, -1, 2 or -2.`);
      const line = lineOf(look);
      if (!line) return VALUE('XLOOKUP needs a lookup range that is a single row or a single column.');
      const down = look.cols === 1;
      if ((down ? res.rows : res.cols) !== line.n) {
        return VALUE('XLOOKUP: the lookup range and the result range must be the same length.');
      }
      const i = find(key, line, mode, reverse);
      if (i < 0) return a.missing(3) ? notFound('XLOOKUP', key) : a.get(3);
      if (down) return res.cols === 1 ? res.at(i, 0) : part(res, i, 0, 1, res.cols);
      return res.rows === 1 ? res.at(0, i) : part(res, 0, i, res.rows, 1);
    },
  },
  INDEX: {
    min: 1, max: 3, category: 'Lookup', sig: 'INDEX(reference, [row], [column])',
    desc: 'The cell at a row and column of a range; 0 for either means the whole column or row.',
    fn: (a, ctx) => {
      const t = tableOf(a.get(0), ctx); if (isError(t)) return t;
      let r = a.missing(1) ? 0 : int(a.get(1), ctx); if (isError(r)) return r;
      let c = a.missing(2) ? 0 : int(a.get(2), ctx); if (isError(c)) return c;
      if (r < 0 || c < 0) return VALUE('INDEX: row and column cannot be negative.');
      // One row, one number: the number picks the column (INDEX(A1:E1, 3) is C1).
      if (a.length === 2 && t.rows === 1 && t.cols > 1) { c = r; r = 0; }
      if (r > t.rows) return REF(`INDEX: row ${r} is out of range. The range has ${t.rows} rows.`);
      if (c > t.cols) return REF(`INDEX: column ${c} is out of range. The range has ${t.cols} columns.`);
      return part(t, r === 0 ? 0 : r - 1, c === 0 ? 0 : c - 1, r === 0 ? t.rows : 1, c === 0 ? t.cols : 1);
    },
  },
  MATCH: {
    min: 2, max: 3, category: 'Lookup', sig: 'MATCH(search_key, range, [search_type])',
    desc: 'The position of a value in a row or column: 1 sorted up (default), 0 exact, -1 sorted down.',
    fn: (a, ctx) => {
      const key = ctx.scalar(a.get(0)); if (isError(key)) return key;
      const t = tableOf(a.get(1), ctx); if (isError(t)) return t;
      const type = a.length < 3 ? 1 : int(a.get(2), ctx); if (isError(type)) return type;
      const line = lineOf(t);
      if (!line) return NA('MATCH range must be a single row or a single column.');
      const i = find(key, line, type > 0 ? 'le' : type < 0 ? 'ge' : 'wild');
      return i < 0 ? notFound('MATCH', key) : i + 1;
    },
  },
  XMATCH: {
    min: 2, max: 4, category: 'Lookup', sig: 'XMATCH(search_key, lookup_range, [match_mode], [search_mode])',
    desc: 'The position of a value in a row or column, exact by default.',
    fn: (a, ctx) => {
      const key = ctx.scalar(a.get(0)); if (isError(key)) return key;
      const t = tableOf(a.get(1), ctx); if (isError(t)) return t;
      const mm = a.missing(2) ? 0 : int(a.get(2), ctx); if (isError(mm)) return mm;
      const sm = a.missing(3) ? 1 : int(a.get(3), ctx); if (isError(sm)) return sm;
      const mode = xMode(mm);
      if (mode === null) return VALUE(`XMATCH match_mode ${mm} is not one of 0, -1, 1 or 2.`);
      const reverse = xReverse(sm);
      if (reverse === null) return VALUE(`XMATCH search_mode ${sm} is not one of 1, -1, 2 or -2.`);
      const line = lineOf(t);
      if (!line) return VALUE('XMATCH needs a lookup range that is a single row or a single column.');
      const i = find(key, line, mode, reverse);
      return i < 0 ? notFound('XMATCH', key) : i + 1;
    },
  },
  LOOKUP: {
    min: 2, max: 3, category: 'Lookup', sig: 'LOOKUP(search_key, search_range, [result_range])',
    desc: 'Finds a value in a sorted row or column and returns the matching item from another.',
    fn: (a, ctx) => {
      const key = ctx.scalar(a.get(0)); if (isError(key)) return key;
      const s = tableOf(a.get(1), ctx); if (isError(s)) return s;
      let search: Line;
      let result: Line;
      if (a.length >= 3) {
        const r = tableOf(a.get(2), ctx); if (isError(r)) return r;
        const sl = lineOf(s);
        const rl = lineOf(r);
        if (!sl || !rl) return VALUE('LOOKUP needs ranges that are a single row or a single column.');
        search = sl; result = rl;
      } else if (s.cols > s.rows) {
        // A wide range: search its first row, answer from its last.
        search = { n: s.cols, at: (j) => s.at(0, j) };
        result = { n: s.cols, at: (j) => s.at(s.rows - 1, j) };
      } else {
        search = { n: s.rows, at: (i) => s.at(i, 0) };
        result = { n: s.rows, at: (i) => s.at(i, s.cols - 1) };
      }
      const i = find(key, search, 'le');
      if (i < 0) return notFound('LOOKUP', key);
      return i < result.n ? result.at(i) : NA('LOOKUP: the result range is shorter than the search range.');
    },
  },
  CHOOSECOLS: {
    min: 2, max: Infinity, category: 'Lookup', sig: 'CHOOSECOLS(array, col_num1, [col_num2, …])',
    desc: 'The chosen columns of a range; negative numbers count from the right.',
    fn: chooseLines('CHOOSECOLS'),
  },
  CHOOSEROWS: {
    min: 2, max: Infinity, category: 'Lookup', sig: 'CHOOSEROWS(array, row_num1, [row_num2, …])',
    desc: 'The chosen rows of a range; negative numbers count from the bottom.',
    fn: chooseLines('CHOOSEROWS'),
  },
  ROW: {
    min: 0, max: 1, category: 'Lookup', sig: 'ROW([cell_reference])',
    desc: 'The row number of a cell, or of this cell when none is given.',
    fn: (a, ctx) => {
      if (a.missing(0)) return ctx.row + 1;
      const r = a.get(0);
      if (isError(r)) return r;
      return isRef(r) ? r.r1 + 1 : VALUE('ROW needs a cell reference.');
    },
  },
  COLUMN: {
    min: 0, max: 1, category: 'Lookup', sig: 'COLUMN([cell_reference])',
    desc: 'The column number of a cell (A is 1), or of this cell when none is given.',
    fn: (a, ctx) => {
      if (a.missing(0)) return ctx.col + 1;
      const r = a.get(0);
      if (isError(r)) return r;
      return isRef(r) ? r.c1 + 1 : VALUE('COLUMN needs a cell reference.');
    },
  },
  ADDRESS: {
    min: 2, max: 5, category: 'Lookup',
    sig: 'ADDRESS(row, column, [absolute_relative_mode], [use_a1_notation], [sheet])',
    desc: 'A cell address as text: 1 $A$1, 2 A$1, 3 $A1, 4 A1.',
    fn: (a, ctx) => {
      const r = int(a.get(0), ctx); if (isError(r)) return r;
      const c = int(a.get(1), ctx); if (isError(c)) return c;
      const mode = a.missing(2) ? 1 : int(a.get(2), ctx); if (isError(mode)) return mode;
      const a1 = a.missing(3) ? true : bool(a.get(3), ctx); if (isError(a1)) return a1;
      const sheet = a.missing(4) ? null : text(a.get(4), ctx); if (isError(sheet)) return sheet;
      if (r < 1 || c < 1) return VALUE('ADDRESS: row and column must be 1 or more.');
      if (mode < 1 || mode > 4) return VALUE(`ADDRESS: mode ${mode} is not one of 1, 2, 3 or 4.`);
      const rowAbs = mode === 1 || mode === 2;
      const colAbs = mode === 1 || mode === 3;
      const addr = a1
        ? `${colAbs ? '$' : ''}${colName(c - 1)}${rowAbs ? '$' : ''}${r}`
        : `R${rowAbs ? r : `[${r}]`}C${colAbs ? c : `[${c}]`}`;
      return sheet === null || sheet === '' ? addr : `${quoteSheet(sheet)}!${addr}`;
    },
  },
};
