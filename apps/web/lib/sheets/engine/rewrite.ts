// ============================================================================
//  Rewriting formulas when the grid moves under them.
//
//    translate  — a formula copied from B2 to C5 moves its relative
//                 references with it: =A1 becomes =B4, =$A$1 stays.
//    shift      — rows or columns inserted or deleted: every reference past
//                 the change moves; a reference to a deleted cell becomes
//                 #REF!, a range that loses some rows shrinks.
//    renameSheet — Fees!A1 becomes 'Fees 2026'!A1 in every formula.
//
//  All three work on the TOKENS of the formula text and replace only the
//  reference tokens, so everything else the person typed — spacing, the
//  case of function names, text in quotes — comes back exactly as it was.
//  A formula that does not lex is returned unchanged: it is already an
//  error, and rewriting would only hide what was typed.
// ============================================================================

import { MAX_COLS, MAX_ROWS, colIndex, colName, parseCell, quoteSheet } from './address';
import { lex, type Token } from './lexer';

type Kind = 'cell' | 'col' | 'row';
interface Piece { kind: Kind; row: number; col: number; rowAbs: boolean; colAbs: boolean }

const COL_ONLY = /^(\$?)([A-Za-z]{1,3})$/;
const ROW_ONLY = /^(\$?)([0-9]{1,7})$/;

function readPiece(t: Token): Piece | null {
  if (t.type === 'ident') {
    const c = parseCell(t.text);
    if (c) return { kind: 'cell', ...c };
    const m = COL_ONLY.exec(t.text);
    if (m) return { kind: 'col', row: 0, col: colIndex(m[2]!), rowAbs: false, colAbs: m[1] === '$' };
    const r = ROW_ONLY.exec(t.text);
    if (r) return { kind: 'row', row: Number(r[2]) - 1, col: 0, rowAbs: r[1] === '$', colAbs: false };
  }
  if (t.type === 'num' && /^[0-9]{1,7}$/.test(t.text)) {
    return { kind: 'row', row: Number(t.text) - 1, col: 0, rowAbs: false, colAbs: false };
  }
  return null;
}

function writePiece(p: Piece): string {
  const c = `${p.colAbs ? '$' : ''}${colName(p.col)}`;
  const r = `${p.rowAbs ? '$' : ''}${p.row + 1}`;
  return p.kind === 'cell' ? c + r : p.kind === 'col' ? c : r;
}

/** One reference in the formula: a single piece, or two joined by ':'. */
interface RefSpan {
  sheet: string | null;       // name as written, unquoted
  sheetTok: Token | null;
  a: Piece; aTok: Token;
  b: Piece | null; bTok: Token | null;
}

/**
 * Find the references in a token list. A lone column or row piece ("A",
 * "3") is not a reference — only as half of A:A or 3:5. A piece followed
 * by '(' is a function name (LOG10 looks like a cell).
 */
function findRefs(toks: Token[]): RefSpan[] {
  const out: RefSpan[] = [];
  const sig = toks.map((t, i) => ({ t, i })).filter((x) => x.t.type !== 'ws');
  for (let k = 0; k < sig.length; k += 1) {
    const cur = sig[k]!.t;
    let sheetTok: Token | null = null;
    let at = k;
    if (cur.type === 'sheet') { sheetTok = cur; at = k + 1; }
    const aTok = sig[at]?.t;
    if (!aTok) continue;
    if (sig[at + 1]?.t.type === 'lparen') continue;
    const a = readPiece(aTok);
    if (!a) continue;
    // A num token that is not part of a row range is just a number.
    let b: Piece | null = null;
    let bTok: Token | null = null;
    const colon = sig[at + 1]?.t;
    if (colon?.type === 'op' && colon.text === ':') {
      let bi = at + 2;
      if (sig[bi]?.t.type === 'sheet') bi += 1;
      const cand = sig[bi]?.t;
      const pb = cand ? readPiece(cand) : null;
      if (pb && pb.kind === a.kind) { b = pb; bTok = cand!; }
    }
    if (!b && a.kind !== 'cell') continue;
    if (aTok.type === 'num' && !b) continue;
    out.push({ sheet: sheetTok ? (sheetTok.value as string) : null, sheetTok, a, aTok, b, bTok });
    k = b ? sig.findIndex((x) => x.t === bTok) : at;
  }
  return out;
}

/** Apply replacements (by token) to the source text. */
function splice(src: string, edits: { tok: Token; text: string }[]): string {
  edits.sort((x, y) => y.tok.start - x.tok.start);
  let s = src;
  for (const e of edits) s = s.slice(0, e.tok.start) + e.text + s.slice(e.tok.end);
  return s;
}

function withFormula(input: string, fn: (body: string, toks: Token[]) => string): string {
  if (!input.startsWith('=')) return input;
  const body = input.slice(1);
  let toks: Token[];
  try { toks = lex(body); } catch { return input; }
  return `=${fn(body, toks)}`;
}

// ---------------------------------------------------------------------------

