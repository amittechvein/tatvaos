// ============================================================================
//  Dates and times: TODAY, DATE, EDATE, DATEDIF, NETWORKDAYS and friends.
//
//  Every date here is a serial number — days since 30 December 1899, the
//  time as the fraction of a day (see ../dates.ts). Arguments go through the
//  ordinary number rules, so a typed date in a cell ("24/09/2026") and text
//  that reads as one both work wherever a date is expected.
// ============================================================================

import { isError, isMatrix, isRef, type CellError, type EvalResult } from '../types';
import { toNumber, clip } from '../values';
import { parseInput } from '../input';
import { isDateFormat } from '../format';
import {
  serialFromYmd, ymdFromSerial, weekdayFromSerial, hmsFromSerial, serialFromHms,
  localNowSerial, isLeap, daysInMonth,
} from '../dates';
import { num, int, text, NUM, VALUE } from './helpers';
import type { FnDef, FnContext } from './index';

/** 31 December 9999: Sheets' last date. */
const MAX_SERIAL = serialFromYmd(9999, 12, 31);

/** An argument as a date serial: a number of 0 or more, whole days only. */
function dateArg(v: EvalResult, ctx: FnContext, fnName: string): number | CellError {
  const n = num(v, ctx);
  if (isError(n)) return n;
  if (n < 0) return NUM(`${fnName} cannot use a date before 30 December 1899 (a negative number).`);
  return Math.floor(n);
}

/** A serial that must land on a real date, or #NUM!. */
function checked(serial: number, fnName: string): number | CellError {
  if (serial < 0 || serial > MAX_SERIAL) return NUM(`${fnName} gives a date outside the range spreadsheets can show.`);
  return serial;
}

