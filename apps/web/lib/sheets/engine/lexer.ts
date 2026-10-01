// ============================================================================
//  Formula lexer.
//
//  Tokens keep their source span so a formula can be rewritten token by
//  token (references shifted on paste, rows inserted, …) while everything
//  the person typed between them — spacing, case of function names — is
//  left exactly as it was.
// ============================================================================

import type { ErrorCode } from './types';

export type TokType =
  | 'num' | 'str' | 'bool' | 'err' | 'ident' | 'sheet'
  | 'op' | 'lparen' | 'rparen' | 'comma' | 'semi' | 'lbrace' | 'rbrace' | 'ws';

export interface Token {
  type: TokType;
  /** Exact source text. */
  text: string;
  /** For num: the number. For str: the unescaped string. For sheet: the unquoted name. For err: the code. */
  value?: string | number | boolean;
  start: number;
  end: number;
}

export const ERROR_CODES: ErrorCode[] = [
  '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#ERROR!', '#NULL!',
];

export class LexError extends Error {}

const TWO_CHAR_OPS = ['<>', '<=', '>='];
const ONE_CHAR_OPS = '+-*/^&=<>%:';

/** Tokenise a formula WITHOUT its leading '='. Throws LexError on text it cannot read. */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i]!;
    const start = i;

    if (/\s/.test(ch)) {
      while (i < n && /\s/.test(src[i]!)) i += 1;
      out.push({ type: 'ws', text: src.slice(start, i), start, end: i });
      continue;
    }

    if (ch === '"') {
      i += 1;
      let s = '';
      for (;;) {
        if (i >= n) throw new LexError('A text value is missing its closing quote.');
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ type: 'str', text: src.slice(start, i), value: s, start, end: i });
      continue;
    }

    if (ch === "'") {
      // A quoted sheet name, which must be followed by '!'.
      i += 1;
      let s = '';
      for (;;) {
        if (i >= n) throw new LexError('A sheet name is missing its closing quote.');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      if (src[i] !== '!') throw new LexError(`Expected ! after the sheet name '${s}'.`);
      i += 1;
      out.push({ type: 'sheet', text: src.slice(start, i), value: s, start, end: i });
      continue;
    }

    if (ch === '#') {
      const code = ERROR_CODES.find((c) => src.startsWith(c, i) || src.slice(i, i + c.length).toUpperCase() === c);
      if (!code) throw new LexError('Unknown error value.');
      i += code.length;
      out.push({ type: 'err', text: src.slice(start, i), value: code, start, end: i });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < n && /[0-9]/.test(src[i]!)) i += 1;
      if (src[i] === '.') {
        i += 1;
        while (i < n && /[0-9]/.test(src[i]!)) i += 1;
      }
      if ((src[i] === 'e' || src[i] === 'E') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        const save = i;
        i += 1;
        if (src[i] === '+' || src[i] === '-') i += 1;
        if (/[0-9]/.test(src[i] ?? '')) {
          while (i < n && /[0-9]/.test(src[i]!)) i += 1;
        } else {
          i = save;
        }
      }
      // A number glued to letters is a cell reference in a sheet named like a
      // number? No — but "1A" is simply invalid, so let the parser report it.
      const text = src.slice(start, i);
      out.push({ type: 'num', text, value: Number(text), start, end: i });
      continue;
    }

    if (/[A-Za-z_$\\]/.test(ch) || ch.charCodeAt(0) > 127) {
      while (i < n && (/[A-Za-z0-9_.$\\]/.test(src[i]!) || src[i]!.charCodeAt(0) > 127)) i += 1;
      const text = src.slice(start, i);
      if (src[i] === '!') {
        i += 1;
        out.push({ type: 'sheet', text: src.slice(start, i), value: text, start, end: i });
        continue;
      }
      const upper = text.toUpperCase();
      // TRUE and FALSE are values unless called: TRUE() is a function.
      let j = i;
      while (j < n && /\s/.test(src[j]!)) j += 1;
      if ((upper === 'TRUE' || upper === 'FALSE') && src[j] !== '(') {
        out.push({ type: 'bool', text, value: upper === 'TRUE', start, end: i });
      } else {
        out.push({ type: 'ident', text, start, end: i });
      }
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      i += 2;
      out.push({ type: 'op', text: two, start, end: i });
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      i += 1;
      out.push({ type: 'op', text: ch, start, end: i });
      continue;
    }

    const single: Record<string, TokType> = {
      '(': 'lparen', ')': 'rparen', ',': 'comma', ';': 'semi', '{': 'lbrace', '}': 'rbrace',
    };
    const t = single[ch];
    if (t) {
      i += 1;
      out.push({ type: t, text: ch, start, end: i });
      continue;
    }

    throw new LexError(`Unexpected character "${ch}".`);
  }
  return out;
}
