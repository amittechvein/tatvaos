// ============================================================================
//  A1 addresses: column letters, cell names, ranges.
//  Zero-based everywhere inside the engine; one-based only in text.
// ============================================================================

/** Largest sheet the engine addresses. Matches Google Sheets' column ceiling (ZZZ). */
export const MAX_ROWS = 1_000_000;
export const MAX_COLS = 18_278;

/** 0 → A, 25 → Z, 26 → AA. */
export function colName(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A → 0, AA → 26. -1 when not letters. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export function cellName(r: number, c: number): string {
  return `${colName(c)}${r + 1}`;
}

export interface CellAddr { row: number; col: number; rowAbs: boolean; colAbs: boolean }

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

/** "B$3" → { row 2, col 1, rowAbs true }. null when not a cell address. */
export function parseCell(s: string): CellAddr | null {
  const m = CELL.exec(s);
  if (!m) return null;
  const col = colIndex(m[2]!);
  const row = Number(m[4]) - 1;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return null;
  return { row, col, colAbs: m[1] === '$', rowAbs: m[3] === '$' };
}

export function formatCell(a: CellAddr): string {
  return `${a.colAbs ? '$' : ''}${colName(a.col)}${a.rowAbs ? '$' : ''}${a.row + 1}`;
}

export interface Rect { r1: number; c1: number; r2: number; c2: number }

/** Normalise so r1 ≤ r2 and c1 ≤ c2. */
export function norm(r: Rect): Rect {
  return {
    r1: Math.min(r.r1, r.r2), c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2), c2: Math.max(r.c1, r.c2),
  };
}

export function rectName(r: Rect): string {
  const n = norm(r);
  return n.r1 === n.r2 && n.c1 === n.c2
    ? cellName(n.r1, n.c1)
    : `${cellName(n.r1, n.c1)}:${cellName(n.r2, n.c2)}`;
}

/** Parse "A1", "A1:C5" or "C5:A1" (the name box). null when neither. */
export function parseRect(s: string): Rect | null {
  const parts = s.trim().split(':');
  if (parts.length === 1) {
    const a = parseCell(parts[0]!);
    return a ? { r1: a.row, c1: a.col, r2: a.row, c2: a.col } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseCell(parts[0]!);
  const b = parseCell(parts[1]!);
  return a && b ? norm({ r1: a.row, c1: a.col, r2: b.row, c2: b.col }) : null;
}

/** Quote a sheet name for use in a formula when it needs it: 'Fee 2026'!A1. */
export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !parseCell(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}