/** The same day n months later (or earlier), kept inside a shorter month: 31 Jan + 1 month is 28/29 Feb. */
function addMonths(serial: number, months: number): number {
  const { y, m, d } = ymdFromSerial(serial);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return serialFromYmd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/**
 * Which weekdays are the weekend, as seven flags Monday first — the
 * NETWORKDAYS.INTL / WORKDAY.INTL code: a number 1–7 or 11–17, or a string
 * like "0000011" (1 = weekend). Default Saturday and Sunday.
 */
function weekendMask(v: EvalResult | undefined, ctx: FnContext, fnName: string): boolean[] | CellError {
  if (v === undefined) return [false, false, false, false, false, true, true];
  const s = ctx.scalar(v);
  if (isError(s)) return s;
  if (typeof s === 'string' && /^[01]{7}$/.test(s)) {
    if (s === '1111111') return VALUE(`${fnName} weekend "1111111" leaves no working days.`);
    return [...s].map((c) => c === '1');
  }
  const n = toNumber(s, ctx.locale);
  if (isError(n)) return n;
  const code = Math.trunc(n);
  const mask = [false, false, false, false, false, false, false];
  if (code >= 1 && code <= 7) {
    // 1 = Sat+Sun, 2 = Sun+Mon, … 7 = Fri+Sat. Index 0 is Monday.
    mask[(code + 4) % 7] = true;
    mask[(code + 5) % 7] = true;
    return mask;
  }
  if (code >= 11 && code <= 17) {
    // 11 = Sunday only, 12 = Monday only, … 17 = Saturday only.
    mask[(code - 11 + 6) % 7] = true;
    return mask;
  }
  return NUM(`${fnName} weekend code ${code} is not one of 1–7 or 11–17.`);
}

/** Holidays from a range, an array or one value, as a set of whole-day serials. */
function holidaySet(v: EvalResult | undefined, ctx: FnContext): Set<number> | CellError {
  const out = new Set<number>();
  if (v === undefined) return out;
  const g = isRef(v) || isMatrix(v) ? ctx.grid(v) : [[v]];
  for (const row of g) for (const x of row) {
    if (x === null || x === '') continue;
    if (isError(x)) return x;
    const n = toNumber(x, ctx.locale);
    if (isError(n)) return VALUE(`Holiday "${clip(String(x))}" is not a date.`);
    out.add(Math.floor(n));
  }
  return out;
}

/** Is this serial a working day? mask is Monday first. */
function isWorkday(serial: number, mask: boolean[], holidays: ReadonlySet<number>): boolean {
  const mondayFirst = (weekdayFromSerial(serial) + 6) % 7;
  return !mask[mondayFirst] && !holidays.has(serial);
}

const NO_HOLIDAYS: ReadonlySet<number> = new Set();

function networkDays(start: number, end: number, mask: boolean[], holidays: Set<number>): number {
  const sign = end < start ? -1 : 1;
  const [lo, hi] = sign < 0 ? [end, start] : [start, end];
  // Whole weeks at once, then the leftover days one by one — a ten-year span is not 3,650 steps.
  const days = hi - lo + 1;
  const perWeek = mask.filter((w) => !w).length;
  let count = Math.floor(days / 7) * perWeek;
  for (let s = lo + Math.floor(days / 7) * 7; s <= hi; s += 1) if (isWorkday(s, mask, NO_HOLIDAYS)) count += 1;
  for (const h of holidays) if (h >= lo && h <= hi && isWorkday(h, mask, NO_HOLIDAYS)) count -= 1;
  return sign * count;
}

function workday(start: number, days: number, mask: boolean[], holidays: Set<number>): number {
  let s = start;
  let left = Math.abs(days);
  const step = days < 0 ? -1 : 1;
  while (left > 0) {
    s += step;
    if (s < 0 || s > MAX_SERIAL) return -1;
    if (isWorkday(s, mask, holidays)) left -= 1;
  }
  return s;
}

/** The ISO 8601 week number: weeks start Monday; week 1 holds the year's first Thursday. */
function isoWeek(serial: number): number {
  const mondayFirst = (weekdayFromSerial(serial) + 6) % 7;
  const thursday = serial - mondayFirst + 3;
  const { y } = ymdFromSerial(thursday);
  return Math.floor((thursday - serialFromYmd(y, 1, 1)) / 7) + 1;
}

/** 30/360 day count. US (NASD) unless european. */
function days360(start: number, end: number, european: boolean): number {
  const a = ymdFromSerial(start);
  const b = ymdFromSerial(end);
  let d1 = a.d;
  let d2 = b.d;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    // The last day of February counts as the 30th when it starts the period.
    if (a.m === 2 && d1 === daysInMonth(a.y, 2)) d1 = 30;
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
}

/** Text → a date serial, when the text is a date (or a date and time). null if not. */
function readDateText(s: string, ctx: FnContext): number | null {
  const p = parseInput(s.trim(), ctx.locale);
  if (p.kind !== 'value' || typeof p.value !== 'number' || !p.format || !isDateFormat(p.format)) return null;
  return p.value;
}

export const DATE: Record<string, FnDef> = {
  TODAY: {
    min: 0, max: 0, volatile: true, category: 'Date', sig: 'TODAY()',
    desc: "Today's date. Changes each day.",
    fn: (_a, ctx) => Math.floor(localNowSerial(ctx.now())),
  },
  NOW: {
    min: 0, max: 0, volatile: true, category: 'Date', sig: 'NOW()',
    desc: 'The date and time right now. Changes as the sheet recalculates.',
    fn: (_a, ctx) => localNowSerial(ctx.now()),
  },
  DATE: {
    min: 3, max: 3, category: 'Date', sig: 'DATE(year, month, day)',
    desc: 'A date from its parts. Months and days past the end carry over: DATE(2026, 13, 1) is 1 January 2027.',
    fn: (a, ctx) => {
      const y = int(a.get(0), ctx); if (isError(y)) return y;
      const m = int(a.get(1), ctx); if (isError(m)) return m;
      const d = int(a.get(2), ctx); if (isError(d)) return d;
      if (y < 0 || y > 9999) return NUM(`DATE year ${y} is outside 0–9999.`);
      return checked(serialFromYmd(y, m, d), 'DATE');
    },
  },
  TIME: {
    min: 3, max: 3, category: 'Date', sig: 'TIME(hour, minute, second)',
    desc: 'A time of day from hours, minutes and seconds, as a fraction of a day.',
    fn: (a, ctx) => {
      const h = int(a.get(0), ctx); if (isError(h)) return h;
      const mi = int(a.get(1), ctx); if (isError(mi)) return mi;
      const s = int(a.get(2), ctx); if (isError(s)) return s;
      const secs = h * 3600 + mi * 60 + s;
      if (secs < 0) return NUM('TIME cannot be before midnight.');
      // Past 24 hours wraps round the clock: TIME(25, 0, 0) is 1:00 AM.
      // Wrap in whole seconds, not days, so 1:00 AM is exactly 1/24.
      return serialFromHms(0, 0, secs % 86_400);
    },
  },
  DAY: {
    min: 1, max: 1, category: 'Date', sig: 'DAY(date)', desc: 'The day of the month, 1 to 31.',
    fn: (a, ctx) => { const s = dateArg(a.get(0), ctx, 'DAY'); return isError(s) ? s : ymdFromSerial(s).d; },
  },
  MONTH: {
    min: 1, max: 1, category: 'Date', sig: 'MONTH(date)', desc: 'The month, 1 (January) to 12 (December).',
    fn: (a, ctx) => { const s = dateArg(a.get(0), ctx, 'MONTH'); return isError(s) ? s : ymdFromSerial(s).m; },
  },
  YEAR: {
    min: 1, max: 1, category: 'Date', sig: 'YEAR(date)', desc: 'The year of a date.',
    fn: (a, ctx) => { const s = dateArg(a.get(0), ctx, 'YEAR'); return isError(s) ? s : ymdFromSerial(s).y; },
  },
  HOUR: {
    min: 1, max: 1, category: 'Date', sig: 'HOUR(time)', desc: 'The hour, 0 to 23.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n < 0 ? NUM('HOUR cannot use a negative time.') : hmsFromSerial(n).h;
    },
  },
  MINUTE: {
    min: 1, max: 1, category: 'Date', sig: 'MINUTE(time)', desc: 'The minute, 0 to 59.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n < 0 ? NUM('MINUTE cannot use a negative time.') : hmsFromSerial(n).mi;
    },
  },
  SECOND: {
    min: 1, max: 1, category: 'Date', sig: 'SECOND(time)', desc: 'The second, 0 to 59.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      return n < 0 ? NUM('SECOND cannot use a negative time.') : hmsFromSerial(n).s;
    },
  },
  WEEKDAY: {
    min: 1, max: 2, category: 'Date', sig: 'WEEKDAY(date, [type])',
    desc: 'The day of the week as a number. Type 1: Sunday is 1; type 2: Monday is 1; type 3: Monday is 0.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'WEEKDAY'); if (isError(s)) return s;
      const t = a.missing(1) ? 1 : int(a.get(1), ctx); if (isError(t)) return t;
      const wd = weekdayFromSerial(s); // 0 = Sunday
      if (t === 1) return wd + 1;
      if (t === 2) return ((wd + 6) % 7) + 1;
      if (t === 3) return (wd + 6) % 7;
      return NUM(`WEEKDAY type ${t} is not 1, 2 or 3.`);
    },
  },
  WEEKNUM: {
    min: 1, max: 2, category: 'Date', sig: 'WEEKNUM(date, [type])',
    desc: 'The week of the year. Type 1: weeks start on Sunday; 2: on Monday; 21: ISO weeks.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'WEEKNUM'); if (isError(s)) return s;
      const t = a.missing(1) ? 1 : int(a.get(1), ctx); if (isError(t)) return t;
      if (t === 21) return isoWeek(s);
      // The weekday each week starts on, 0 = Sunday.
      let first: number;
      if (t === 1 || t === 17) first = 0;
      else if (t === 2 || t === 11) first = 1;
      else if (t >= 12 && t <= 16) first = t - 10;
      else return NUM(`WEEKNUM type ${t} is not 1, 2, 11–17 or 21.`);
      const jan1 = serialFromYmd(ymdFromSerial(s).y, 1, 1);
      const offset = (weekdayFromSerial(jan1) - first + 7) % 7;
      return Math.floor((s - jan1 + offset) / 7) + 1;
    },
  },
  ISOWEEKNUM: {
    min: 1, max: 1, category: 'Date', sig: 'ISOWEEKNUM(date)',
    desc: 'The ISO week of the year: weeks start on Monday and week 1 holds the first Thursday.',
    fn: (a, ctx) => { const s = dateArg(a.get(0), ctx, 'ISOWEEKNUM'); return isError(s) ? s : isoWeek(s); },
  },
  EDATE: {
    min: 2, max: 2, category: 'Date', sig: 'EDATE(start_date, months)',
    desc: 'The same day a number of months later (or earlier, if negative).',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'EDATE'); if (isError(s)) return s;
      const m = int(a.get(1), ctx); if (isError(m)) return m;
      return checked(addMonths(s, m), 'EDATE');
    },
  },
  EOMONTH: {
    min: 2, max: 2, category: 'Date', sig: 'EOMONTH(start_date, months)',
    desc: 'The last day of the month a number of months later: EOMONTH(date, 0) is the end of its month.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'EOMONTH'); if (isError(s)) return s;
      const m = int(a.get(1), ctx); if (isError(m)) return m;
      const { y, m: mo } = ymdFromSerial(s);
      // Day 0 of the month after is the last day of this one.
      return checked(serialFromYmd(y, mo + m + 1, 0), 'EOMONTH');
    },
  },
  DATEDIF: {
    min: 3, max: 3, category: 'Date', sig: 'DATEDIF(start_date, end_date, unit)',
    desc: 'Whole years ("Y"), months ("M") or days ("D") between two dates; "MD", "YM", "YD" ignore the larger units.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'DATEDIF'); if (isError(s)) return s;
      const e = dateArg(a.get(1), ctx, 'DATEDIF'); if (isError(e)) return e;
      const u = text(a.get(2), ctx); if (isError(u)) return u;
      if (s > e) return NUM('DATEDIF start date is after the end date.');
      const A = ymdFromSerial(s);
      const B = ymdFromSerial(e);
      const dayShort = B.d < A.d ? 1 : 0;
      switch (u.trim().toUpperCase()) {
        case 'D': return e - s;
        case 'M': return (B.y - A.y) * 12 + (B.m - A.m) - dayShort;
        case 'Y': return B.y - A.y - (B.m < A.m || (B.m === A.m && B.d < A.d) ? 1 : 0);
        case 'YM': return ((B.m - A.m - dayShort) % 12 + 12) % 12;
        case 'MD':
          // Days since the start's day-of-month fell in the end's month (or the month before).
          return B.d >= A.d ? B.d - A.d : e - serialFromYmd(B.y, B.m - 1, A.d);
        case 'YD': {
          let anniversary = serialFromYmd(B.y, A.m, A.d);
          if (anniversary > e) anniversary = serialFromYmd(B.y - 1, A.m, A.d);
          return e - anniversary;
        }
        default:
          return NUM(`DATEDIF unit "${clip(u)}" is not one of Y, M, D, MD, YM, YD.`);
      }
    },
  },
  DAYS: {
    min: 2, max: 2, category: 'Date', sig: 'DAYS(end_date, start_date)',
    desc: 'The number of days from the start date to the end date.',
    fn: (a, ctx) => {
      const e = num(a.get(0), ctx); if (isError(e)) return e;
      const s = num(a.get(1), ctx); if (isError(s)) return s;
      return Math.floor(e) - Math.floor(s);
    },
  },
  DAYS360: {
    min: 2, max: 3, category: 'Date', sig: 'DAYS360(start_date, end_date, [european])',
    desc: 'Days between two dates in a 360-day year of twelve 30-day months, as some accounts count interest.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'DAYS360'); if (isError(s)) return s;
      const e = dateArg(a.get(1), ctx, 'DAYS360'); if (isError(e)) return e;
      const eu = a.missing(2) ? false : toNumberBool(a.get(2), ctx); if (isError(eu)) return eu;
      return days360(s, e, eu);
    },
  },
  NETWORKDAYS: {
    min: 2, max: 3, category: 'Date', sig: 'NETWORKDAYS(start_date, end_date, [holidays])',
    desc: 'Working days (Monday to Friday) between two dates, both included, less any holidays.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'NETWORKDAYS'); if (isError(s)) return s;
      const e = dateArg(a.get(1), ctx, 'NETWORKDAYS'); if (isError(e)) return e;
      const h = holidaySet(a.missing(2) ? undefined : a.get(2), ctx); if (isError(h)) return h;
      return networkDays(s, e, [false, false, false, false, false, true, true], h);
    },
  },
  'NETWORKDAYS.INTL': {
    min: 2, max: 4, category: 'Date', sig: 'NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])',
    desc: 'Working days between two dates with your own weekend: 11 is Sunday only, "0000011" is Saturday and Sunday.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'NETWORKDAYS.INTL'); if (isError(s)) return s;
      const e = dateArg(a.get(1), ctx, 'NETWORKDAYS.INTL'); if (isError(e)) return e;
      const w = weekendMask(a.missing(2) ? undefined : a.get(2), ctx, 'NETWORKDAYS.INTL'); if (isError(w)) return w;
      const h = holidaySet(a.missing(3) ? undefined : a.get(3), ctx); if (isError(h)) return h;
      return networkDays(s, e, w, h);
    },
  },
  WORKDAY: {
    min: 2, max: 3, category: 'Date', sig: 'WORKDAY(start_date, working_days, [holidays])',
    desc: 'The date a number of working days after (or before) the start, skipping weekends and holidays.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'WORKDAY'); if (isError(s)) return s;
      const n = int(a.get(1), ctx); if (isError(n)) return n;
      const h = holidaySet(a.missing(2) ? undefined : a.get(2), ctx); if (isError(h)) return h;
      return checked(workday(s, n, [false, false, false, false, false, true, true], h), 'WORKDAY');
    },
  },
  'WORKDAY.INTL': {
    min: 2, max: 4, category: 'Date', sig: 'WORKDAY.INTL(start_date, working_days, [weekend], [holidays])',
    desc: 'WORKDAY with your own weekend: 11 is Sunday only, "0000011" is Saturday and Sunday.',
    fn: (a, ctx) => {
      const s = dateArg(a.get(0), ctx, 'WORKDAY.INTL'); if (isError(s)) return s;
      const n = int(a.get(1), ctx); if (isError(n)) return n;
      const w = weekendMask(a.missing(2) ? undefined : a.get(2), ctx, 'WORKDAY.INTL'); if (isError(w)) return w;
      const h = holidaySet(a.missing(3) ? undefined : a.get(3), ctx); if (isError(h)) return h;
      return checked(workday(s, n, w, h), 'WORKDAY.INTL');
    },
  },
  DATEVALUE: {
    min: 1, max: 1, category: 'Date', sig: 'DATEVALUE(date_text)',
    desc: "Text such as \"24/09/2026\" as a date, read in the workbook's date order.",
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      if (typeof v === 'number') return v < 0 ? NUM('DATEVALUE cannot use a negative date.') : Math.floor(v);
      if (typeof v !== 'string') return VALUE('DATEVALUE needs text that looks like a date.');
      const d = readDateText(v, ctx);
      return d === null ? VALUE(`DATEVALUE parameter '${clip(v)}' cannot be read as a date.`) : Math.floor(d);
    },
  },
  TIMEVALUE: {
    min: 1, max: 1, category: 'Date', sig: 'TIMEVALUE(time_text)',
    desc: 'Text such as "10:30 AM" as a time of day, the fraction of a day.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      if (typeof v === 'number') return v < 0 ? NUM('TIMEVALUE cannot use a negative time.') : v - Math.floor(v);
      if (typeof v !== 'string') return VALUE('TIMEVALUE needs text that looks like a time.');
      const t = readDateText(v, ctx);
      return t === null ? VALUE(`TIMEVALUE parameter '${clip(v)}' cannot be read as a time.`) : t - Math.floor(t);
    },
  },
  YEARFRAC: {
    min: 2, max: 3, category: 'Date', sig: 'YEARFRAC(start_date, end_date, [day_count])',
    desc: 'The fraction of a year between two dates. Day count 0: 30/360 (US); 1: actual days; 2: actual/360; 3: actual/365; 4: 30/360 (Europe).',
    fn: (a, ctx) => {
      let s = dateArg(a.get(0), ctx, 'YEARFRAC'); if (isError(s)) return s;
      let e = dateArg(a.get(1), ctx, 'YEARFRAC'); if (isError(e)) return e;
      const basis = a.missing(2) ? 0 : int(a.get(2), ctx); if (isError(basis)) return basis;
      if (s > e) [s, e] = [e, s];
      switch (basis) {
        case 0: return yearFrac30(s, e);
        case 1: return yearFracActual(s, e);
        case 2: return (e - s) / 360;
        case 3: return (e - s) / 365;
        case 4: return days360(s, e, true) / 360;
        default: return NUM(`YEARFRAC day count ${basis} is not 0, 1, 2, 3 or 4.`);
      }
    },
  },
};

