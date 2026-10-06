// ============================================================================
//  Formula parser: tokens → tree.
//
//  Precedence, lowest first (Excel's, which Google Sheets follows):
//
//    = <> < > <= >=      comparison
//    &                   join text
//    + -                 add, subtract
//    * /                 multiply, divide
//    ^                   power (left to right: 2^3^2 = 64)
//    %                   percent (postfix)
//    - +                 sign — tighter than ^, so -2^2 = 4
//    :                   range (A1:B5), only between references
// ============================================================================

import { MAX_COLS, MAX_ROWS, colIndex, parseCell } from './address';
import { lex, type Token } from './lexer';
import type { ErrorCode } from './types';

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrorCode }
  | RefNode
  | { t: 'name'; name: string }
  | { t: 'fn'; name: string; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: '-' | '+'; e: Node }
  | { t: 'pct'; e: Node }
  | { t: 'arr'; rows: Node[][] }
  | { t: 'missing' };

/**
 * A reference. sheet is the NAME as written (null = the formula's own
 * sheet); the evaluator resolves it. Whole columns (A:A) and whole rows
 * (3:3) are ranges running to the sheet's limit, clamped when read.
 */
export interface RefNode {
  t: 'ref';
  sheet: string | null;
  r1: number; c1: number; r2: number; c2: number;
}

export class ParseError extends Error {}

/** Function names as stored in .xlsx files carry these; the function is the same. */
export function normaliseFnName(name: string): string {
  return name.toUpperCase().replace(/^_XLFN\./, '').replace(/^_XLWS\./, '');
}

/** Parse a formula's text WITHOUT the leading '='. Throws ParseError. */
export function parseFormula(src: string): Node {
  let toks: Token[];
  try {
    toks = lex(src).filter((t) => t.type !== 'ws');
  } catch (e) {
    throw new ParseError(e instanceof Error ? e.message : 'Formula parse error.');
  }
  if (toks.length === 0) throw new ParseError('The formula is empty.');
  const p = new Parser(toks);
  const node = p.expression();
  if (!p.done()) throw new ParseError(`Unexpected "${p.peek()?.text}".`);
  return node;
}

type Piece =
  | { kind: 'cell'; row: number; col: number }
  | { kind: 'col'; col: number }
  | { kind: 'row'; row: number };

const COL_ONLY = /^\$?([A-Za-z]{1,3})$/;
const ROW_ONLY = /^\$?([0-9]{1,7})$/;

/** Read one end of a reference from a token's text, or null. */
function pieceOf(tok: Token): Piece | null {
  if (tok.type === 'ident') {
    const cell = parseCell(tok.text);
    if (cell) return { kind: 'cell', row: cell.row, col: cell.col };
    const c = COL_ONLY.exec(tok.text);
    if (c) {
      const col = colIndex(c[1]!);
      return col >= 0 && col < MAX_COLS ? { kind: 'col', col } : null;
    }
    const r = ROW_ONLY.exec(tok.text);
    if (r) {
      const row = Number(r[1]) - 1;
      return row >= 0 && row < MAX_ROWS ? { kind: 'row', row } : null;
    }
    return null;
  }
  if (tok.type === 'num' && /^[0-9]{1,7}$/.test(tok.text)) {
    const row = Number(tok.text) - 1;
    return row >= 0 && row < MAX_ROWS ? { kind: 'row', row } : null;
  }
  return null;
}

class Parser {
  private i = 0;
  private readonly toks: Token[];
  constructor(toks: Token[]) { this.toks = toks; }

  done() { return this.i >= this.toks.length; }
  peek(o = 0): Token | undefined { return this.toks[this.i + o]; }
  private next(): Token {
    const t = this.toks[this.i];
    if (!t) throw new ParseError('The formula ends too early.');
    this.i += 1;
    return t;
  }
  private isOp(...ops: string[]) {
    const t = this.peek();
    return t?.type === 'op' && ops.includes(t.text);
  }

  expression(): Node { return this.comparison(); }

  private comparison(): Node {
    let l = this.concat();
    while (this.isOp('=', '<>', '<', '>', '<=', '>=')) {
      const op = this.next().text;
      l = { t: 'bin', op, l, r: this.concat() };
    }
    return l;
  }

  private concat(): Node {
    let l = this.additive();
    while (this.isOp('&')) {
      this.next();
      l = { t: 'bin', op: '&', l, r: this.additive() };
    }
    return l;
  }

  private additive(): Node {
    let l = this.multiplicative();
    while (this.isOp('+', '-')) {
      const op = this.next().text;
      l = { t: 'bin', op, l, r: this.multiplicative() };
    }
    return l;
  }

  private multiplicative(): Node {
    let l = this.power();
    while (this.isOp('*', '/')) {
      const op = this.next().text;
      l = { t: 'bin', op, l, r: this.power() };
    }
    return l;
  }

  private power(): Node {
    let l = this.percent();
    while (this.isOp('^')) {
      this.next();
      l = { t: 'bin', op: '^', l, r: this.percent() };
    }
    return l;
  }

  private percent(): Node {
    let e = this.unary();
    while (this.isOp('%')) {
      this.next();
      e = { t: 'pct', e };
    }
    return e;
  }

