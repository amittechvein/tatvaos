// ============================================================================
//  A workbook for tests: sheets as plain objects of A1 → input.
//
//    const wb = book({ Sheet1: { A1: '10', A2: '=A1*2' } });
//    assert.equal(wb.get('A2'), 20);
//    wb.set('A1', '5');             // and the engine is told
//    assert.equal(wb.get('A2'), 10);
// ============================================================================

import { Engine } from '../../apps/web/lib/sheets/engine/engine.ts';
import { parseCell } from '../../apps/web/lib/sheets/engine/address.ts';
import type { Scalar, WorkbookSource } from '../../apps/web/lib/sheets/engine/types.ts';

export function book(sheets: Record<string, Record<string, string>>, now = new Date(2026, 8, 24, 10, 30)) {
  const names = Object.keys(sheets);
  // Keyed by "row,col" so a lookup is one Map read, not a scan.
  const cellKey = (r: number, c: number) => `${r},${c}`;
  const a1Key = (a1: string) => { const a = parseCell(a1)!; return cellKey(a.row, a.col); };
  const data = new Map<string, Map<string, string>>();
  names.forEach((n, i) => data.set(`s${i}`,
    new Map(Object.entries(sheets[n]!).map(([k, v]) => [a1Key(k), v]))));

  const source: WorkbookSource = {
    sheetIdByName: (name) => {
      const i = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
      return i < 0 ? null : `s${i}`;
    },
    sheetName: (id) => names[Number(id.slice(1))] ?? null,
    raw: (sheet, r, c) => data.get(sheet)?.get(cellKey(r, c)) ?? null,
    size: () => ({ rows: 1000, cols: 26 }),
  };
  const engine = new Engine(source, { now: () => now });

  function where(addr: string): [string, number, number] {
    const [sheetName, a1] = addr.includes('!') ? addr.split('!') as [string, string] : [names[0]!, addr];
    const sid = source.sheetIdByName(sheetName)!;
    const a = parseCell(a1)!;
    return [sid, a.row, a.col];
  }

  return {
    engine,
    get(addr: string): Scalar {
      const [s, r, c] = where(addr);
      return engine.getValue(s, r, c);
    },
    set(addr: string, input: string | null) {
      const [s, r, c] = where(addr);
      const m = data.get(s)!;
      const key = cellKey(r, c);
      if (input === null) m.delete(key); else m.set(key, input);
      engine.invalidate(s, r, c);
    },
  };
}

/** Evaluate one formula in an otherwise empty workbook (plus optional cells). */
export function calc(formula: string, cells: Record<string, string> = {}): Scalar {
  const wb = book({ Sheet1: { ...cells, Z1000: formula } });
  return wb.get('Z1000');
}

/** An error's code, or the value itself — for terse assertions. */
export function shown(v: Scalar): unknown {
  return v !== null && typeof v === 'object' ? v.code : v;
}
