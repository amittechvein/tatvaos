// ============================================================================
//  Display formats: a value plus a format code → the text a cell shows.
//
//  Format codes are Excel's (and Google Sheets'), so they survive an .xlsx
//  round trip: "#,##0.00", "0%", "dd/mm/yyyy", "₹#,##0", "h:mm AM/PM",
//  up to four sections "positive;negative;zero;text", [Red] colours.
//
//  Grouping follows the workbook's locale, not the code: in an Indian
//  workbook "#,##0" shows 1,25,000, in a western one 125,000. That is how
//  Google Sheets treats locale, and it is what "support Indian number
//  formatting" means in practice — the same file reads correctly in both.
// ============================================================================

import { hmsFromSerial, ymdFromSerial, weekdayFromSerial, MONTHS, DAYS } from './dates';
import { isError, type Locale, type Scalar } from './types';

export interface Formatted {
  text: string;
  /** From a [Red]-style tag in the code. */
  color?: string;
  /** Numbers right-align by default, text left — the grid needs to know which this was. */
  numeric: boolean;
}

const COLOURS: Record<string, string> = {
  red: '#d93025', blue: '#1a73e8', green: '#188038', black: '#000000', white: '#ffffff',
  magenta: '#c5221f', cyan: '#12b5cb', yellow: '#f9ab00',
};

export function formatValue(v: Scalar, code: string | undefined, locale: Locale): Formatted {
  if (v === null) return { text: '', numeric: false };
  if (isError(v)) return { text: v.code, numeric: false };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', numeric: false };

  const sections = code && code !== 'General' ? splitSections(code) : [];

  if (typeof v === 'string') {
    const textSec = sections.length >= 4 ? sections[3] : sections.find((s) => s.includes('@'));
    if (!textSec) return { text: v, numeric: false };
    const { body, color } = stripTags(textSec);
    return { text: literalise(body).replace(/@/g, v), color, numeric: false };
  }

  if (!Number.isFinite(v)) return { text: '#NUM!', numeric: false };
  if (sections.length === 0) return { text: general(v), numeric: true };

  let sec = sections[0]!;
  let n = v;
  let signShownBySection = false;
  if (sections.length >= 2 && v < 0) { sec = sections[1]!; n = -v; signShownBySection = true; }
  else if (sections.length >= 3 && v === 0) { sec = sections[2]!; }

  const { body, color } = stripTags(sec);
  const text = isDateFormat(body)
    ? formatDate(n, body)
    : formatNumber(n, body, locale, signShownBySection);
  return { text, color, numeric: true };
}

// ---------------------------------------------------------------------------

