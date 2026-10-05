// ============================================================================
//  Dates as numbers.
//
//  A date is a serial number of days since 30 December 1899, and a time is
//  the fraction of a day — the convention Google Sheets and Excel share, so
//  a date survives an .xlsx round trip unchanged. (Excel's fictional
//  29 February 1900 makes its serials before 1 March 1900 differ by one;
//  nobody's fee register reaches back that far.)
//
//  All arithmetic is in UTC on purpose: a serial has no time zone, and doing
//  it in local time would shift dates across a daylight-saving change.
//  "Today" is the one place local time matters — see localNowSerial.
// ============================================================================

const MS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(1899, 11, 30);

/** DATE(y, m, d): months and days may overflow either way, as in a spreadsheet. */
export function serialFromYmd(y: number, m: number, d: number): number {
  // Two-digit years: 0-1899 are added to 1900, as Sheets and Excel do.
  const year = y >= 0 && y < 1900 ? y + 1900 : y;
  return Math.round((Date.UTC(year, m - 1, 1) - EPOCH_MS) / MS_PER_DAY) + (d - 1);
}

export interface Ymd { y: number; m: number; d: number }

export function ymdFromSerial(serial: number): Ymd {
  const dt = new Date(EPOCH_MS + Math.floor(serial) * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayFromSerial(serial: number): number {
  return new Date(EPOCH_MS + Math.floor(serial) * MS_PER_DAY).getUTCDay();
}

export interface Hms { h: number; mi: number; s: number; ms: number }

export function hmsFromSerial(serial: number): Hms {
  // Round to the millisecond first so 0.5 of a day is 12:00:00, not 11:59:59.999.
  let ms = Math.round((serial - Math.floor(serial)) * MS_PER_DAY);
  if (ms >= MS_PER_DAY) ms = MS_PER_DAY - 1;
  const h = Math.floor(ms / 3_600_000);
  const mi = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return { h, mi, s, ms: ms % 1000 };
}

export function serialFromHms(h: number, mi: number, s: number): number {
  return (h * 3600 + mi * 60 + s) / 86_400;
}

/** The person's wall-clock now, as a serial. Local time is what "today" means to them. */
export function localNowSerial(now: Date): number {
  const days = serialFromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return days + serialFromHms(now.getHours(), now.getMinutes(), now.getSeconds() + now.getMilliseconds() / 1000);
}

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
