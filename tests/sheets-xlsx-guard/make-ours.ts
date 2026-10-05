// ============================================================================
//  Workbooks written by Sheets' OWN writer — the files the guard must permit,
//  and the files opened in real Excel.
//
//  Every template the app ships (apps/web/lib/sheets/templates.ts), plus one
//  workbook made to hold what the writer treats specially: a formula that
//  calls out (written as TEXT), a HYPERLINK, Indian number formats, dates,
//  text that looks like a formula, a second sheet referred to by name.
//
//  Usage:   node --import ./tests/sheets/register.mjs tests/sheets-xlsx-guard/make-ours.ts <folder>
// ============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { TEMPLATES } from '../../apps/web/lib/sheets/templates.ts';
import { cellKey, emptySheet, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';
import { Engine } from '../../apps/web/lib/sheets/engine/engine.ts';
import type { WorkbookSource } from '../../apps/web/lib/sheets/engine/types.ts';
import { formulaIsSafe } from '../../apps/web/lib/sheets/io/safety.ts';

const out = process.argv[2];
if (!out) { console.error('usage: make-ours.ts <folder>'); process.exit(1); }
mkdirSync(out, { recursive: true });

function put(sheet: ReturnType<typeof emptySheet>, a1: string, input: string, nf?: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
  sheet.cells.set(cellKey(Number(m[2]) - 1, c - 1), nf ? { input, format: { nf } } : { input });
}

const marks = emptySheet('Marks');
const rows: [string, number, number, number][] = [['Asha', 91, 78, 85], ['Bilal', 64, 72, 58], ['Charu', 88, 95, 90], ['Dev', 45, 51, 39]];
['Name', 'Maths', 'Science', 'English', 'Total', 'Average', 'Result'].forEach((h, i) => put(marks, `${'ABCDEFG'[i]}1`, h));
rows.forEach(([n, a, b, c], i) => {
  const r = i + 2;
  put(marks, `A${r}`, n); put(marks, `B${r}`, String(a)); put(marks, `C${r}`, String(b)); put(marks, `D${r}`, String(c));
  put(marks, `E${r}`, `=SUM(B${r}:D${r})`);
  put(marks, `F${r}`, `=ROUND(AVERAGE(B${r}:D${r}),1)`);
  put(marks, `G${r}`, `=IF(MIN(B${r}:D${r})>=40,"Pass","Fail")`);
});
put(marks, 'A7', 'Class total'); put(marks, 'E7', '=SUM(E2:E5)');
put(marks, 'A8', 'Best in Maths'); put(marks, 'B8', '=INDEX(A2:A5,MATCH(MAX(B2:B5),B2:B5,0))');
put(marks, 'A9', 'Passed'); put(marks, 'B9', '=COUNTIF(G2:G5,"Pass")');

const special = emptySheet('Special');
put(special, 'A1', 'Fee'); put(special, 'B1', '125000', '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0');
put(special, 'A2', 'Date'); put(special, 'B2', '2026-10-01', 'dd-mmm-yyyy');
put(special, 'A3', 'A link'); put(special, 'B3', '=HYPERLINK("https://tatvaos.com","TatvaOS")');
put(special, 'A4', 'Calls out (kept as text)'); put(special, 'B4', '=WEBSERVICE("https://example.com/x")');
put(special, 'A5', 'DDE (kept as text)'); put(special, 'B5', "=cmd|' /c calc'!A0");
put(special, 'A6', 'Looks like a formula'); put(special, 'B6', "'=SUM(1,2)");
put(special, 'A7', 'From the other sheet'); put(special, 'B7', '=Marks!E7');
put(special, 'A8', 'Hindi'); put(special, 'B8', 'नमस्ते — ₹1,25,000');
put(special, 'A9', 'Percent'); put(special, 'B9', '0.425', '0.0%');

const books: [string, WorkbookData][] = [
  ['ours--marks-and-special', { sheets: [marks, special] }],
  ...TEMPLATES.map((t): [string, WorkbookData] => [`ours--template-${t.id}`, t.build()]),
];
/**
 * What OUR engine says every cell is — written beside each workbook, so the
 * Excel check can compare what Excel calculates from the same file. A
 * formula the writer stores as text is expected back as that text.
 */
function expected(wb: WorkbookData) {
  // By position, not by the sheets' own ids: two sheets made by
  // emptySheet() here can share an id, and then every cell of the second
  // sheet was read from the first (1 Oct 2026 - Excel "disagreed" with us
  // on every second sheet, and it was this file that was wrong).
  const at = (id: string) => wb.sheets[Number(id.slice(1))];
  const source: WorkbookSource = {
    sheetIdByName: (n) => { const i = wb.sheets.findIndex((s) => s.name.toLowerCase() === n.toLowerCase()); return i < 0 ? null : `s${i}`; },
    sheetName: (id) => at(id)?.name ?? null,
    raw: (id, r, c) => at(id)?.cells.get(cellKey(r, c))?.input ?? null,
    size: () => ({ rows: 1000, cols: 26 }),
  };
  const engine = new Engine(source, { now: () => new Date(2026, 9, 1, 10, 30) });
  const all: Record<string, Record<string, unknown>> = {};
  for (const [index, s] of wb.sheets.entries()) {
    const cells: Record<string, unknown> = {};
    for (const [key, cell] of s.cells) {
      const input = cell.input ?? '';
      if (input === '') continue;
      const [r, c] = key.split(',').map(Number) as [number, number];
      const a1 = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (input.startsWith('=') && !formulaIsSafe(input)) { cells[a1] = { text: input }; continue; }
      const v = engine.getValue(`s${index}`, r, c);
      cells[a1] = v !== null && typeof v === 'object' ? { error: (v as { code: string }).code }
        : input.startsWith('=') ? { formula: input, value: v } : { value: v };
    }
    all[s.name] = cells;
  }
  return all;
}

for (const [name, wb] of books) {
  const bytes = await writeXlsx(wb);
  writeFileSync(join(out, `${name}.xlsx`), bytes);
  writeFileSync(join(out, `${name}.expected.json`), JSON.stringify(expected(wb), null, 1));
  console.log(`${bytes.length}\t${name}.xlsx\t${wb.sheets.length} sheet(s)`);
}
