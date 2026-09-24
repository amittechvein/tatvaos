// ============================================================================
//  Text: joining, cutting, finding, changing case, formatting as text,
//  and the three REGEX functions Google Sheets adds.
//
//  Positions are 1-based and count UTF-16 units, as JavaScript strings do.
//  A Hindi letter with a vowel sign is two characters here, as it is in
//  Sheets and Excel.
// ============================================================================

import { isError, type EvalResult, type Scalar } from '../types';
import { toNumber, toText, clip } from '../values';
import { formatValue } from '../format';
import { parseNumberText } from '../input';
import { flatten, num, int, text, bool, NA, VALUE } from './helpers';
import type { FnDef, FnContext } from './index';

/** Sheets refuses to build a text longer than this. */
const MAX_TEXT = 50_000;

/** Every argument joined end to end; ranges contribute every cell, row by row. */
function joinAll(args: EvalResult[], ctx: FnContext): string | EvalResult {
  let out = '';
  for (const v of flatten(args, ctx)) {
    const t = toText(v);
    if (isError(t)) return t;
    out += t;
  }
  return out.length > MAX_TEXT ? VALUE(`Text result is longer than the limit of ${MAX_TEXT.toLocaleString('en-US')} characters.`) : out;
}

/** Wildcard search pattern (* ? ~) as a regular expression that may match anywhere. */
function searchRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '~' && (pattern[i + 1] === '*' || pattern[i + 1] === '?' || pattern[i + 1] === '~')) {
      re += `\\${pattern[i + 1]}`;
      i += 1;
    } else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  }
  return new RegExp(re, 'gi');
}

/**
 * A Sheets (RE2) pattern as a JavaScript RegExp. RE2's leading inline flags
 * — (?i) for "ignore case" is the one people actually type — become flags.
 */
function regex(pattern: string, fnName: string, global: boolean): RegExp | EvalResult {
  let src = pattern;
  let flags = global ? 'g' : '';
  const lead = /^\(\?([imsU]+)\)/.exec(src);
  if (lead) {
    for (const f of lead[1]!) if (f !== 'U' && !flags.includes(f)) flags += f;
    src = src.slice(lead[0].length);
  }
  try {
    return new RegExp(src, flags);
  } catch {
    return VALUE(`Function ${fnName} parameter 2 value "${clip(pattern)}" is not a valid regular expression.`);
  }
}

/** The REGEX functions want text: a number or TRUE is an error, as in Sheets. */
function regexText(v: EvalResult, ctx: FnContext, fnName: string, param: number): string | EvalResult {
  const s = ctx.scalar(v);
  if (isError(s)) return s;
  if (s === null) return '';
  if (typeof s !== 'string') {
    const shown = typeof s === 'boolean' ? (s ? 'TRUE' : 'FALSE') : String(s);
    return VALUE(`Function ${fnName} parameter ${param} expects text values. But '${shown}' is a ${typeof s === 'boolean' ? 'boolean' : 'number'} and cannot be coerced to a text.`);
  }
  return s;
}

/** A number as text with grouping and fixed decimals — shared by FIXED and DOLLAR. */
function fixedText(n: number, decimals: number, grouped: boolean, prefix: string, ctx: FnContext): string {
  // Negative decimals round to tens, hundreds…: FIXED(1234.5, -2) is "1,200".
  let v = n;
  let d = decimals;
  if (d < 0) {
    const f = 10 ** -d;
    v = Math.sign(n) * Math.round(Math.abs(n) / f) * f;
    d = 0;
  }
  d = Math.min(d, 127);
  const code = `${prefix}${grouped ? '#,##0' : '0'}${d > 0 ? `.${'0'.repeat(d)}` : ''}`;
  return formatValue(v, code, ctx.locale).text;
}