/** "Automatic": integers as they are, fractions to 10 significant digits, huge ones in E notation. */
export function general(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = n.toExponential(5).split('e');
    const mant = m!.replace(/\.?0+$/, '');
    const exp = Number(e);
    return `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(10)));
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === '\\' && !inQuote) { cur += ch + (code[i + 1] ?? ''); i += 1; continue; }
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '[') inBracket = true;
    else if (!inQuote && ch === ']') inBracket = false;
    if (ch === ';' && !inQuote && !inBracket) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Remove [Red] and [$₹-4009]-style tags; keep [h] [m] [s] (elapsed time). */
function stripTags(sec: string): { body: string; color?: string } {
  let color: string | undefined;
  const body = sec.replace(/\[([^\]]*)\]/g, (all, inner: string) => {
    const l = inner.toLowerCase();
    if (COLOURS[l]) { color = COLOURS[l]; return ''; }
    if (/^(h+|m+|s+)$/.test(l)) return all;
    // [$₹-4009] is Excel's currency-with-locale tag: keep the symbol.
    if (inner.startsWith('$')) return `"${inner.slice(1).split('-')[0]}"`;
    return ''; // conditions like [>100] are not supported; ignore rather than print
  });
  return { body, color };
}

/** Turn quoted text and \x escapes into plain characters, dropping _x spacers and *x fills. */
function literalise(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      out += s.slice(i + 1, j < 0 ? undefined : j);
      i = j < 0 ? s.length : j;
    } else if (ch === '\\') { out += s[i + 1] ?? ''; i += 1; }
    else if (ch === '_') { out += ' '; i += 1; }
    else if (ch === '*') { i += 1; }
    else out += ch;
  }
  return out;
}

/** Does this section format a date or time? (d, m, y, h, s outside quotes.) */
export function isDateFormat(sec: string): boolean {
  let inQuote = false;
  for (let i = 0; i < sec.length; i += 1) {
    const ch = sec[i]!;
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (inQuote) continue;
    if (ch === '\\' || ch === '_' || ch === '*') { i += 1; continue; }
    if (/[dmyhsDMYHS]/.test(ch)) return true;
    if (ch === '0' || ch === '#' || ch === '?') {
      // "0" right after seconds is fractional seconds, still a date; elsewhere a number.
      if (!/[sS]\.$/.test(sec.slice(0, i))) return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
//  Numbers
// ---------------------------------------------------------------------------

function groupDigits(digits: string, locale: Locale): string {
  if (digits.length <= 3) return digits;
  if (locale.grouping === 'western') return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

function formatNumber(value: number, body: string, locale: Locale, signShown: boolean): string {
  // Split into: prefix literals, the number pattern, suffix literals.
  // The number pattern is the run from the first placeholder to the last.
  const tokens = tokeniseNumber(body);
  const firstPh = tokens.findIndex((t) => t.ph);
  if (firstPh < 0) {
    // No placeholders at all: the section is pure text ("-" for zero, say).
    return (value < 0 && !signShown ? '-' : '') + tokens.map((t) => t.lit ?? t.raw).join('');
  }

  let pct = 0;
  let sci: { sign: '+' | '-'; digits: number } | null = null;
  const intPh: string[] = [];
  const fracPh: string[] = [];
  let grouping = false;
  let scaleCommas = 0;
  let seenDot = false;
  let lastPh = firstPh;
  tokens.forEach((t, i) => { if (t.ph) lastPh = i; });

  // Commas straight after the last placeholder each divide by 1,000:
  // "#,##0," shows thousands, "#,##0,," millions.
  for (let i = lastPh + 1; tokens[i]?.raw === ','; i += 1) scaleCommas += 1;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.raw === '%') pct += 1;
    if (i < firstPh || i > lastPh + 1) continue;
    if (i === lastPh + 1 && t.raw === ',') continue; // counted above
    if (t.sci) { sci = t.sci; continue; }
    if (sci) continue;
    if (t.raw === '.') { seenDot = true; continue; }
    if (t.raw === ',') {
      // A comma between placeholders groups; commas after the last placeholder scale by 1000.
      const nextPh = tokens.slice(i + 1).some((x, k) => x.ph && i + 1 + k <= lastPh);
      if (nextPh && !seenDot) grouping = true; else if (!nextPh) scaleCommas += 1;
      continue;
    }
    if (t.ph) (seenDot ? fracPh : intPh).push(t.raw);
  }

  const n = Math.abs(value) * 100 ** pct / 1000 ** scaleCommas;
  const neg = value < 0 && !signShown;
  let numText: string;

  if (sci) {
    let exp = n === 0 ? 0 : Math.floor(Math.log10(n));
    const intDigits = Math.max(1, intPh.length);
    exp -= intDigits - 1;
    let mant = n / 10 ** exp;
    const decimals = fracPh.length;
    if (Number(mant.toFixed(decimals)) >= 10 ** intDigits) { mant /= 10; exp += 1; }
    const es = String(Math.abs(exp)).padStart(sci.digits, '0');
    numText = `${mant.toFixed(decimals)}E${exp < 0 ? '-' : sci.sign === '+' ? '+' : ''}${es}`;
  } else {
    const decimals = fracPh.length;
    const fixed = roundHalfUp(n, decimals);
    const [ip, fp = ''] = fixed.split('.');
    let intDigits = ip!;
    const minInt = intPh.filter((p) => p === '0').length;
    if (intDigits === '0' && minInt === 0) intDigits = '';
    intDigits = intDigits.padStart(minInt, '0');
    if (grouping) intDigits = groupDigits(intDigits, locale);
    // Optional decimals (#) drop trailing zeros; ? keeps the width with spaces.
    let frac = fp;
    for (let i = fracPh.length - 1; i >= 0 && frac.endsWith('0'); i -= 1) {
      if (fracPh[i] === '#') frac = frac.slice(0, -1);
      else if (fracPh[i] === '?') frac = `${frac.slice(0, -1)} `;
      else break;
    }
    numText = frac.length > 0 ? `${intDigits}.${frac}` : (seenDot && fracPh.length === 0 ? `${intDigits}.` : intDigits);
    if (numText === '') numText = '0';
  }

  const pre = tokens.slice(0, firstPh).map((t) => t.lit ?? t.raw).join('');
  const post = tokens.slice(lastPh + 1)
    .filter((t) => t.raw !== ',' && t.raw !== '.' && !t.sci)
    .map((t) => t.lit ?? t.raw).join('');
  const out = `${pre}${numText}${post}`;
  return neg ? `-${out}` : out;
}

/** toFixed rounds 1.005 to 1.00; a spreadsheet shows 1.01. */
function roundHalfUp(n: number, decimals: number): string {
  const f = 10 ** decimals;
  const r = Math.round(Number((n * f).toPrecision(15))) / f;
  return r.toFixed(decimals);
}

interface NumTok { raw: string; ph?: boolean; lit?: string; sci?: { sign: '+' | '-'; digits: number } }

function tokeniseNumber(body: string): NumTok[] {
  const out: NumTok[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '"') {
      const j = body.indexOf('"', i + 1);
      const lit = body.slice(i + 1, j < 0 ? undefined : j);
      out.push({ raw: lit, lit });
      i = j < 0 ? body.length : j;
    } else if (ch === '\\') { out.push({ raw: body[i + 1] ?? '', lit: body[i + 1] ?? '' }); i += 1; }
    else if (ch === '_') { out.push({ raw: ' ', lit: ' ' }); i += 1; }
    else if (ch === '*') { i += 1; }
    else if (ch === '0' || ch === '#' || ch === '?') out.push({ raw: ch, ph: true });
    else if ((ch === 'E' || ch === 'e') && (body[i + 1] === '+' || body[i + 1] === '-')) {
      const sign = body[i + 1] as '+' | '-';
      let j = i + 2;
      while (body[j] === '0') j += 1;
      out.push({ raw: body.slice(i, j), sci: { sign, digits: Math.max(1, j - i - 2) } });
      i = j - 1;
    } else out.push({ raw: ch });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Dates and times
// ---------------------------------------------------------------------------

function formatDate(serial: number, body: string): string {
  const { y, m, d } = ymdFromSerial(serial);
  const { h, mi, s, ms } = hmsFromSerial(serial);
  const hasAmPm = /AM\/PM|A\/P/i.test(body);

  // Tokenise first, so the m/mm month-or-minute question can look around.
  type T = { k: string; lit?: string };
  const toks: T[] = [];
  for (let i = 0; i < body.length;) {
    const rest = body.slice(i);
    const ch = body[i]!;
    if (ch === '"') {
      const j = body.indexOf('"', i + 1);
      toks.push({ k: 'lit', lit: body.slice(i + 1, j < 0 ? undefined : j) });
      i = j < 0 ? body.length : j + 1;
      continue;
    }
    if (ch === '\\') { toks.push({ k: 'lit', lit: body[i + 1] ?? '' }); i += 2; continue; }
    if (ch === '_') { toks.push({ k: 'lit', lit: ' ' }); i += 2; continue; }
    if (ch === '*') { i += 2; continue; }
    const am = /^(AM\/PM|am\/pm|A\/P|a\/p)/.exec(rest);
    if (am) { toks.push({ k: am[1]!.length > 3 ? 'ampm' : 'ap' }); i += am[1]!.length; continue; }
    const el = /^\[(h+|m+|s+)\]/i.exec(rest);
    if (el) { toks.push({ k: `[${el[1]!.toLowerCase()[0]}]`, lit: el[1] }); i += el[0].length; continue; }
    const run = /^(y+|m+|d+|h+|s+)/i.exec(rest);
    if (run) { toks.push({ k: run[1]!.toLowerCase() }); i += run[1]!.length; continue; }
    const fr = /^\.(0+)/.exec(rest);
    if (fr && toks.some((t) => t.k.startsWith('s'))) { toks.push({ k: 'frac', lit: fr[1] }); i += fr[0].length; continue; }
    toks.push({ k: 'lit', lit: ch });
    i += 1;
  }

  const isMinute = (idx: number) => {
    // m/mm is minutes right after an hour, or right before seconds.
    for (let j = idx - 1; j >= 0; j -= 1) {
      const k = toks[j]!.k;
      if (k === 'lit') continue;
      if (k.startsWith('h') || k === '[h]') return true;
      break;
    }
    for (let j = idx + 1; j < toks.length; j += 1) {
      const k = toks[j]!.k;
      if (k === 'lit') continue;
      return k.startsWith('s');
    }
    return false;
  };

  const totalSeconds = Math.round(serial * 86_400);
  let out = '';
  toks.forEach((t, idx) => {
    switch (t.k) {
      case 'lit': out += t.lit; break;
      case 'yy': case 'y': out += String(y % 100).padStart(2, '0'); break;
      case 'd': out += d; break;
      case 'dd': out += String(d).padStart(2, '0'); break;
      case 'ddd': out += DAYS[weekdayFromSerial(serial)]!.slice(0, 3); break;
      case 'h': out += hasAmPm ? ((h + 11) % 12) + 1 : h; break;
      case 'hh': out += String(hasAmPm ? ((h + 11) % 12) + 1 : h).padStart(2, '0'); break;
      case 's': out += s; break;
      case 'ss': out += String(s).padStart(2, '0'); break;
      case 'frac': out += (ms / 1000).toFixed(t.lit!.length).slice(1); break;
      case 'ampm': out += h < 12 ? 'AM' : 'PM'; break;
      case 'ap': out += h < 12 ? 'A' : 'P'; break;
      case '[h]': out += String(Math.floor(totalSeconds / 3600)).padStart(t.lit!.length, '0'); break;
      case '[m]': out += String(Math.floor(totalSeconds / 60)).padStart(t.lit!.length, '0'); break;
      case '[s]': out += String(totalSeconds).padStart(t.lit!.length, '0'); break;
      default:
        if (t.k.startsWith('y')) out += y;
        else if (t.k.startsWith('d')) out += DAYS[weekdayFromSerial(serial)];
        else if (t.k.startsWith('h')) out += String(h).padStart(2, '0');
        else if (t.k.startsWith('s')) out += String(s).padStart(2, '0');
        else if (t.k.startsWith('m')) {
          if (t.k.length <= 2 && isMinute(idx)) out += t.k === 'm' ? mi : String(mi).padStart(2, '0');
          else if (t.k === 'm') out += m;
          else if (t.k === 'mm') out += String(m).padStart(2, '0');
          else if (t.k === 'mmm') out += MONTHS[m - 1]!.slice(0, 3);
          else if (t.k === 'mmmmm') out += MONTHS[m - 1]![0];
          else out += MONTHS[m - 1];
        }
    }
  });
  return out;
}