  private unary(): Node {
    if (this.isOp('-', '+')) {
      const op = this.next().text as '-' | '+';
      return { t: 'un', op, e: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new ParseError('The formula ends too early.');

    switch (t.type) {
      case 'str': this.next(); return { t: 'str', v: t.value as string };
      case 'bool': this.next(); return { t: 'bool', v: t.value as boolean };
      case 'err': this.next(); return { t: 'err', v: t.value as ErrorCode };
      case 'lparen': {
        this.next();
        const e = this.expression();
        if (this.peek()?.type !== 'rparen') throw new ParseError('A bracket is not closed.');
        this.next();
        return e;
      }
      case 'lbrace': return this.arrayLiteral();
      case 'sheet': {
        this.next();
        const ref = this.reference(t.value as string);
        if (!ref) throw new ParseError(`Expected a cell or range after ${t.text}.`);
        return ref;
      }
      case 'num': {
        // "3:5" is a range of whole rows; any other number is a number.
        if (this.peek(1)?.type === 'op' && this.peek(1)?.text === ':') {
          const ref = this.reference(null);
          if (ref) return ref;
        }
        this.next();
        return { t: 'num', v: t.value as number };
      }
      case 'ident': {
        if (this.peek(1)?.type === 'lparen') return this.call();
        const ref = this.reference(null);
        if (ref) return ref;
        this.next();
        return { t: 'name', name: t.text };
      }
      default:
        throw new ParseError(`Unexpected "${t.text}".`);
    }
  }

  /** A cell, or a range of cells / whole columns / whole rows. Leaves the position alone on null. */
  private reference(sheet: string | null): RefNode | null {
    const save = this.i;
    const first = this.peek();
    const a = first ? pieceOf(first) : null;
    if (!a) { this.i = save; return null; }
    this.next();

    if (this.isOp(':')) {
      const colon = this.i;
      this.next();
      // A sheet prefix on the second end ("Sheet1!A1:Sheet1!B2") is allowed
      // when it names the same sheet.
      const sec = this.peek();
      if (sec?.type === 'sheet') {
        if (sheet === null || (sec.value as string).toLowerCase() !== sheet.toLowerCase()) {
          throw new ParseError('A range must stay on one sheet.');
        }
        this.next();
      }
      const bt = this.peek();
      const b = bt ? pieceOf(bt) : null;
      if (b && b.kind === a.kind) {
        this.next();
        return rangeNode(sheet, a, b);
      }
      // Not a range after all ("A1:" followed by something else).
      this.i = colon;
    }

    if (a.kind !== 'cell') { this.i = save; return null; }
    return { t: 'ref', sheet, r1: a.row, c1: a.col, r2: a.row, c2: a.col };
  }

  private call(): Node {
    const name = normaliseFnName(this.next().text);
    this.next(); // (
    const args: Node[] = [];
    if (this.peek()?.type === 'rparen') {
      this.next();
      return { t: 'fn', name, args };
    }
    for (;;) {
      const t = this.peek();
      if (t?.type === 'comma' || t?.type === 'rparen') {
        args.push({ t: 'missing' });
      } else {
        args.push(this.expression());
      }
      const sep = this.peek();
      if (sep?.type === 'comma') { this.next(); continue; }
      if (sep?.type === 'rparen') { this.next(); break; }
      throw new ParseError(`Expected , or ) in ${name}(…).`);
    }
    return { t: 'fn', name, args };
  }

  private arrayLiteral(): Node {
    this.next(); // {
    const rows: Node[][] = [[]];
    for (;;) {
      const neg = this.isOp('-');
      if (neg) this.next();
      const t = this.next();
      let v: Node;
      if (t.type === 'num') v = { t: 'num', v: (neg ? -1 : 1) * (t.value as number) };
      else if (!neg && t.type === 'str') v = { t: 'str', v: t.value as string };
      else if (!neg && t.type === 'bool') v = { t: 'bool', v: t.value as boolean };
      else if (!neg && t.type === 'err') v = { t: 'err', v: t.value as ErrorCode };
      else throw new ParseError('An array can hold only numbers, text, TRUE/FALSE and errors.');
      rows[rows.length - 1]!.push(v);

      const sep = this.next();
      if (sep.type === 'comma') continue;
      if (sep.type === 'semi') { rows.push([]); continue; }
      if (sep.type === 'rbrace') break;
      throw new ParseError('Expected , ; or } in an array.');
    }
    const w = rows[0]!.length;
    if (rows.some((r) => r.length !== w)) throw new ParseError('Every row of an array must be the same length.');
    return { t: 'arr', rows };
  }
}

function rangeNode(sheet: string | null, a: Piece, b: Piece): RefNode {
  if (a.kind === 'cell' && b.kind === 'cell') {
    return {
      t: 'ref', sheet,
      r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
      r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
    };
  }
  if (a.kind === 'col' && b.kind === 'col') {
    return { t: 'ref', sheet, r1: 0, r2: MAX_ROWS - 1, c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) };
  }
  if (a.kind === 'row' && b.kind === 'row') {
    return { t: 'ref', sheet, c1: 0, c2: MAX_COLS - 1, r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row) };
  }
  throw new ParseError('Both ends of a range must be the same kind.');
}
