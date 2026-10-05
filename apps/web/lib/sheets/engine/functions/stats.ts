// ============================================================================
//  Statistics: MEDIAN, MODE, STDEV, VAR, RANK, PERCENTILE, QUARTILE, LARGE,
//  SMALL, the …A family, and the straight-line fit (CORREL, SLOPE,
//  INTERCEPT, FORECAST).
//
//  The dotted names Sheets also accepts (STDEV.S, RANK.EQ, …) are entries
//  of their own pointing at the same definition, so the formula bar
//  suggests both spellings.
// ============================================================================

import { isError, isMatrix, isRef, type CellError, type EvalResult } from '../types';
import { tidy, toNumber } from '../values';
import { numbersOf, num, int, bool, DIV0, NA, NUM } from './helpers';
import type { FnDef, FnContext } from './index';

const sum = (ns: number[]) => ns.reduce((x, y) => x + y, 0);
const up = (ns: number[]) => [...ns].sort((x, y) => x - y);

function agg(fn: (ns: number[]) => EvalResult) {
  return (args: { all(): EvalResult[] }, ctx: FnContext): EvalResult => {
    const ns = numbersOf(args.all(), ctx);
    return isError(ns) ? ns : fn(ns);
  };
}

/** Variance; the sample form divides by n - 1, so it needs at least two numbers. */
function variance(ns: number[], sample: boolean, name: string): number | CellError {
  const d = sample ? ns.length - 1 : ns.length;
  if (d <= 0) return DIV0(`${name} needs at least ${sample ? 'two numbers' : 'one number'}.`);
  const m = sum(ns) / ns.length;
  return ns.reduce((s, x) => s + (x - m) ** 2, 0) / d;
}

/**
 * Numbers for AVERAGEA, MAXA and MINA. Unlike numbersOf, text inside a range
 * counts as 0 and TRUE/FALSE as 1/0; empty cells are still skipped.
 */
function numbersA(args: EvalResult[], ctx: FnContext): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (isRef(a) || isMatrix(a)) {
      for (const row of ctx.grid(a)) {
        for (const v of row) {
          if (isError(v)) return v;
          if (typeof v === 'number') out.push(v);
          else if (typeof v === 'boolean') out.push(v ? 1 : 0);
          else if (typeof v === 'string') out.push(0);
        }
      }
    } else {
      if (a === null) continue;
      const n = toNumber(a, ctx.locale);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** The inclusive percentile: rank k·(n-1), interpolated between neighbours. */
function percentile(sorted: number[], k: number): number {
  const h = (sorted.length - 1) * k;
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return tidy(a + (b - a) * (h - lo));
}

/** Paired numbers from two same-sized ranges; a pair counts only when both sides are numbers. */
function paired(ys: EvalResult, xs: EvalResult, name: string, ctx: FnContext):
  { x: number[]; y: number[] } | CellError {
  const gy = ctx.grid(ys);
  const gx = ctx.grid(xs);
  const fy = gy.flat();
  const fx = gx.flat();
  if (fy.length !== fx.length) {
    return NA(`${name} has mismatched range sizes. Expected ${gy.length} rows by ${gy[0]?.length ?? 0} columns, but got ${gx.length} by ${gx[0]?.length ?? 0}.`);
  }
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < fy.length; i += 1) {
    const vy = fy[i]!;
    const vx = fx[i]!;
    if (isError(vy)) return vy;
    if (isError(vx)) return vx;
    if (typeof vy === 'number' && typeof vx === 'number') { y.push(vy); x.push(vx); }
  }
  return { x, y };
}

interface Fit { n: number; mx: number; my: number; sxx: number; syy: number; sxy: number }

function fit(p: { x: number[]; y: number[] }): Fit {
  const n = p.x.length;
  const mx = n ? sum(p.x) / n : 0;
  const my = n ? sum(p.y) / n : 0;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = p.x[i]! - mx;
    const dy = p.y[i]! - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return { n, mx, my, sxx, syy, sxy };
}

/** The slope of the best straight line, or #DIV/0! when the x values do not vary. */
function slopeOf(f: Fit, name: string): number | CellError {
  if (f.n === 0 || tidy(f.sxx) === 0) return DIV0(`${name}: the x values must not all be the same.`);
  return f.sxy / f.sxx;
}

/** k-th largest or smallest. */
function kth(largest: boolean): FnDef['fn'] {
  return (a, ctx) => {
    const ns = numbersOf([a.get(0)], ctx); if (isError(ns)) return ns;
    const k = int(a.get(1), ctx); if (isError(k)) return k;
    const name = largest ? 'LARGE' : 'SMALL';
    if (k < 1 || k > ns.length) {
      return NUM(`${name}: position ${k} is out of range. There are ${ns.length} numbers.`);
    }
    const s = up(ns);
    return largest ? s[s.length - k]! : s[k - 1]!;
  };
}

