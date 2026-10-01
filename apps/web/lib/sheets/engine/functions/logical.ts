// ============================================================================
//  Logic: IF, IFS, AND, OR, IFERROR, SWITCH, CHOOSE.
//  Arguments are evaluated only when reached (see args.ts).
// ============================================================================

import { isError, isMatrix, isRef, type EvalResult } from '../types';
import { compare, toBool } from '../values';
import { bool, int, NA, VALUE } from './helpers';
import type { FnDef, FnContext } from './index';

/** Every boolean in the arguments, AND/OR style: ranges skip text and empties, direct text is an error. */
function booleans(args: { length: number; get(i: number): EvalResult }, ctx: FnContext): boolean[] | EvalResult {
  const out: boolean[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args.get(i);
    if (isRef(a) || isMatrix(a)) {
      for (const row of ctx.grid(a)) for (const v of row) {
        if (isError(v)) return v;
        if (typeof v === 'boolean') out.push(v);
        else if (typeof v === 'number') out.push(v !== 0);
      }
    } else {
      const b = toBool(a as never);
      if (isError(b)) return b;
      out.push(b);
    }
  }
  return out;
}

export const LOGICAL: Record<string, FnDef> = {
  IF: {
    min: 1, max: 3, category: 'Logical', sig: 'IF(condition, value_if_true, [value_if_false])',
    desc: 'One value when the condition is true, another when it is false.',
    fn: (a, ctx) => {
      const c = bool(a.get(0), ctx);
      if (isError(c)) return c;
      if (c) return a.missing(1) ? (a.length >= 2 ? 0 : true) : a.get(1);
      if (a.length < 3) return false;
      return a.missing(2) ? 0 : a.get(2);
    },
  },
  IFS: {
    min: 2, max: Infinity, category: 'Logical', sig: 'IFS(condition1, value1, [condition2, value2, …])',
    desc: 'The value for the first condition that is true.',
    fn: (a, ctx) => {
      if (a.length % 2 !== 0) return NA('IFS needs pairs of conditions and values.');
      for (let i = 0; i < a.length; i += 2) {
        const c = bool(a.get(i), ctx);
        if (isError(c)) return c;
        if (c) return a.get(i + 1);
      }
      return NA('No condition in IFS was true.');
    },
  },
  AND: {
    min: 1, max: Infinity, category: 'Logical', sig: 'AND(condition1, [condition2, …])',
    desc: 'TRUE only when every condition is true.',
    fn: (a, ctx) => {
      const bs = booleans(a, ctx);
      if (!Array.isArray(bs)) return bs;
      if (bs.length === 0) return VALUE('AND has no TRUE/FALSE values to check.');
      return bs.every(Boolean);
    },
  },
  OR: {
    min: 1, max: Infinity, category: 'Logical', sig: 'OR(condition1, [condition2, …])',
    desc: 'TRUE when any condition is true.',
    fn: (a, ctx) => {
      const bs = booleans(a, ctx);
      if (!Array.isArray(bs)) return bs;
      if (bs.length === 0) return VALUE('OR has no TRUE/FALSE values to check.');
      return bs.some(Boolean);
    },
  },
  XOR: {
    min: 1, max: Infinity, category: 'Logical', sig: 'XOR(condition1, [condition2, …])',
    desc: 'TRUE when an odd number of conditions are true.',
    fn: (a, ctx) => {
      const bs = booleans(a, ctx);
      if (!Array.isArray(bs)) return bs;
      if (bs.length === 0) return VALUE();
      return bs.filter(Boolean).length % 2 === 1;
    },
  },
  NOT: {
    min: 1, max: 1, category: 'Logical', sig: 'NOT(condition)', desc: 'The opposite: TRUE becomes FALSE.',
    fn: (a, ctx) => { const b = bool(a.get(0), ctx); return isError(b) ? b : !b; },
  },
  TRUE: { min: 0, max: 0, category: 'Logical', sig: 'TRUE()', desc: 'The value TRUE.', fn: () => true },
  FALSE: { min: 0, max: 0, category: 'Logical', sig: 'FALSE()', desc: 'The value FALSE.', fn: () => false },
  IFERROR: {
    min: 1, max: 2, category: 'Logical', sig: 'IFERROR(value, [value_if_error])',
    desc: 'The value, or a fallback if it is an error.',
    fn: (a, ctx) => {
      const v = a.get(0);
      const s = isRef(v) || isMatrix(v) ? ctx.scalar(v) : v;
      if (isError(s)) return a.missing(1) ? '' : a.get(1);
      return v;
    },
  },
  IFNA: {
    min: 2, max: 2, category: 'Logical', sig: 'IFNA(value, value_if_na)',
    desc: 'The value, or a fallback if it is #N/A.',
    fn: (a, ctx) => {
      const v = a.get(0);
      const s = isRef(v) || isMatrix(v) ? ctx.scalar(v) : v;
      return isError(s) && s.code === '#N/A' ? a.get(1) : v;
    },
  },
  SWITCH: {
    min: 3, max: Infinity, category: 'Logical', sig: 'SWITCH(expression, case1, value1, [case2, value2, …], [default])',
    desc: 'Compares a value against cases and returns the matching result.',
    fn: (a, ctx) => {
      const e = ctx.scalar(a.get(0));
      if (isError(e)) return e;
      const pairs = Math.floor((a.length - 1) / 2);
      for (let i = 0; i < pairs; i += 1) {
        const c = ctx.scalar(a.get(1 + i * 2));
        if (isError(c)) return c;
        if (compare(e, c) === 0 && typeof e === typeof c) return a.get(2 + i * 2);
      }
      return (a.length - 1) % 2 === 1 ? a.get(a.length - 1) : NA('No case in SWITCH matched.');
    },
  },
  CHOOSE: {
    min: 2, max: Infinity, category: 'Logical', sig: 'CHOOSE(index, choice1, [choice2, …])',
    desc: 'The choice at a position: CHOOSE(2, "a", "b") is "b".',
    fn: (a, ctx) => {
      const i = int(a.get(0), ctx);
      if (isError(i)) return i;
      if (i < 1 || i >= a.length) return VALUE(`CHOOSE index ${i} is out of range.`);
      return a.get(i);
    },
  },
};
