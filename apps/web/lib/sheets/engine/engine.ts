// ============================================================================
//  The calculation engine.
//
//  DEMAND-DRIVEN. Nothing is calculated until something asks for its value
//  (the grid, for the cells on screen; an export, for all of them). Asking
//  for a formula's value evaluates it, which asks for the cells it reads,
//  and so on down — so dependencies are always calculated before the cells
//  that use them, with no separate ordering pass.
//
//  INCREMENTAL. Every evaluation records what the formula read. When an
//  input changes, invalidate() walks those records backwards and forgets
//  the value of everything downstream — and only that. The next read
//  recalculates exactly those cells.
//
//  CYCLES. A formula that, however indirectly, reads itself gets #REF!
//  "Circular dependency", as in Google Sheets. Detected by the in-progress
//  set, not by a graph search.
//
//  LONG CHAINS. A2=A1+1, A3=A2+1 … down 50,000 rows would overflow the
//  JavaScript stack if evaluated by plain recursion. Past a depth limit the
//  evaluation throws Deep, the top level evaluates that deeper cell first
//  (from depth zero), and tries again. Each retry starts further down the
//  chain, so it always finishes.
//
//  STRUCTURE. The engine addresses cells by position. When rows or columns
//  are inserted or deleted, or a sheet renamed, positions and names change
//  meaning — the model calls reset() and everything is read afresh. Those
//  are rare; typing is not.
// ============================================================================

import { parseFormula, ParseError, type Node } from './parser';
import { parseInput } from './input';
import { compare, toNumber, toText, tidy } from './values';
import { FUNCTIONS, type FnContext } from './functions';
import { Args } from './functions/args';
import {
  CellError, isError, isMatrix, isRef, INDIA,
  type EvalResult, type Locale, type Matrix, type RefValue, type Scalar, type WorkbookSource,
} from './types';

const MAX_DEPTH = 150;
/** Cell key within a sheet. MAX_COLS < 20,000, so this is unique and exact in a double. */
const K = (r: number, c: number) => r * 20_000 + c;
const RC = (k: number): [number, number] => [Math.floor(k / 20_000), k % 20_000];

class Deep {
  readonly sheet: string; readonly row: number; readonly col: number;
  constructor(sheet: string, row: number, col: number) { this.sheet = sheet; this.row = row; this.col = col; }
}

interface FormulaEntry {
  sheet: string;
  k: number;
  cells: [string, number][];
  ranges: [string, string][];
  volatile: boolean;
}

export interface EngineOptions {
  locale?: Locale;
  /** The clock TODAY() and NOW() read. Injected so tests are deterministic. */
  now?: () => Date;
}

export class Engine {
  readonly source: WorkbookSource;
  locale: Locale;
  private readonly now: () => Date;

  /** Calculated values. A missing entry means "not calculated yet". */
  private values = new Map<string, Map<number, Scalar>>();
  /** Parsed formula text, shared across cells (copied formulas repeat). */
  private readonly asts = new Map<string, Node | ParseError>();
  private formulas = new Map<string, FormulaEntry>();
  /** sheet → cell key → formulas that read that cell. */
  private cellDeps = new Map<string, Map<number, Set<string>>>();
  /** sheet → "r1,c1,r2,c2" → formulas that read that range. */
  private rangeDeps = new Map<string, Map<string, Set<string>>>();
  private volatiles = new Set<string>();

  private inProgress = new Set<string>();
  private depth = 0;
  /** The formula being evaluated right now, so references can record themselves against it. */
  private current: FormulaEntry | null = null;