/** RANK and RANK.AVG: where the value falls in the data, 1 for the largest unless ascending. */
function rank(average: boolean): FnDef['fn'] {
  return (a, ctx) => {
    const v = num(a.get(0), ctx); if (isError(v)) return v;
    const ns = numbersOf([a.get(1)], ctx); if (isError(ns)) return ns;
    const asc = a.length < 3 ? false : bool(a.get(2), ctx); if (isError(asc)) return asc;
    const t = tidy(v);
    let before = 0;
    let ties = 0;
    for (const n of ns) {
      const x = tidy(n);
      if (x === t) ties += 1;
      else if (asc ? x < t : x > t) before += 1;
    }
    if (ties === 0) return NA(`RANK: the value ${v} does not appear in the data.`);
    // Ties share the first position (RANK) or the average of the positions they fill (RANK.AVG).
    return average ? before + (ties + 1) / 2 : before + 1;
  };
}

const MEDIAN: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'MEDIAN(value1, [value2, …])',
  desc: 'The middle number; the mean of the two middle numbers when there is an even count.',
  fn: agg((ns) => {
    if (ns.length === 0) return NUM('MEDIAN has no numbers to work with.');
    const s = up(ns);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : tidy((s[m - 1]! + s[m]!) / 2);
  }),
};

const MODE: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'MODE(value1, [value2, …])',
  desc: 'The number that appears most often; the first such number when several tie.',
  fn: agg((ns) => {
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestCount = 1;
    for (const n of ns) {
      const c = (counts.get(n) ?? 0) + 1;
      counts.set(n, c);
    }
    // Walk in the data's own order so a tie goes to the number seen first.
    for (const n of ns) {
      const c = counts.get(n)!;
      if (c > bestCount) { best = n; bestCount = c; }
    }
    return best === null ? NA('No number appears more than once, so there is no mode.') : best;
  }),
};

const STDEV: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'STDEV(value1, [value2, …])',
  desc: 'The standard deviation of a sample.',
  fn: agg((ns) => { const v = variance(ns, true, 'STDEV'); return isError(v) ? v : tidy(Math.sqrt(v)); }),
};

const STDEVP: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'STDEVP(value1, [value2, …])',
  desc: 'The standard deviation of a whole population.',
  fn: agg((ns) => { const v = variance(ns, false, 'STDEVP'); return isError(v) ? v : tidy(Math.sqrt(v)); }),
};

const VAR: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'VAR(value1, [value2, …])',
  desc: 'The variance of a sample.',
  fn: agg((ns) => { const v = variance(ns, true, 'VAR'); return isError(v) ? v : tidy(v); }),
};

const VARP: FnDef = {
  min: 1, max: Infinity, category: 'Statistical', sig: 'VARP(value1, [value2, …])',
  desc: 'The variance of a whole population.',
  fn: agg((ns) => { const v = variance(ns, false, 'VARP'); return isError(v) ? v : tidy(v); }),
};

const RANK: FnDef = {
  min: 2, max: 3, category: 'Statistical', sig: 'RANK(value, data, [is_ascending])',
  desc: 'The position of a value in a list, 1 for the largest; ties share the higher position.',
  fn: rank(false),
};

const PERCENTILE: FnDef = {
  min: 2, max: 2, category: 'Statistical', sig: 'PERCENTILE(data, percentile)',
  desc: 'The value at a percentile from 0 to 1, interpolating between numbers.',
  fn: (a, ctx) => {
    const ns = numbersOf([a.get(0)], ctx); if (isError(ns)) return ns;
    const k = num(a.get(1), ctx); if (isError(k)) return k;
    if (ns.length === 0) return NUM('PERCENTILE has no numbers to work with.');
    if (k < 0 || k > 1) return NUM(`PERCENTILE: ${k} is outside 0 to 1.`);
    return percentile(up(ns), k);
  },
};

const QUARTILE: FnDef = {
  min: 2, max: 2, category: 'Statistical', sig: 'QUARTILE(data, quartile_number)',
  desc: 'A quartile: 0 minimum, 1 first quartile, 2 median, 3 third quartile, 4 maximum.',
  fn: (a, ctx) => {
    const ns = numbersOf([a.get(0)], ctx); if (isError(ns)) return ns;
    const q = int(a.get(1), ctx); if (isError(q)) return q;
    if (ns.length === 0) return NUM('QUARTILE has no numbers to work with.');
    if (q < 0 || q > 4) return NUM(`QUARTILE: ${q} is not one of 0, 1, 2, 3 or 4.`);
    return percentile(up(ns), q / 4);
  },
};

