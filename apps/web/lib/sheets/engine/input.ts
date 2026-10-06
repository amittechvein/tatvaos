// ============================================================================
//  Reading what a person typed into a cell.
//
//  A cell stores its input exactly as typed ("₹15,000", "24/09/2026",
//  "=SUM(C2:C20)"). This file decides what that input MEANS — a number, a
//  date, text — and which display format it implies, so typing "85%" shows
//  85% and calculates as 0.85, as in every spreadsheet.
// ============================================================================

import { serialFromHms, serialFromYmd, daysInMonth, MONTHS } from './dates';
import type { Locale, Scalar } from './types';

export interface ParsedInput {
  kind: 'empty' | 'formula' | 'value';
  /** For values: what the cell holds. */
  value: Scalar;
  /** For formulas: the text after '='. */
  formula?: string;
  /** The display format the input implies, when it implies one ("85%" → "0%"). */
  format?: string;
}

const CURRENCY = /^(₹|Rs\.?|INR|\$|€|£)\s*/i;
const CURRENCY_AFTER = /\s*(₹|Rs\.?|INR|\$|€|£)$/i;

export function parseInput(raw: string | null | undefined, locale: Locale): ParsedInput {
  if (raw === null || raw === undefined || raw === '') return { kind: 'empty', value: null };
  // A leading apostrophe means "this is text": '0012 keeps its zeros.
  if (raw.startsWith("'")) return { kind: 'value', value: raw.slice(1) };
  if (raw.startsWith('=') && raw.length > 1) return { kind: 'formula', value: null, formula: raw.slice(1) };

  const t = raw.trim();
  const up = t.toUpperCase();
  if (up === 'TRUE') return { kind: 'value', value: true };
  if (up === 'FALSE') return { kind: 'value', value: false };

  const num = readNumber(t);
  if (num) return { kind: 'value', value: num.value, format: num.format(locale) };

  const dt = readDateTime(t, locale);
  if (dt) return { kind: 'value', value: dt.value, format: dt.format };

  return { kind: 'value', value: raw };
}

/**
 * Text → number, for arithmetic on text ("15" + 1) and for criteria.
 * Accepts everything parseInput reads as a number or date. null if none.
 */
export function parseNumberText(s: string, locale: Locale): number | null {
  const t = s.trim();
  if (t === '') return null;
  const num = readNumber(t);
  if (num) return num.value;
  const dt = readDateTime(t, locale);
  return dt ? dt.value : null;
}

// ---------------------------------------------------------------------------
//  Numbers: 15000, -1.5, 1,25,000, 125,000, ₹1,500.50, Rs 1500, 85%, 1.2e5,
//  (1,500) for a negative, as accounting writes it.
// ---------------------------------------------------------------------------

const INDIAN_GROUPS = /^\d{1,2}(,\d{2})*,\d{3}$/;
const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+$/;

