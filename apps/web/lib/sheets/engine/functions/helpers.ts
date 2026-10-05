// ============================================================================
//  What functions share: reading arguments by the spreadsheet's rules.
//
//  THE RULE THAT CATCHES PEOPLE OUT. Aggregates treat a value differently
//  depending on where it came from:
//
//    =SUM(A1:A3)     text and TRUE/FALSE INSIDE the range are skipped
//    =SUM("3", TRUE) typed directly as arguments, they are converted: 4
//
//  numbersOf() implements exactly that, for SUM, AVERAGE, MIN, MAX, PRODUCT,
//  the statistics and the rest. Errors always win — the first one found is
//  the result — so a #REF! in a column never turns into a plausible total.
// ============================================================================

import { isError, isMatrix, isRef, CellError, type EvalResult, type Scalar } from '../types';
import { toNumber, toText, toBool } from '../values';
import type { FnContext } from './index';

/** Numbers from arguments, by the aggregate rule above. Returns the first error instead, if any. */
export function numbersOf(args: EvalResult[], ctx: FnContext): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (isRef(a) || isMatrix(a)) {
      for (const row of ctx.grid(a)) {
        for (const v of row) {
          if (isError(v)) return v;
          if (typeof v === 'number') out.push(v);
        }
      }
    } else {
      if (a === null) continue; // a missing argument
      const n = toNumber(a, ctx.locale);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Every value from the arguments, flattened row by row. Errors are included, not raised. */
export function flatten(args: EvalResult[], ctx: FnContext): Scalar[] {
  const out: Scalar[] = [];
  for (const a of args) {
    if (isRef(a) || isMatrix(a)) for (const row of ctx.grid(a)) for (const v of row) out.push(v);
    else out.push(a);
  }
  return out;
}

/** One argument as a number. */
export function num(v: EvalResult, ctx: FnContext): number | CellError {
  return toNumber(ctx.scalar(v), ctx.locale);
}

/** One argument as a whole number (truncated, as spreadsheets do). */
export function int(v: EvalResult, ctx: FnContext): number | CellError {
  const n = num(v, ctx);
  return isError(n) ? n : Math.trunc(n);
}

export function text(v: EvalResult, ctx: FnContext): string | CellError {
  return toText(ctx.scalar(v));
}

export function bool(v: EvalResult, ctx: FnContext): boolean | CellError {
  return toBool(ctx.scalar(v));
}

/** The dimensions of a range or array argument. */
export function dims(v: EvalResult): { rows: number; cols: number } {
  if (isRef(v)) return { rows: v.r2 - v.r1 + 1, cols: v.c2 - v.c1 + 1 };
  if (isMatrix(v)) return { rows: v.rows.length, cols: v.rows[0]?.length ?? 0 };
  return { rows: 1, cols: 1 };
}

export const NA = (msg?: string) => new CellError('#N/A', msg);
export const VALUE = (msg?: string) => new CellError('#VALUE!', msg);
export const NUM = (msg?: string) => new CellError('#NUM!', msg);
export const DIV0 = (msg?: string) => new CellError('#DIV/0!', msg);
export const REF = (msg?: string) => new CellError('#REF!', msg);

// ---------------------------------------------------------------------------
//  Criteria: COUNTIF(B:B, ">10"), SUMIF(C:C, "Paid", D:D), "<>", "Ra*", …
// ---------------------------------------------------------------------------

export type Criterion = (v: Scalar) => boolean;

/** Wildcards: * any run, ? one character, ~ escapes either. Case-insensitive, whole value. */
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
 * Build a test from a criterion. A number or boolean matches equal values;
 * text may start with = <> < > <= >=, and its remainder is compared as a
 * number when it reads as one, else as text (with wildcards for = and <>).
 */
export function criterion(c: Scalar, ctx: FnContext): Criterion {
  if (isError(c)) return (v) => isError(v) && v.code === c.code;
  if (c === null) return (v) => v === null || v === '';
  if (typeof c === 'number') return (v) => typeof v === 'number' ? v === c : typeof v === 'string' && Number(v.trim()) === c && v.trim() !== '';
  if (typeof c === 'boolean') return (v) => v === c;

  const m = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(c)!;
  const op = m[1] ?? '=';
  const rest = m[2]!;
  const asNum = rest.trim() === '' ? null : toNumber(rest, ctx.locale);
  const isNum = asNum !== null && !isError(asNum);

  if (op === '=' || op === '<>') {
    let test: Criterion;
    if (rest === '') test = (v) => v === null || v === '';
    else if (isNum) test = (v) => typeof v === 'number' && v === asNum;
    else if (/^(true|false)$/i.test(rest)) {
      const b = rest.toLowerCase() === 'true';
      test = (v) => v === b;
    } else {
      const re = wildcardRegex(rest);
      test = (v) => typeof v === 'string' && re.test(v);
    }
    // "<>x" matches everything that is not x — empty cells included, as in Sheets.
    return op === '=' ? test : (v) => !test(v);
  }

  if (isNum) {
    const n = asNum as number;
    return (v) => {
      if (typeof v !== 'number') return false;
      switch (op) {
        case '<': return v < n;
        case '>': return v > n;
        case '<=': return v <= n;
        default: return v >= n;
      }
    };
  }
  const t = rest.toLowerCase();
  return (v) => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    switch (op) {
      case '<': return s < t;
      case '>': return s > t;
      case '<=': return s <= t;
      default: return s >= t;
    }
  };
}

/** Values of a range argument as one flat list, with the range's shape. */
export function rangeValues(v: EvalResult, ctx: FnContext): { values: Scalar[]; rows: number; cols: number } {
  const g = ctx.grid(v);
  return { values: g.flat(), rows: g.length, cols: g[0]?.length ?? 0 };
}