/** Copy/paste and fill: move relative references by (dRow, dCol). Off the grid → #REF!. */
export function translateFormula(input: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return input;
  return withFormula(input, (body, toks) => {
    const edits: { tok: Token; text: string }[] = [];
    for (const ref of findRefs(toks)) {
      const move = (p: Piece): Piece | null => {
        const q = { ...p };
        if (p.kind !== 'col' && !p.rowAbs) q.row += dRow;
        if (p.kind !== 'row' && !p.colAbs) q.col += dCol;
        if (q.row < 0 || q.row >= MAX_ROWS || q.col < 0 || q.col >= MAX_COLS) return null;
        return q;
      };
      const a = move(ref.a);
      const b = ref.b ? move(ref.b) : null;
      if (!a || (ref.b && !b)) {
        // The whole reference becomes #REF!: sheet prefix and second half
        // blanked, the ":" between them tidied by fixDanglingColons.
        edits.push({ tok: ref.aTok, text: '#REF!' });
        if (ref.sheetTok) edits.push({ tok: ref.sheetTok, text: '' });
        if (ref.bTok) edits.push({ tok: ref.bTok, text: '' });
        continue;
      }
      edits.push({ tok: ref.aTok, text: writePiece(a) });
      if (b && ref.bTok) edits.push({ tok: ref.bTok, text: writePiece(b) });
    }
    return fixDanglingColons(splice(body, dedupe(edits)));
  });
}

/**
 * Rows (axis 'row') or columns ('col') inserted (count > 0) or deleted
 * (count < 0) at index `at`, on the sheet named `target`. The formula lives
 * on sheet `home`; unqualified references belong to it. Absolute and
 * relative references move alike — "$" is about copying, not inserting.
 */
export function shiftFormula(
  input: string, home: string, target: string, axis: 'row' | 'col', at: number, count: number,
): string {
  return withFormula(input, (body, toks) => {
    const edits: { tok: Token; text: string }[] = [];
    const same = (s: string | null) => (s ?? home).toLowerCase() === target.toLowerCase();
    for (const ref of findRefs(toks)) {
      if (!same(ref.sheet)) continue;
      const get = (p: Piece) => (axis === 'row' ? p.row : p.col);
      const set = (p: Piece, v: number): Piece => (axis === 'row' ? { ...p, row: v } : { ...p, col: v });
      const whole = (p: Piece) => (axis === 'row' ? p.kind === 'col' : p.kind === 'row');

      if (count > 0) {
        const mv = (p: Piece) => (whole(p) || get(p) < at ? p : set(p, get(p) + count));
        edits.push({ tok: ref.aTok, text: writePiece(mv(ref.a)) });
        // A range whose end is at or past the insertion point grows to include the new rows.
        if (ref.b && ref.bTok) edits.push({ tok: ref.bTok, text: writePiece(mv(ref.b)) });
        continue;
      }

      const n = -count;
      const end = at + n; // first index after the deleted band
      if (!ref.b) {
        if (whole(ref.a)) continue;
        const v = get(ref.a);
        if (v >= at && v < end) edits.push({ tok: ref.aTok, text: '#REF!' });
        else if (v >= end) edits.push({ tok: ref.aTok, text: writePiece(set(ref.a, v - n)) });
        continue;
      }
      if (whole(ref.a)) continue;
      let lo = get(ref.a);
      let hi = get(ref.b);
      if (lo >= at && hi < end) {
        // The whole range was deleted.
        edits.push({ tok: ref.aTok, text: '#REF!' }, { tok: ref.bTok!, text: '' });
        continue;
      }
      if (lo >= end) lo -= n; else if (lo >= at) lo = at;
      if (hi >= end) hi -= n; else if (hi >= at) hi = at - 1;
      edits.push({ tok: ref.aTok, text: writePiece(set(ref.a, lo)) });
      edits.push({ tok: ref.bTok!, text: writePiece(set(ref.b, hi)) });
    }
    return fixDanglingColons(splice(body, dedupe(edits)));
  });
}

/** A sheet was renamed: rewrite its name wherever a formula names it. */
export function renameSheetInFormula(input: string, from: string, to: string): string {
  return withFormula(input, (body, toks) => {
    const edits: { tok: Token; text: string }[] = [];
    for (const t of toks) {
      if (t.type === 'sheet' && (t.value as string).toLowerCase() === from.toLowerCase()) {
        edits.push({ tok: t, text: `${quoteSheet(to)}!` });
      }
    }
    return splice(body, edits);
  });
}

/** A sheet was deleted: references to it become #REF!. */
export function dropSheetInFormula(input: string, name: string): string {
  return withFormula(input, (body, toks) => {
    const edits: { tok: Token; text: string }[] = [];
    for (const ref of findRefs(toks)) {
      if (ref.sheet?.toLowerCase() !== name.toLowerCase()) continue;
      edits.push({ tok: ref.sheetTok!, text: '' }, { tok: ref.aTok, text: '#REF!' });
      if (ref.bTok) edits.push({ tok: ref.bTok, text: '' });
    }
    return fixDanglingColons(splice(body, dedupe(edits)));
  });
}

function dedupe(edits: { tok: Token; text: string }[]) {
  const m = new Map<Token, string>();
  for (const e of edits) m.set(e.tok, e.text);
  return [...m].map(([tok, text]) => ({ tok, text }));
}

/** "#REF!:" left behind when a range's second half was blanked. */
function fixDanglingColons(s: string): string {
  return s.replace(/#REF!\s*:(?=\s*[,)&+\-*/^=<>;}]|\s*$)/g, '#REF!');
}