function readNumber(t: string): { value: number; format: (l: Locale) => string | undefined } | null {
  let s = t;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim(); } else if (s.startsWith('+')) { s = s.slice(1).trim(); }

  let currency: string | null = null;
  const cb = CURRENCY.exec(s);
  if (cb) { currency = cb[1]!; s = s.slice(cb[0].length); }
  else {
    const ca = CURRENCY_AFTER.exec(s);
    if (ca) { currency = ca[1]!; s = s.slice(0, s.length - ca[0].length); }
  }
  // "-₹500" and "₹-500" both mean minus five hundred.
  if (currency && s.startsWith('-')) { neg = !neg; s = s.slice(1); }

  let percent = false;
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1).trim(); }

  const m = /^([0-9,]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(s);
  if (!m) return null;
  const intPart = m[1]!;
  const frac = m[2];
  const exp = m[3];
  if (intPart === '' && (frac === undefined || frac === '')) return null;

  let grouped = false;
  if (intPart.includes(',')) {
    if (!INDIAN_GROUPS.test(intPart) && !WESTERN_GROUPS.test(intPart)) return null;
    grouped = true;
  }
  let value = Number(`${intPart.replace(/,/g, '') || '0'}.${frac ?? ''}${exp !== undefined ? `e${exp}` : ''}`);
  if (!Number.isFinite(value)) return null;
  if (percent) value /= 100;
  if (neg) value = -value;

  const decimals = frac ? Math.min(frac.length, 10) : 0;
  const dec = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  return {
    value,
    format: () => {
      if (exp !== undefined && !percent && !currency) return '0.00E+00';
      if (percent) return `0${dec}%`;
      if (currency) {
        const sym = /^(rs|inr)/i.test(currency) ? '₹' : currency;
        return `${sym}#,##0${decimals > 0 ? '.00' : ''}`;
      }
      if (grouped) return `#,##0${dec}`;
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
//  Dates and times: 24/09/2026, 24-09-2026, 2026-09-24, 24 Sep 2026,
//  Sep 24, 2026, 10:30, 10:30 AM, 22:15:05, and a date followed by a time.
// ---------------------------------------------------------------------------

const MONTH_NAMES = MONTHS.map((m) => m.toLowerCase());

function monthFromName(s: string): number {
  const l = s.toLowerCase().replace(/\.$/, '');
  if (l.length < 3) return -1;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(l) || (l === 'sept' && m === 'september'));
  return i < 0 ? -1 : i + 1;
}

function validYmd(y: number, m: number, d: number): boolean {
  return y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function fullYear(y: string): number {
  const n = Number(y);
  if (y.length <= 2) return n < 30 ? 2000 + n : 1900 + n; // 26 → 2026, 85 → 1985
  return n;
}

function readDate(s: string, locale: Locale): { serial: number; format: string } | null {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    return validYmd(y, mo, d) ? { serial: serialFromYmd(y, mo, d), format: 'yyyy-mm-dd' } : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    const y = m[3] !== undefined ? fullYear(m[3]) : new Date().getFullYear();
    const [d, mo] = locale.dateOrder === 'dmy' ? [a, b] : [b, a];
    if (!validYmd(y, mo, d)) return null;
    const fmt = locale.dateOrder === 'dmy' ? 'dd/mm/yyyy' : 'mm/dd/yyyy';
    return { serial: serialFromYmd(y, mo, d), format: fmt };
  }
  // 24 Sep 2026, 24-Sep-2026, 24 September, 2026
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9}\.?)[\s,-]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]); const mo = monthFromName(m[2]!); const y = fullYear(m[3]!);
    return mo > 0 && validYmd(y, mo, d) ? { serial: serialFromYmd(y, mo, d), format: 'd mmm yyyy' } : null;
  }
  // Sep 24, 2026
  m = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = monthFromName(m[1]!); const d = Number(m[2]); const y = Number(m[3]);
    return mo > 0 && validYmd(y, mo, d) ? { serial: serialFromYmd(y, mo, d), format: 'd mmm yyyy' } : null;
  }
  return null;
}

function readTime(s: string): { serial: number; format: string } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/.exec(s);
  if (!m) return null;
  // "10" alone is a number, not ten o'clock.
  if (m[2] === undefined && !m[4]) return null;
  let h = Number(m[1]);
  const mi = m[2] !== undefined ? Number(m[2]) : 0;
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  const ampm = m[4]?.toUpperCase();
  if (mi > 59 || sec >= 60) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  const format = ampm ? (m[3] !== undefined ? 'h:mm:ss AM/PM' : 'h:mm AM/PM') : (m[3] !== undefined ? 'h:mm:ss' : 'h:mm');
  return { serial: serialFromHms(h, mi, sec), format };
}

function readDateTime(t: string, locale: Locale): { value: number; format: string } | null {
  const d = readDate(t, locale);
  if (d) return { value: d.serial, format: d.format };
  const tm = readTime(t);
  if (tm) return { value: tm.serial, format: tm.format };
  // A date, a space (or a comma), then a time.
  const m = /^(.+?)[\s,]+(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp][Mm])?)$/.exec(t);
  if (m) {
    const dd = readDate(m[1]!.trim(), locale);
    const tt = readTime(m[2]!.trim());
    if (dd && tt) return { value: dd.serial + tt.serial, format: `${dd.format} ${tt.format}` };
  }
  return null;
}
