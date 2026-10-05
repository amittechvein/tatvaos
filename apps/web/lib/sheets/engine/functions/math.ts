// ============================================================================
//  Math: SUM, AVERAGE, ROUND and friends.
// ============================================================================

import { isError, type EvalResult, type Scalar } from '../types';
import { tidy } from '../values';
import { numbersOf, num, int, dims, DIV0, NUM, VALUE, NA } from './helpers';
import type { FnDef, FnContext } from './index';

function roundTo(n: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const f = 10 ** digits;
  // toPrecision first: 2.675 is stored as 2.67499999…, and a spreadsheet rounds it to 2.68.
  const x = Number((Math.abs(n) * f).toPrecision(15));
  const r = mode === 'half' ? Math.round(x) : mode === 'up' ? Math.ceil(x) : Math.floor(x);
  return tidy((Math.sign(n) * r) / f);
}

function agg(fn: (ns: number[]) => EvalResult) {
  return (args: { all(): EvalResult[] }, ctx: FnContext): EvalResult => {
    const ns = numbersOf(args.all(), ctx);
    return isError(ns) ? ns : fn(ns);
  };
}

export const MATH: Record<string, FnDef> = {
  SUM: {
    min: 1, max: Infinity, category: 'Math', sig: 'SUM(value1, [value2, …])',
    desc: 'Adds numbers and the numbers in ranges.',
    fn: agg((ns) => tidy(ns.reduce((a, b) => a + b, 0))),
  },
  AVERAGE: {
    min: 1, max: Infinity, category: 'Math', sig: 'AVERAGE(value1, [value2, …])',
    desc: 'The mean of the numbers, ignoring text and empty cells.',
    fn: agg((ns) => ns.length === 0 ? DIV0('AVERAGE has no numbers to average.') : tidy(ns.reduce((a, b) => a + b, 0) / ns.length)),
  },
  MIN: {
    min: 1, max: Infinity, category: 'Math', sig: 'MIN(value1, [value2, …])',
    desc: 'The smallest number.',
    fn: agg((ns) => ns.length === 0 ? 0 : Math.min(...ns)),
  },
  MAX: {
    min: 1, max: Infinity, category: 'Math', sig: 'MAX(value1, [value2, …])',
    desc: 'The largest number.',
    fn: agg((ns) => ns.length === 0 ? 0 : Math.max(...ns)),
  },
  PRODUCT: {
    min: 1, max: Infinity, category: 'Math', sig: 'PRODUCT(value1, [value2, …])',
    desc: 'Multiplies the numbers together.',
    fn: agg((ns) => ns.length === 0 ? 0 : tidy(ns.reduce((a, b) => a * b, 1))),
  },
  ROUND: {
    min: 1, max: 2, category: 'Math', sig: 'ROUND(value, [places])',
    desc: 'Rounds to a number of decimal places; 0.5 rounds away from zero.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 0 : int(a.get(1), ctx); if (isError(d)) return d;
      return roundTo(n, d, 'half');
    },
  },
  ROUNDUP: {
    min: 1, max: 2, category: 'Math', sig: 'ROUNDUP(value, [places])',
    desc: 'Rounds away from zero.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 0 : int(a.get(1), ctx); if (isError(d)) return d;
      return roundTo(n, d, 'up');
    },
  },
  ROUNDDOWN: {
    min: 1, max: 2, category: 'Math', sig: 'ROUNDDOWN(value, [places])',
    desc: 'Rounds towards zero.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 0 : int(a.get(1), ctx); if (isError(d)) return d;
      return roundTo(n, d, 'down');
    },
  },
  INT: {
    min: 1, max: 1, category: 'Math', sig: 'INT(value)',
    desc: 'Rounds down to the whole number below.',
    fn: (a, ctx) => { const n = num(a.get(0), ctx); return isError(n) ? n : Math.floor(n); },
  },
  TRUNC: {
    min: 1, max: 2, category: 'Math', sig: 'TRUNC(value, [places])',
    desc: 'Cuts off decimals without rounding.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 0 : int(a.get(1), ctx); if (isError(d)) return d;
      return roundTo(n, d, 'down');
    },
  },
  ABS: {
    min: 1, max: 1, category: 'Math', sig: 'ABS(value)', desc: 'The number without its sign.',
    fn: (a, ctx) => { const n = num(a.get(0), ctx); return isError(n) ? n : Math.abs(n); },
  },
  SIGN: {
    min: 1, max: 1, category: 'Math', sig: 'SIGN(value)', desc: '1 for positive, -1 for negative, 0 for zero.',
    fn: (a, ctx) => { const n = num(a.get(0), ctx); return isError(n) ? n : Math.sign(n); },
  },
  MOD: {
    min: 2, max: 2, category: 'Math', sig: 'MOD(dividend, divisor)',
    desc: 'The remainder after division, with the sign of the divisor.',
    fn: (a, ctx) => {
      const x = num(a.get(0), ctx); if (isError(x)) return x;
      const y = num(a.get(1), ctx); if (isError(y)) return y;
      if (y === 0) return DIV0('MOD by zero.');
      return tidy(x - y * Math.floor(x / y));
    },
  },
  POWER: {
    min: 2, max: 2, category: 'Math', sig: 'POWER(base, exponent)', desc: 'A number raised to a power.',
    fn: (a, ctx) => {
      const x = num(a.get(0), ctx); if (isError(x)) return x;
      const y = num(a.get(1), ctx); if (isError(y)) return y;
      if (x === 0 && y < 0) return DIV0();
      const p = x ** y;
      return Number.isNaN(p) ? NUM('A negative number cannot be raised to a fractional power.') : tidy(p);
    },
  },
  SQRT: {
    min: 1, max: 1, category: 'Math', sig: 'SQRT(value)', desc: 'The positive square root.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n < 0 ? NUM('SQRT of a negative number.') : Math.sqrt(n);
    },
  },
  EXP: {
    min: 1, max: 1, category: 'Math', sig: 'EXP(exponent)', desc: 'e raised to a power.',
    fn: (a, ctx) => { const n = num(a.get(0), ctx); return isError(n) ? n : Math.exp(n); },
  },
  LN: {
    min: 1, max: 1, category: 'Math', sig: 'LN(value)', desc: 'The natural logarithm.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n <= 0 ? NUM('LN needs a positive number.') : Math.log(n);
    },
  },
  LOG10: {
    min: 1, max: 1, category: 'Math', sig: 'LOG10(value)', desc: 'The base-10 logarithm.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n <= 0 ? NUM('LOG10 needs a positive number.') : tidy(Math.log10(n));
    },
  },
  LOG: {
    min: 1, max: 2, category: 'Math', sig: 'LOG(value, [base])', desc: 'The logarithm, base 10 unless given.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const b = a.missing(1) ? 10 : num(a.get(1), ctx); if (isError(b)) return b;
      if (n <= 0 || b <= 0 || b === 1) return NUM();
      return tidy(Math.log(n) / Math.log(b));
    },
  },
  PI: {
    min: 0, max: 0, category: 'Math', sig: 'PI()', desc: 'π to 15 digits.',
    fn: () => Math.PI,
  },
  CEILING: {
    min: 1, max: 2, category: 'Math', sig: 'CEILING(value, [factor])',
    desc: 'Rounds up to the nearest multiple of the factor.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const f = a.missing(1) ? 1 : num(a.get(1), ctx); if (isError(f)) return f;
      if (f === 0) return 0;
      if (n > 0 && f < 0) return NUM('CEILING: a positive value needs a positive factor.');
      return tidy(Math.ceil(tidy(n / f)) * f);
    },
  },
  FLOOR: {
    min: 1, max: 2, category: 'Math', sig: 'FLOOR(value, [factor])',
    desc: 'Rounds down to the nearest multiple of the factor.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const f = a.missing(1) ? 1 : num(a.get(1), ctx); if (isError(f)) return f;
      if (f === 0) return DIV0('FLOOR with a factor of 0.');
      if (n > 0 && f < 0) return NUM('FLOOR: a positive value needs a positive factor.');
      return tidy(Math.floor(tidy(n / f)) * f);
    },
  },
  MROUND: {
    min: 2, max: 2, category: 'Math', sig: 'MROUND(value, factor)',
    desc: 'Rounds to the nearest multiple of the factor.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const f = num(a.get(1), ctx); if (isError(f)) return f;
      if (f === 0) return 0;
      if (Math.sign(n) * Math.sign(f) < 0) return NUM('MROUND: value and factor must have the same sign.');
      return tidy(Math.round(tidy(n / f)) * f);
    },
  },
  SUMPRODUCT: {
    min: 1, max: Infinity, category: 'Math', sig: 'SUMPRODUCT(array1, [array2, …])',
    desc: 'Multiplies matching items in same-sized ranges and adds the results.',
    fn: (a, ctx) => {
      const grids = a.all().map((x) => ctx.grid(x));
      const { rows, cols } = { rows: grids[0]!.length, cols: grids[0]![0]?.length ?? 0 };
      if (grids.some((g) => g.length !== rows || (g[0]?.length ?? 0) !== cols)) {
        return VALUE('SUMPRODUCT has mismatched range sizes.');
      }
      let total = 0;
      for (let i = 0; i < rows; i += 1) {
        for (let j = 0; j < cols; j += 1) {
          let p = 1;
          for (const g of grids) {
            const v: Scalar = g[i]![j]!;
            if (isError(v)) return v;
            // TRUE/FALSE from a comparison count as 1/0; text counts as 0.
            p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
          }
          total += p;
        }
      }
      return tidy(total);
    },
  },
  RAND: {
    min: 0, max: 0, volatile: true, category: 'Math', sig: 'RAND()',
    desc: 'A random number from 0 up to 1, new on every change.',
    fn: () => Math.random(),
  },
  RANDBETWEEN: {
    min: 2, max: 2, volatile: true, category: 'Math', sig: 'RANDBETWEEN(low, high)',
    desc: 'A random whole number between two numbers.',
    fn: (a, ctx) => {
      const lo = num(a.get(0), ctx); if (isError(lo)) return lo;
      const hi = num(a.get(1), ctx); if (isError(hi)) return hi;
      const l = Math.ceil(lo); const h = Math.floor(hi);
      if (l > h) return NUM('RANDBETWEEN: low is greater than high.');
      return l + Math.floor(Math.random() * (h - l + 1));
    },
  },
  SUMSQ: {
    min: 1, max: Infinity, category: 'Math', sig: 'SUMSQ(value1, [value2, …])',
    desc: 'The sum of the squares.',
    fn: agg((ns) => tidy(ns.reduce((s, n) => s + n * n, 0))),
  },
  QUOTIENT: {
    min: 2, max: 2, category: 'Math', sig: 'QUOTIENT(dividend, divisor)',
    desc: 'The whole-number part of a division.',
    fn: (a, ctx) => {
      const x = num(a.get(0), ctx); if (isError(x)) return x;
      const y = num(a.get(1), ctx); if (isError(y)) return y;
      return y === 0 ? DIV0() : Math.trunc(x / y);
    },
  },
  EVEN: {
    min: 1, max: 1, category: 'Math', sig: 'EVEN(value)', desc: 'Rounds away from zero to an even whole number.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const r = Math.ceil(Math.abs(n) / 2) * 2;
      return n < 0 ? -r : r;
    },
  },
  ODD: {
    min: 1, max: 1, category: 'Math', sig: 'ODD(value)', desc: 'Rounds away from zero to an odd whole number.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      let r = Math.ceil(Math.abs(n));
      if (r % 2 === 0) r += 1;
      return n < 0 ? -r : r;
    },
  },
  FACT: {
    min: 1, max: 1, category: 'Math', sig: 'FACT(value)', desc: 'The factorial: 5! = 120.',
    fn: (a, ctx) => {
      const n = int(a.get(0), ctx); if (isError(n)) return n;
      if (n < 0) return NUM();
      if (n > 170) return NUM();
      let f = 1; for (let i = 2; i <= n; i += 1) f *= i;
      return f;
    },
  },
  GCD: {
    min: 1, max: Infinity, category: 'Math', sig: 'GCD(value1, [value2, …])', desc: 'The greatest common divisor.',
    fn: agg((ns) => {
      const g = (x: number, y: number): number => (y === 0 ? x : g(y, x % y));
      if (ns.some((n) => n < 0)) return NUM();
      return ns.map(Math.trunc).reduce((x, y) => g(x, y), 0);
    }),
  },
  LCM: {
    min: 1, max: Infinity, category: 'Math', sig: 'LCM(value1, [value2, …])', desc: 'The least common multiple.',
    fn: agg((ns) => {
      const g = (x: number, y: number): number => (y === 0 ? x : g(y, x % y));
      if (ns.some((n) => n < 0)) return NUM();
      return ns.map(Math.trunc).reduce((x, y) => (x === 0 || y === 0 ? 0 : (x * y) / g(x, y)), 1);
    }),
  },
  SUBTOTAL: {
    min: 2, max: Infinity, category: 'Math', sig: 'SUBTOTAL(function_code, range1, [range2, …])',
    desc: 'A total by code: 1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX, 5 MIN, 6 PRODUCT, 9 SUM.',
    fn: (a, ctx) => {
      const code = int(a.get(0), ctx); if (isError(code)) return code;
      const rest = a.all().slice(1);
      const ns = numbersOf(rest, ctx); if (isError(ns)) return ns;
      switch (code % 100) {
        case 1: return ns.length ? tidy(ns.reduce((x, y) => x + y, 0) / ns.length) : DIV0();
        case 2: return ns.length;
        case 3: {
          let n = 0;
          for (const r of rest) for (const row of ctx.grid(r)) for (const v of row) if (v !== null && v !== '') n += 1;
          return n;
        }
        case 4: return ns.length ? Math.max(...ns) : 0;
        case 5: return ns.length ? Math.min(...ns) : 0;
        case 6: return ns.length ? tidy(ns.reduce((x, y) => x * y, 1)) : 0;
        case 9: return tidy(ns.reduce((x, y) => x + y, 0));
        default: return VALUE(`SUBTOTAL code ${code} is not supported.`);
      }
    },
  },
  ROWS: {
    min: 1, max: 1, category: 'Math', sig: 'ROWS(range)', desc: 'How many rows a range has.',
    fn: (a) => dims(a.get(0)).rows,
  },
  COLUMNS: {
    min: 1, max: 1, category: 'Math', sig: 'COLUMNS(range)', desc: 'How many columns a range has.',
    fn: (a) => dims(a.get(0)).cols,
  },
  N: {
    min: 1, max: 1, category: 'Math', sig: 'N(value)', desc: 'A number as itself, TRUE as 1, anything else as 0.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      return typeof v === 'number' ? v : v === true ? 1 : 0;
    },
  },
  NA: {
    min: 0, max: 0, category: 'Math', sig: 'NA()', desc: 'The #N/A error, on purpose.',
    fn: () => NA(),
  },
};
