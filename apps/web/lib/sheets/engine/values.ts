// ============================================================================
//  Coercion and comparison — the rules every operator and function shares.
// ============================================================================

import { CellError, isError, type Locale, type Scalar } from './types';
import { parseNumberText } from './input';

/** Number for arithmetic. Empty is 0; TRUE is 1; text is read as a number (or a date), else #VALUE!. */
export function toNumber(v: Scalar, locale: Locale): number | CellError {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isError(v)) return v;
  const n = parseNumberText(v, locale);
  return n === null ? new CellError('#VALUE!', `"${clip(v)}" is text, not a number.`) : n;
}

export function toText(v: Scalar): string | CellError {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isError(v)) return v;
  return numberToText(v);
}

export function toBool(v: Scalar): boolean | CellError {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isError(v)) return v;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return new CellError('#VALUE!', `"${clip(v)}" is text, not TRUE or FALSE.`);
}

/**
 * A number as text, the way a formula sees it (="Total: "&A1): up to 15
 * significant digits, no grouping, no trailing zeros. Display formatting is
 * format.ts's job and is deliberately separate.
 */
export function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Object.is(n, -0) || n === 0) return '0';
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e15) return String(n);
  if (abs >= 1e15 || abs < 1e-9) {
    const [m, e] = n.toExponential(14).split('e');
    const mant = m!.replace(/\.?0+$/, '');
    const exp = Number(e);
    return `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return String(Number(n.toPrecision(15)));
}

/** Round away floating-point dust before comparing: 0.1+0.2 = 0.3 in a spreadsheet. */
export function tidy(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : n;
}

function typeRank(v: Scalar): number {
  // Sort and compare order: numbers < text < booleans. Empty sorts as its partner's type.
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/**
 * Compare for = <> < > and for sorting. Text is compared without regard to
 * case (as in Sheets). Empty equals 0, "" and FALSE. Returns -1, 0 or 1.
 * Errors must be handled by the caller.
 */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
  if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') {
    const x = tidy(a);
    const y = tidy(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  return 0;
}

export function clip(s: string, n = 30): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