const FORECAST: FnDef = {
  min: 3, max: 3, category: 'Statistical', sig: 'FORECAST(x, data_y, data_x)',
  desc: 'The y value the best straight line through the data predicts for x.',
  fn: (a, ctx) => {
    const x = num(a.get(0), ctx); if (isError(x)) return x;
    const p = paired(a.get(1), a.get(2), 'FORECAST', ctx); if (isError(p)) return p;
    const f = fit(p);
    const b = slopeOf(f, 'FORECAST'); if (isError(b)) return b;
    return tidy(f.my - b * f.mx + b * x);
  },
};

export const STATS: Record<string, FnDef> = {
  MEDIAN,
  MODE,
  'MODE.SNGL': MODE,
  STDEV,
  'STDEV.S': STDEV,
  STDEVP,
  'STDEV.P': STDEVP,
  VAR,
  'VAR.S': VAR,
  VARP,
  'VAR.P': VARP,
  RANK,
  'RANK.EQ': RANK,
  'RANK.AVG': {
    min: 2, max: 3, category: 'Statistical', sig: 'RANK.AVG(value, data, [is_ascending])',
    desc: 'The position of a value in a list; ties get the average of the positions they share.',
    fn: rank(true),
  },
  PERCENTILE,
  'PERCENTILE.INC': PERCENTILE,
  QUARTILE,
  'QUARTILE.INC': QUARTILE,
  LARGE: {
    min: 2, max: 2, category: 'Statistical', sig: 'LARGE(data, n)',
    desc: 'The n-th largest number.',
    fn: kth(true),
  },
  SMALL: {
    min: 2, max: 2, category: 'Statistical', sig: 'SMALL(data, n)',
    desc: 'The n-th smallest number.',
    fn: kth(false),
  },
  AVERAGEA: {
    min: 1, max: Infinity, category: 'Statistical', sig: 'AVERAGEA(value1, [value2, …])',
    desc: 'The mean, counting text in ranges as 0 and TRUE as 1.',
    fn: (a, ctx) => {
      const ns = numbersA(a.all(), ctx); if (isError(ns)) return ns;
      return ns.length === 0 ? DIV0('AVERAGEA has no values to average.') : tidy(sum(ns) / ns.length);
    },
  },
  MAXA: {
    min: 1, max: Infinity, category: 'Statistical', sig: 'MAXA(value1, [value2, …])',
    desc: 'The largest value, counting text in ranges as 0 and TRUE as 1.',
    fn: (a, ctx) => {
      const ns = numbersA(a.all(), ctx); if (isError(ns)) return ns;
      return ns.length === 0 ? 0 : Math.max(...ns);
    },
  },
  MINA: {
    min: 1, max: Infinity, category: 'Statistical', sig: 'MINA(value1, [value2, …])',
    desc: 'The smallest value, counting text in ranges as 0 and TRUE as 1.',
    fn: (a, ctx) => {
      const ns = numbersA(a.all(), ctx); if (isError(ns)) return ns;
      return ns.length === 0 ? 0 : Math.min(...ns);
    },
  },
  CORREL: {
    min: 2, max: 2, category: 'Statistical', sig: 'CORREL(data_y, data_x)',
    desc: 'How closely two sets of numbers move together, from -1 to 1.',
    fn: (a, ctx) => {
      const p = paired(a.get(0), a.get(1), 'CORREL', ctx); if (isError(p)) return p;
      const f = fit(p);
      if (f.n === 0 || tidy(f.sxx) === 0 || tidy(f.syy) === 0) {
        return DIV0('CORREL: neither set of numbers may be all the same.');
      }
      return tidy(f.sxy / Math.sqrt(f.sxx * f.syy));
    },
  },
  SLOPE: {
    min: 2, max: 2, category: 'Statistical', sig: 'SLOPE(data_y, data_x)',
    desc: 'The slope of the best straight line through the data.',
    fn: (a, ctx) => {
      const p = paired(a.get(0), a.get(1), 'SLOPE', ctx); if (isError(p)) return p;
      const b = slopeOf(fit(p), 'SLOPE');
      return isError(b) ? b : tidy(b);
    },
  },
  INTERCEPT: {
    min: 2, max: 2, category: 'Statistical', sig: 'INTERCEPT(data_y, data_x)',
    desc: 'Where the best straight line through the data crosses x = 0.',
    fn: (a, ctx) => {
      const p = paired(a.get(0), a.get(1), 'INTERCEPT', ctx); if (isError(p)) return p;
      const f = fit(p);
      const b = slopeOf(f, 'INTERCEPT'); if (isError(b)) return b;
      return tidy(f.my - b * f.mx);
    },
  },
  FORECAST,
  'FORECAST.LINEAR': FORECAST,
};
