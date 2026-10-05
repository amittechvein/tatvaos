// ============================================================================
//  Counting and totalling by condition: COUNT, COUNTA, COUNTIF(S),
//  SUMIF(S), AVERAGEIF(S), MAXIFS, MINIFS.
// ============================================================================

import { isError, isMatrix, isRef, type CellError, type EvalResult, type Scalar } from '../types';
import { tidy } from '../values';
import { criterion, DIV0, VALUE, type Criterion } from './helpers';
import type { FnDef, FnContext } from './index';

interface Pairs { grids: Scalar[][][]; tests: Criterion[] }

/** Grids of the (range, criterion) pairs, all the same shape as the first range. */
function pairs(args: EvalResult[], start: number, ctx: FnContext):
  Pairs | CellError {
  const grids: Scalar[][][] = [];
  const tests: Criterion[] = [];
  for (let i = start; i + 1 < args.length; i += 2) {
    grids.push(ctx.grid(args[i]!));
    const c = ctx.scalar(args[i + 1]!);
    tests.push(criterion(c, ctx));
  }
  const r = grids[0]?.length ?? 0;
  const c = grids[0]?.[0]?.length ?? 0;
  if (grids.some((g) => g.length !== r || (g[0]?.length ?? 0) !== c)) {
    return VALUE('Every range in this function must be the same size.');
  }
  return { grids, tests };
}

function matches(p: Pairs, i: number, j: number): boolean {
  return p.tests.every((t, k) => t(p.grids[k]![i]![j]!));
}

/**
 * The cells to total, the same shape as the criteria range. A shorter or
 * missing sum range is extended from its top-left corner, as SUMIF does.
 */
function sumGrid(v: EvalResult | undefined, like: Scalar[][], ctx: FnContext): Scalar[][] {
  if (v === undefined) return like;
  if (isRef(v)) {
    const rows = like.length;
    const cols = like[0]?.length ?? 0;
    const out: Scalar[][] = [];
    for (let i = 0; i < rows; i += 1) {
      const row: Scalar[] = [];
      for (let j = 0; j < cols; j += 1) row.push(ctx.cell(v.sheet, v.r1 + i, v.c1 + j));
      out.push(row);
    }
    if (rows > 0) ctx.record({ kind: 'ref', sheet: v.sheet, r1: v.r1, c1: v.c1, r2: v.r1 + rows - 1, c2: v.c1 + cols - 1 });
    return out;
  }
  return ctx.grid(v);
}

function collect(values: Scalar[][], p: Pairs): number[] | EvalResult {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = 0; j < (values[i]?.length ?? 0); j += 1) {
      if (!matches(p, i, j)) continue;
      const v = values[i]![j]!;
      if (isError(v)) return v;
      if (typeof v === 'number') out.push(v);
    }
  }
  return out;
}