  constructor(source: WorkbookSource, opts: EngineOptions = {}) {
    this.source = source;
    this.locale = opts.locale ?? INDIA;
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------
  //  Reading
  // ------------------------------------------------------------------

  /** The calculated value of a cell: a number, text, boolean, error, or null for empty. */
  getValue(sheet: string, row: number, col: number): Scalar {
    if (this.depth > 0) return this.valueAt(sheet, row, col);
    const pending: [string, number, number][] = [[sheet, row, col]];
    let guard = 0;
    while (pending.length > 0) {
      const [s, r, c] = pending[pending.length - 1]!;
      try {
        this.valueAt(s, r, c);
        pending.pop();
      } catch (e) {
        this.depth = 0;
        this.inProgress.clear();
        this.current = null;
        if (!(e instanceof Deep)) throw e;
        pending.push([e.sheet, e.row, e.col]);
        guard += 1;
        if (guard > 1_000_000) throw new Error('Calculation did not converge.');
      }
    }
    return this.values.get(sheet)?.get(K(row, col)) ?? null;
  }

  /** Is this cell a formula? (Its input starts with '='.) */
  isFormula(sheet: string, row: number, col: number): boolean {
    const raw = this.source.raw(sheet, row, col);
    return raw !== null && raw.startsWith('=') && raw.length > 1;
  }

  private valueAt(sheet: string, row: number, col: number): Scalar {
    let sv = this.values.get(sheet);
    if (!sv) { sv = new Map(); this.values.set(sheet, sv); }
    const k = K(row, col);
    if (sv.has(k)) return sv.get(k)!;

    const fkey = `${sheet}|${k}`;
    if (this.inProgress.has(fkey)) {
      return new CellError('#REF!', 'Circular dependency detected. A formula refers to its own cell, directly or through other cells.');
    }

    const raw = this.source.raw(sheet, row, col);
    const input = parseInput(raw, this.locale);
    if (input.kind !== 'formula') {
      this.dropFormula(fkey);
      sv.set(k, input.value);
      return input.value;
    }

    if (this.depth >= MAX_DEPTH) throw new Deep(sheet, row, col);

    const entry: FormulaEntry = { sheet, k, cells: [], ranges: [], volatile: false };
    this.dropFormula(fkey);
    this.formulas.set(fkey, entry);

    let ast = this.asts.get(input.formula!);
    if (ast === undefined) {
      try { ast = parseFormula(input.formula!); } catch (e) {
        ast = e instanceof ParseError ? e : new ParseError('Formula parse error.');
      }
      if (this.asts.size > 50_000) this.asts.clear();
      this.asts.set(input.formula!, ast);
    }

    let value: Scalar;
    if (ast instanceof ParseError) {
      value = new CellError('#ERROR!', ast.message);
    } else {
      const outer = this.current;
      this.current = entry;
      this.inProgress.add(fkey);
      this.depth += 1;
      try {
        value = this.toCellValue(this.evalNode(ast, sheet, row, col));
      } finally {
        this.depth -= 1;
        this.inProgress.delete(fkey);
        this.current = outer;
      }
    }
    if (entry.volatile) this.volatiles.add(fkey);
    sv.set(k, value);
    return value;
  }

  /** What a formula's result shows in its cell. */
  private toCellValue(r: EvalResult): Scalar {
    if (isRef(r)) {
      if (r.r1 === r.r2 && r.c1 === r.c2) return this.valueAt(r.sheet, r.r1, r.c1);
      return new CellError('#VALUE!', 'This formula returns a range of cells. Use a function such as SUM, or refer to one cell.');
    }
    if (isMatrix(r)) {
      if (r.rows.length === 1 && r.rows[0]!.length === 1) return r.rows[0]![0]!;
      return new CellError('#VALUE!', 'This formula returns several values. Results that fill several cells are not supported yet.');
    }
    if (typeof r === 'number' && !Number.isFinite(r)) return new CellError('#NUM!');
    return r;
  }

  // ------------------------------------------------------------------
  //  Invalidation
  // ------------------------------------------------------------------

  /** A cell's input changed. Forget it and everything that depends on it. */
  invalidate(sheet: string, row: number, col: number) {
    this.invalidateMany([[sheet, row, col]]);
  }

  invalidateMany(cells: Iterable<[string, number, number]>) {
    const stack: [string, number][] = [];
    for (const [s, r, c] of cells) stack.push([s, K(r, c)]);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const [s, k] = stack.pop()!;
      const key = `${s}|${k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.values.get(s)?.delete(k);

      const direct = this.cellDeps.get(s)?.get(k);
      if (direct) for (const f of direct) stack.push(splitKey(f));

      const ranges = this.rangeDeps.get(s);
      if (ranges && ranges.size > 0) {
        const [r, c] = RC(k);
        for (const [rk, set] of ranges) {
          const [r1, c1, r2, c2] = rk.split(',').map(Number) as [number, number, number, number];
          if (r >= r1 && r <= r2 && c >= c1 && c <= c2) for (const f of set) stack.push(splitKey(f));
        }
      }
    }
  }

  /** TODAY(), NOW(), RAND(): recalculate them (and what reads them). Call on a timer, and after edits. */
  tickVolatile() {
    if (this.volatiles.size === 0) return;
    const cells: [string, number, number][] = [];
    for (const f of this.volatiles) {
      const [s, k] = splitKey(f);
      const [r, c] = RC(k);
      cells.push([s, r, c]);
    }
    this.volatiles.clear();
    this.invalidateMany(cells);
  }

  /** Forget everything: rows or columns moved, a sheet was renamed, the locale changed. */
  reset() {
    this.values = new Map();
    this.formulas = new Map();
    this.cellDeps = new Map();
    this.rangeDeps = new Map();
    this.volatiles = new Set();
  }

  private dropFormula(fkey: string) {
    const old = this.formulas.get(fkey);
    if (!old) return;
    this.formulas.delete(fkey);
    this.volatiles.delete(fkey);
    for (const [s, k] of old.cells) this.cellDeps.get(s)?.get(k)?.delete(fkey);
    for (const [s, rk] of old.ranges) {
      const m = this.rangeDeps.get(s);
      const set = m?.get(rk);
      if (set) { set.delete(fkey); if (set.size === 0) m!.delete(rk); }
    }
  }

  private recordRead(ref: RefValue) {
    const f = this.current;
    if (!f) return;
    const fkey = `${f.sheet}|${f.k}`;
    if (ref.r1 === ref.r2 && ref.c1 === ref.c2) {
      const k = K(ref.r1, ref.c1);
      let m = this.cellDeps.get(ref.sheet);
      if (!m) { m = new Map(); this.cellDeps.set(ref.sheet, m); }
      let set = m.get(k);
      if (!set) { set = new Set(); m.set(k, set); }
      set.add(fkey);
      f.cells.push([ref.sheet, k]);
    } else {
      const rk = `${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
      let m = this.rangeDeps.get(ref.sheet);
      if (!m) { m = new Map(); this.rangeDeps.set(ref.sheet, m); }
      let set = m.get(rk);
      if (!set) { set = new Set(); m.set(rk, set); }
      set.add(fkey);
      f.ranges.push([ref.sheet, rk]);
    }
  }

  // ------------------------------------------------------------------
  //  Evaluation
  // ------------------------------------------------------------------

  /** Evaluate a tree in the context of one cell. Public for the formula-bar preview. */
  evalNode(node: Node, sheet: string, row: number, col: number): EvalResult {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'bool': return node.v;
      case 'err': return new CellError(node.v);
      case 'missing': return null;
      case 'arr':
        return {
          kind: 'matrix',
          rows: node.rows.map((r) => r.map((n) => this.scalar(this.evalNode(n, sheet, row, col)))),
        };
      case 'ref': {
        let sid = sheet;
        if (node.sheet !== null) {
          const found = this.source.sheetIdByName(node.sheet);
          if (!found) return new CellError('#REF!', `Unresolved sheet name '${node.sheet}'.`);
          sid = found;
        }
        const size = this.source.size(sid);
        // Whole columns and rows stop at the sheet's edge; explicit ranges
        // past it read as empty, which costs nothing to leave as written.
        const ref: RefValue = {
          kind: 'ref', sheet: sid,
          r1: node.r1, c1: node.c1,
          r2: node.r1 === 0 && node.r2 >= 999_999 ? Math.max(0, size.rows - 1) : node.r2,
          c2: node.c1 === 0 && node.c2 >= 18_277 ? Math.max(0, size.cols - 1) : node.c2,
        };
        this.recordRead(ref);
        return ref;
      }
      case 'name': {
        const nr = this.source.namedRange?.(node.name) ?? null;
        if (nr) { this.recordRead(nr); return nr; }
        return new CellError('#NAME?', `Unknown range name: '${node.name}'.`);
      }
      case 'fn': {
        const def = FUNCTIONS[node.name];
        if (!def) return new CellError('#NAME?', `Unknown function: '${node.name}'.`);
        const n = node.args.length;
        if (n < def.min || n > def.max) {
          const expect = def.min === def.max ? `${def.min}`
            : def.max === Infinity ? `at least ${def.min}` : `between ${def.min} and ${def.max}`;
          return new CellError('#N/A', `Wrong number of arguments to ${node.name}. Expected ${expect}, but got ${n}.`);
        }
        if (def.volatile && this.current) this.current.volatile = true;
        const args = new Args(node.args, (a) => this.evalNode(a, sheet, row, col));
        const r = def.fn(args, this.context(sheet, row, col));
        return typeof r === 'number' && !Number.isFinite(r) ? new CellError('#NUM!') : r;
      }
      case 'un': {
        const v = this.evalNode(node.e, sheet, row, col);
        return this.map1(v, (x) => {
          const n = toNumber(x, this.locale);
          return isError(n) ? n : node.op === '-' ? -n : n;
        });
      }
      case 'pct': {
        const v = this.evalNode(node.e, sheet, row, col);
        return this.map1(v, (x) => {
          const n = toNumber(x, this.locale);
          return isError(n) ? n : n / 100;
        });
      }
      case 'bin': {
        const l = this.evalNode(node.l, sheet, row, col);
        const r = this.evalNode(node.r, sheet, row, col);
        return this.map2(l, r, (a, b) => this.binary(node.op, a, b));
      }
    }
  }