export const TEXT: Record<string, FnDef> = {
  CONCATENATE: {
    min: 1, max: Infinity, category: 'Text', sig: 'CONCATENATE(text1, [text2, …])',
    desc: 'Joins text end to end; a range joins every cell in it.',
    fn: (a, ctx) => joinAll(a.all(), ctx),
  },
  CONCAT: {
    // Sheets takes exactly two; Excel takes any number. Accepting more costs nothing.
    min: 1, max: Infinity, category: 'Text', sig: 'CONCAT(value1, value2)',
    desc: 'Joins two values end to end.',
    fn: (a, ctx) => joinAll(a.all(), ctx),
  },
  TEXTJOIN: {
    min: 3, max: Infinity, category: 'Text', sig: 'TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])',
    desc: 'Joins text with a separator between each piece, optionally skipping empty cells.',
    fn: (a, ctx) => {
      const delim = text(a.get(0), ctx); if (isError(delim)) return delim;
      const skip = bool(a.get(1), ctx); if (isError(skip)) return skip;
      const parts: string[] = [];
      const rest: EvalResult[] = [];
      for (let i = 2; i < a.length; i += 1) rest.push(a.get(i));
      for (const v of flatten(rest, ctx)) {
        const t = toText(v);
        if (isError(t)) return t;
        if (skip && t === '') continue;
        parts.push(t);
      }
      const out = parts.join(delim);
      return out.length > MAX_TEXT ? VALUE(`Text result of TEXTJOIN is longer than the limit of ${MAX_TEXT.toLocaleString('en-US')} characters.`) : out;
    },
  },
  LEFT: {
    min: 1, max: 2, category: 'Text', sig: 'LEFT(text, [number_of_characters])',
    desc: 'The first characters of the text; one if the count is left out.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const n = a.missing(1) ? 1 : int(a.get(1), ctx); if (isError(n)) return n;
      if (n < 0) return VALUE('LEFT cannot take a negative number of characters.');
      return s.slice(0, n);
    },
  },
  RIGHT: {
    min: 1, max: 2, category: 'Text', sig: 'RIGHT(text, [number_of_characters])',
    desc: 'The last characters of the text; one if the count is left out.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const n = a.missing(1) ? 1 : int(a.get(1), ctx); if (isError(n)) return n;
      if (n < 0) return VALUE('RIGHT cannot take a negative number of characters.');
      return n === 0 ? '' : s.slice(Math.max(0, s.length - n));
    },
  },
  MID: {
    min: 3, max: 3, category: 'Text', sig: 'MID(text, start, number_of_characters)',
    desc: 'Characters from the middle of the text, starting at a position.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const start = int(a.get(1), ctx); if (isError(start)) return start;
      const n = int(a.get(2), ctx); if (isError(n)) return n;
      if (start < 1) return VALUE('MID starts at position 1 or later.');
      if (n < 0) return VALUE('MID cannot take a negative number of characters.');
      return s.slice(start - 1, start - 1 + n);
    },
  },
  LEN: {
    min: 1, max: 1, category: 'Text', sig: 'LEN(text)', desc: 'How many characters the text has.',
    fn: (a, ctx) => { const s = text(a.get(0), ctx); return isError(s) ? s : s.length; },
  },
  LOWER: {
    min: 1, max: 1, category: 'Text', sig: 'LOWER(text)', desc: 'The text in lower case.',
    fn: (a, ctx) => { const s = text(a.get(0), ctx); return isError(s) ? s : s.toLowerCase(); },
  },
  UPPER: {
    min: 1, max: 1, category: 'Text', sig: 'UPPER(text)', desc: 'The text in capitals.',
    fn: (a, ctx) => { const s = text(a.get(0), ctx); return isError(s) ? s : s.toUpperCase(); },
  },
  PROPER: {
    min: 1, max: 1, category: 'Text', sig: 'PROPER(text)',
    desc: 'Each word starts with a capital: "ravi KUMAR" becomes "Ravi Kumar".',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      // A letter after a letter is lower case; after anything else (a space,
      // a digit, an apostrophe) it is a capital — so "it's" becomes "It'S",
      // exactly as Sheets and Excel do it.
      let out = '';
      let prevLetter = false;
      for (const ch of s) {
        const letter = /[\p{L}\p{M}]/u.test(ch);
        out += letter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch;
        prevLetter = letter;
      }
      return out;
    },
  },
  TRIM: {
    min: 1, max: 1, category: 'Text', sig: 'TRIM(text)',
    desc: 'Removes spaces at the start and end, and runs of spaces inside, leaving one.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx);
      return isError(s) ? s : s.replace(/ {2,}/g, ' ').replace(/^ | $/g, '');
    },
  },
  CLEAN: {
    min: 1, max: 1, category: 'Text', sig: 'CLEAN(text)',
    desc: 'Removes characters that cannot be printed, such as line breaks pasted from another program.',
     
    fn: (a, ctx) => { const s = text(a.get(0), ctx); return isError(s) ? s : s.replace(/[\x00-\x1f]/g, ''); },
  },
  SUBSTITUTE: {
    min: 3, max: 4, category: 'Text', sig: 'SUBSTITUTE(text, search_for, replace_with, [occurrence])',
    desc: 'Replaces some text with other text — every time, or only the nth time.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const find = text(a.get(1), ctx); if (isError(find)) return find;
      const repl = text(a.get(2), ctx); if (isError(repl)) return repl;
      if (find === '') return s;
      if (a.missing(3)) return s.split(find).join(repl);
      const nth = int(a.get(3), ctx); if (isError(nth)) return nth;
      if (nth < 1) return VALUE('SUBSTITUTE occurrence must be 1 or more.');
      let at = -1;
      for (let k = 0; k < nth; k += 1) {
        at = s.indexOf(find, at + (k === 0 ? 0 : find.length));
        if (at < 0) return s;
      }
      return s.slice(0, at) + repl + s.slice(at + find.length);
    },
  },
  REPLACE: {
    min: 4, max: 4, category: 'Text', sig: 'REPLACE(text, position, length, new_text)',
    desc: 'Replaces a number of characters at a position with new text.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const pos = int(a.get(1), ctx); if (isError(pos)) return pos;
      const n = int(a.get(2), ctx); if (isError(n)) return n;
      const repl = text(a.get(3), ctx); if (isError(repl)) return repl;
      if (pos < 1) return VALUE('REPLACE position must be 1 or more.');
      if (n < 0) return VALUE('REPLACE length cannot be negative.');
      return s.slice(0, pos - 1) + repl + s.slice(pos - 1 + n);
    },
  },
  FIND: {
    min: 2, max: 3, category: 'Text', sig: 'FIND(search_for, text_to_search, [starting_at])',
    desc: 'The position of text inside other text, matching capitals exactly.',
    fn: (a, ctx) => {
      const find = text(a.get(0), ctx); if (isError(find)) return find;
      const s = text(a.get(1), ctx); if (isError(s)) return s;
      const start = a.missing(2) ? 1 : int(a.get(2), ctx); if (isError(start)) return start;
      if (start < 1 || start > s.length + 1) return VALUE(`FIND starting position ${start} is outside the text.`);
      const at = s.indexOf(find, start - 1);
      return at < 0 ? VALUE(`FIND could not find "${clip(find)}" in "${clip(s)}".`) : at + 1;
    },
  },
  SEARCH: {
    min: 2, max: 3, category: 'Text', sig: 'SEARCH(search_for, text_to_search, [starting_at])',
    desc: 'The position of text inside other text, ignoring capitals; * and ? are wildcards.',
    fn: (a, ctx) => {
      const find = text(a.get(0), ctx); if (isError(find)) return find;
      const s = text(a.get(1), ctx); if (isError(s)) return s;
      const start = a.missing(2) ? 1 : int(a.get(2), ctx); if (isError(start)) return start;
      if (start < 1 || start > s.length + 1) return VALUE(`SEARCH starting position ${start} is outside the text.`);
      const re = searchRegex(find);
      re.lastIndex = start - 1;
      const m = re.exec(s);
      return m ? m.index + 1 : VALUE(`SEARCH could not find "${clip(find)}" in "${clip(s)}".`);
    },
  },
  TEXT: {
    min: 2, max: 2, category: 'Text', sig: 'TEXT(number, format)',
    desc: 'A number shown as text in a format: TEXT(A1, "dd/mm/yyyy"), TEXT(A1, "#,##0.00").',
    fn: (a, ctx) => {
      let v: Scalar = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      const code = text(a.get(1), ctx); if (isError(code)) return code;
      // Text that reads as a number is formatted as that number, as in Sheets.
      if (typeof v === 'string') {
        const n = parseNumberText(v, ctx.locale);
        if (n !== null) v = n;
      }
      if (v === null) v = 0;
      return formatValue(v, code === '' ? undefined : code, ctx.locale).text;
    },
  },
  VALUE: {
    min: 1, max: 1, category: 'Text', sig: 'VALUE(text)',
    desc: 'Text that looks like a number, date or time, as that number.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (typeof v !== 'string') return toNumber(v, ctx.locale);
      if (v.trim() === '') return 0;
      const n = parseNumberText(v, ctx.locale);
      return n === null ? VALUE(`VALUE parameter '${clip(v)}' cannot be read as a number.`) : n;
    },
  },
  REPT: {
    min: 2, max: 2, category: 'Text', sig: 'REPT(text, number_of_times)', desc: 'The text repeated a number of times.',
    fn: (a, ctx) => {
      const s = text(a.get(0), ctx); if (isError(s)) return s;
      const n = int(a.get(1), ctx); if (isError(n)) return n;
      if (n < 0) return VALUE('REPT cannot repeat a negative number of times.');
      if (s.length * n > MAX_TEXT) return VALUE(`Text result of REPT is longer than the limit of ${MAX_TEXT.toLocaleString('en-US')} characters.`);
      return s.repeat(n);
    },
  },
  EXACT: {
    min: 2, max: 2, category: 'Text', sig: 'EXACT(text1, text2)',
    desc: 'TRUE when two texts are identical, capitals included.',
    fn: (a, ctx) => {
      const x = text(a.get(0), ctx); if (isError(x)) return x;
      const y = text(a.get(1), ctx); if (isError(y)) return y;
      return x === y;
    },
  },
  CHAR: {
    min: 1, max: 1, category: 'Text', sig: 'CHAR(number)', desc: 'The character with this Unicode number: CHAR(65) is "A".',
    fn: (a, ctx) => charOf(a.get(0), ctx, 'CHAR'),
  },
  UNICHAR: {
    min: 1, max: 1, category: 'Text', sig: 'UNICHAR(number)', desc: 'The character with this Unicode number.',
    fn: (a, ctx) => charOf(a.get(0), ctx, 'UNICHAR'),
  },
  CODE: {
    min: 1, max: 1, category: 'Text', sig: 'CODE(text)', desc: 'The Unicode number of the first character.',
    fn: (a, ctx) => codeOf(a.get(0), ctx, 'CODE'),
  },
  UNICODE: {
    min: 1, max: 1, category: 'Text', sig: 'UNICODE(text)', desc: 'The Unicode number of the first character.',
    fn: (a, ctx) => codeOf(a.get(0), ctx, 'UNICODE'),
  },
  T: {
    min: 1, max: 1, category: 'Text', sig: 'T(value)', desc: 'The value if it is text; otherwise empty text.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      return typeof v === 'string' ? v : '';
    },
  },
  FIXED: {
    min: 1, max: 3, category: 'Text', sig: 'FIXED(number, [decimals], [no_commas])',
    desc: 'A number as text, rounded to fixed decimals, with or without commas.',
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 2 : int(a.get(1), ctx); if (isError(d)) return d;
      const noCommas = a.missing(2) ? false : bool(a.get(2), ctx); if (isError(noCommas)) return noCommas;
      return fixedText(n, d, !noCommas, '', ctx);
    },
  },
  DOLLAR: {
    min: 1, max: 2, category: 'Text', sig: 'DOLLAR(number, [decimals])',
    desc: "A number as currency text, in the workbook's currency: ₹1,25,000.00.",
    fn: (a, ctx) => {
      const n = num(a.get(0), ctx); if (isError(n)) return n;
      const d = a.missing(1) ? 2 : int(a.get(1), ctx); if (isError(d)) return d;
      // Quoted, so a currency symbol can never be read as a format character.
      return fixedText(n, d, true, `"${ctx.locale.currency.replace(/"/g, '')}"`, ctx);
    },
  },
  REGEXMATCH: {
    min: 2, max: 2, category: 'Text', sig: 'REGEXMATCH(text, regular_expression)',
    desc: 'TRUE when the text matches a regular expression anywhere in it.',
    fn: (a, ctx) => {
      const s = regexText(a.get(0), ctx, 'REGEXMATCH', 1); if (typeof s !== 'string') return s;
      const p = regexText(a.get(1), ctx, 'REGEXMATCH', 2); if (typeof p !== 'string') return p;
      const re = regex(p, 'REGEXMATCH', false); if (!(re instanceof RegExp)) return re;
      return re.test(s);
    },
  },
  REGEXEXTRACT: {
    min: 2, max: 2, category: 'Text', sig: 'REGEXEXTRACT(text, regular_expression)',
    desc: 'The part of the text that matches — or, if the expression has a (group), what the first group matched.',
    fn: (a, ctx) => {
      const s = regexText(a.get(0), ctx, 'REGEXEXTRACT', 1); if (typeof s !== 'string') return s;
      const p = regexText(a.get(1), ctx, 'REGEXEXTRACT', 2); if (typeof p !== 'string') return p;
      const re = regex(p, 'REGEXEXTRACT', false); if (!(re instanceof RegExp)) return re;
      const m = re.exec(s);
      if (!m) return NA(`REGEXEXTRACT found no match for "${clip(p)}" in "${clip(s)}".`);
      // Several groups fill several cells in Sheets; until results can spill, the first group.
      return m.length > 1 ? (m[1] ?? '') : m[0];
    },
  },
  REGEXREPLACE: {
    min: 3, max: 3, category: 'Text', sig: 'REGEXREPLACE(text, regular_expression, replacement)',
    desc: 'Replaces every match of a regular expression; $1 in the replacement is the first group.',
    fn: (a, ctx) => {
      const s = regexText(a.get(0), ctx, 'REGEXREPLACE', 1); if (typeof s !== 'string') return s;
      const p = regexText(a.get(1), ctx, 'REGEXREPLACE', 2); if (typeof p !== 'string') return p;
      const r = regexText(a.get(2), ctx, 'REGEXREPLACE', 3); if (typeof r !== 'string') return r;
      const re = regex(p, 'REGEXREPLACE', true); if (!(re instanceof RegExp)) return re;
      return s.replace(re, r);
    },
  },
};

function charOf(v: EvalResult, ctx: FnContext, fnName: string): EvalResult {
  const n = int(v, ctx); if (isError(n)) return n;
  if (n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return VALUE(`${fnName} parameter ${n} is not a valid character number.`);
  }
  return String.fromCodePoint(n);
}

function codeOf(v: EvalResult, ctx: FnContext, fnName: string): EvalResult {
  const s = text(v, ctx); if (isError(s)) return s;
  if (s === '') return VALUE(`${fnName} needs at least one character.`);
  return s.codePointAt(0)!;
}