export const CONDITIONAL: Record<string, FnDef> = {
  COUNT: {
    min: 1, max: Infinity, category: 'Statistical', sig: 'COUNT(value1, [value2, …])',
    desc: 'How many numbers there are.',
    fn: (a, ctx) => {
      let n = 0;
      for (const x of a.all()) {
        if (isRef(x) || isMatrix(x)) { for (const row of ctx.grid(x)) for (const v of row) if (typeof v === 'number') n += 1; }
        else if (typeof x === 'number') n += 1;
        else if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) n += 1;
      }
      return n;
    },
  },
  COUNTA: {
    min: 1, max: Infinity, category: 'Statistical', sig: 'COUNTA(value1, [value2, …])',
    desc: 'How many cells are not empty.',
    fn: (a, ctx) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 1) {
        if (a.missing(i)) continue;
        const x = a.get(i);
        if (isRef(x) || isMatrix(x)) { for (const row of ctx.grid(x)) for (const v of row) if (v !== null) n += 1; }
        else n += 1;
      }
      return n;
    },
  },
  COUNTBLANK: {
    min: 1, max: 1, category: 'Statistical', sig: 'COUNTBLANK(range)',
    desc: 'How many cells are empty (or hold empty text).',
    fn: (a, ctx) => {
      let n = 0;
      for (const row of ctx.grid(a.get(0))) for (const v of row) if (v === null || v === '') n += 1;
      return n;
    },
  },
  COUNTIF: {
    min: 2, max: 2, category: 'Statistical', sig: 'COUNTIF(range, criterion)',
    desc: 'How many cells meet a condition, such as ">10" or "Paid".',
    fn: (a, ctx) => {
      const p = pairs(a.all(), 0, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      let n = 0;
      q.grids[0]!.forEach((row, i) => row.forEach((_, j) => { if (matches(q, i, j)) n += 1; }));
      return n;
    },
  },
  COUNTIFS: {
    min: 2, max: Infinity, category: 'Statistical', sig: 'COUNTIFS(range1, criterion1, [range2, criterion2, …])',
    desc: 'How many rows meet every condition.',
    fn: (a, ctx) => {
      if (a.length % 2 !== 0) return VALUE('COUNTIFS needs pairs of ranges and conditions.');
      const p = pairs(a.all(), 0, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      let n = 0;
      q.grids[0]!.forEach((row, i) => row.forEach((_, j) => { if (matches(q, i, j)) n += 1; }));
      return n;
    },
  },
  SUMIF: {
    min: 2, max: 3, category: 'Math', sig: 'SUMIF(range, criterion, [sum_range])',
    desc: 'Adds the cells that meet a condition.',
    fn: (a, ctx) => {
      const p = pairs([a.get(0), a.get(1)], 0, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      const vals = collect(sumGrid(a.missing(2) ? undefined : a.get(2), q.grids[0]!, ctx), q);
      return Array.isArray(vals) ? tidy(vals.reduce((x, y) => x + y, 0)) : vals;
    },
  },
  SUMIFS: {
    min: 3, max: Infinity, category: 'Math', sig: 'SUMIFS(sum_range, range1, criterion1, [range2, criterion2, …])',
    desc: 'Adds the cells whose rows meet every condition.',
    fn: (a, ctx) => {
      if ((a.length - 1) % 2 !== 0) return VALUE('SUMIFS needs pairs of ranges and conditions.');
      const all = a.all();
      const p = pairs(all, 1, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      const sg = ctx.grid(all[0]!);
      if (sg.length !== q.grids[0]!.length || (sg[0]?.length ?? 0) !== (q.grids[0]![0]?.length ?? 0)) {
        return VALUE('SUMIFS: the sum range must be the same size as the condition ranges.');
      }
      const vals = collect(sg, q);
      return Array.isArray(vals) ? tidy(vals.reduce((x, y) => x + y, 0)) : vals;
    },
  },
  AVERAGEIF: {
    min: 2, max: 3, category: 'Statistical', sig: 'AVERAGEIF(range, criterion, [average_range])',
    desc: 'The average of the cells that meet a condition.',
    fn: (a, ctx) => {
      const p = pairs([a.get(0), a.get(1)], 0, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      const vals = collect(sumGrid(a.missing(2) ? undefined : a.get(2), q.grids[0]!, ctx), q);
      if (!Array.isArray(vals)) return vals;
      return vals.length === 0 ? DIV0('No cells met the condition.') : tidy(vals.reduce((x, y) => x + y, 0) / vals.length);
    },
  },
  AVERAGEIFS: {
    min: 3, max: Infinity, category: 'Statistical', sig: 'AVERAGEIFS(average_range, range1, criterion1, […])',
    desc: 'The average of the cells whose rows meet every condition.',
    fn: (a, ctx) => {
      if ((a.length - 1) % 2 !== 0) return VALUE('AVERAGEIFS needs pairs of ranges and conditions.');
      const all = a.all();
      const p = pairs(all, 1, ctx);
      if (isError(p)) return p;
      const q = p as Pairs;
      const vals = collect(ctx.grid(all[0]!), q);
      if (!Array.isArray(vals)) return vals;
      return vals.length === 0 ? DIV0('No cells met the conditions.') : tidy(vals.reduce((x, y) => x + y, 0) / vals.length);
    },
  },
  MAXIFS: {
    min: 3, max: Infinity, category: 'Statistical', sig: 'MAXIFS(range, range1, criterion1, […])',
    desc: 'The largest value whose row meets every condition.',
    fn: (a, ctx) => {
      const all = a.all();
      const p = pairs(all, 1, ctx);
      if (isError(p)) return p;
      const vals = collect(ctx.grid(all[0]!), p as Pairs);
      if (!Array.isArray(vals)) return vals;
      return vals.length === 0 ? 0 : Math.max(...vals);
    },
  },
  MINIFS: {
    min: 3, max: Infinity, category: 'Statistical', sig: 'MINIFS(range, range1, criterion1, […])',
    desc: 'The smallest value whose row meets every condition.',
    fn: (a, ctx) => {
      const all = a.all();
      const p = pairs(all, 1, ctx);
      if (isError(p)) return p;
      const vals = collect(ctx.grid(all[0]!), p as Pairs);
      if (!Array.isArray(vals)) return vals;
      return vals.length === 0 ? 0 : Math.min(...vals);
    },
  },
};