  private binary(op: string, a: Scalar, b: Scalar): Scalar {
    if (op === '&') {
      const x = toText(a); if (isError(x)) return x;
      const y = toText(b); if (isError(y)) return y;
      return x + y;
    }
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (isError(a)) return a;
      if (isError(b)) return b;
      const c = compare(a, b);
      switch (op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        default: return c >= 0;
      }
    }
    const x = toNumber(a, this.locale); if (isError(x)) return x;
    const y = toNumber(b, this.locale); if (isError(y)) return y;
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/':
        return y === 0 ? new CellError('#DIV/0!', 'Function DIVIDE parameter 2 cannot be zero.') : x / y;
      case '^': {
        if (x === 0 && y < 0) return new CellError('#DIV/0!');
        const p = x ** y;
        return Number.isNaN(p) ? new CellError('#NUM!', 'A negative number cannot be raised to a fractional power.') : tidy(p);
      }
    }
    return new CellError('#ERROR!', `Unknown operator ${op}.`);
  }

  /** One value from an argument: a single cell's value, or #VALUE! for a range. */
  scalar(r: EvalResult): Scalar {
    if (isRef(r)) {
      if (r.r1 === r.r2 && r.c1 === r.c2) return this.valueAt(r.sheet, r.r1, r.c1);
      return new CellError('#VALUE!', 'Expected a single value, but got a range of cells.');
    }
    if (isMatrix(r)) {
      if (r.rows.length === 1 && r.rows[0]!.length === 1) return r.rows[0]![0]!;
      return new CellError('#VALUE!', 'Expected a single value, but got several.');
    }
    return r;
  }

  /** Values of a range or array; a scalar is a 1×1 grid. */
  grid(r: EvalResult): Scalar[][] {
    if (isRef(r)) {
      const out: Scalar[][] = [];
      for (let i = r.r1; i <= r.r2; i += 1) {
        const row: Scalar[] = [];
        for (let j = r.c1; j <= r.c2; j += 1) row.push(this.valueAt(r.sheet, i, j));
        out.push(row);
      }
      return out;
    }
    if (isMatrix(r)) return r.rows;
    return [[r]];
  }

  private isMulti(r: EvalResult): boolean {
    if (isRef(r)) return r.r1 !== r.r2 || r.c1 !== r.c2;
    if (isMatrix(r)) return r.rows.length !== 1 || r.rows[0]!.length !== 1;
    return false;
  }

  /** Apply an operator to each element — what makes SUMPRODUCT((A2:A9="Paid")*C2:C9) work. */
  private map1(v: EvalResult, f: (x: Scalar) => Scalar): EvalResult {
    if (!this.isMulti(v)) return f(this.scalar(v));
    return { kind: 'matrix', rows: this.grid(v).map((row) => row.map(f)) } satisfies Matrix;
  }

  private map2(a: EvalResult, b: EvalResult, f: (x: Scalar, y: Scalar) => Scalar): EvalResult {
    if (!this.isMulti(a) && !this.isMulti(b)) return f(this.scalar(a), this.scalar(b));
    const ga = this.grid(a);
    const gb = this.grid(b);
    const rows = Math.max(ga.length, gb.length);
    const cols = Math.max(ga[0]?.length ?? 0, gb[0]?.length ?? 0);
    const pick = (g: Scalar[][], i: number, j: number): Scalar => {
      // A single row or column stretches across the other operand; beyond that, #N/A.
      const ri = g.length === 1 ? 0 : i;
      const cj = (g[0]?.length ?? 0) === 1 ? 0 : j;
      const row = g[ri];
      if (!row || cj >= row.length) return new CellError('#N/A', 'Array arguments are of different size.');
      return row[cj]!;
    };
    const out: Scalar[][] = [];
    for (let i = 0; i < rows; i += 1) {
      const row: Scalar[] = [];
      for (let j = 0; j < cols; j += 1) row.push(f(pick(ga, i, j), pick(gb, i, j)));
      out.push(row);
    }
    return { kind: 'matrix', rows: out };
  }

  private context(sheet: string, row: number, col: number): FnContext {
    return {
      engine: this,
      locale: this.locale,
      sheet, row, col,
      now: this.now,
      scalar: (r) => this.scalar(r),
      grid: (r) => this.grid(r),
      size: (s) => this.source.size(s),
      cell: (s, r, c) => this.valueAt(s, r, c),
      record: (ref) => this.recordRead(ref),
    };
  }
}

function splitKey(f: string): [string, number] {
  const i = f.lastIndexOf('|');
  return [f.slice(0, i), Number(f.slice(i + 1))];
}