/** DAYS360's third argument: TRUE/FALSE, or a number. */
function toNumberBool(v: EvalResult, ctx: FnContext): boolean | CellError {
  const s = ctx.scalar(v);
  if (typeof s === 'boolean') return s;
  const n = toNumber(s, ctx.locale);
  return isError(n) ? n : n !== 0;
}

/** YEARFRAC basis 0: US 30/360, with both February month-ends counted as the 30th. */
function yearFrac30(s: number, e: number): number {
  const A = ymdFromSerial(s);
  const B = ymdFromSerial(e);
  let d1 = A.d;
  let d2 = B.d;
  const febEnd1 = A.m === 2 && d1 === daysInMonth(A.y, 2);
  const febEnd2 = B.m === 2 && d2 === daysInMonth(B.y, 2);
  if (febEnd1 && febEnd2) d2 = 30;
  if (febEnd1) d1 = 30;
  if (d2 === 31 && d1 >= 30) d2 = 30;
  if (d1 === 31) d1 = 30;
  return ((B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1)) / 360;
}

/** YEARFRAC basis 1: actual days over the actual length of the year(s), Excel's way. */
function yearFracActual(s: number, e: number): number {
  const A = ymdFromSerial(s);
  const B = ymdFromSerial(e);
  const days = e - s;
  if (A.y === B.y) return days / (isLeap(A.y) ? 366 : 365);
  const withinAYear = B.y === A.y + 1 && (A.m > B.m || (A.m === B.m && A.d >= B.d));
  if (withinAYear) {
    // 366 when a 29 February falls inside the period.
    const leapDay =
      (isLeap(A.y) && s <= serialFromYmd(A.y, 2, 29)) ||
      (isLeap(B.y) && e >= serialFromYmd(B.y, 2, 29));
    return days / (leapDay ? 366 : 365);
  }
  const span = serialFromYmd(B.y + 1, 1, 1) - serialFromYmd(A.y, 1, 1);
  return days / (span / (B.y - A.y + 1));
}
