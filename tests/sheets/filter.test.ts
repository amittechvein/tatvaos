// ============================================================================
//  The filter — Amit's Phase 2, 9 Oct 2026. lib/sheets/filter.ts,
//  SheetsModel filter, xlsx autoFilterXml / readFilter.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model.ts';
import { cleanHiddenValues, columnValues, hiddenRows, type PlacedFilter } from '../../apps/web/lib/sheets/filter.ts';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { readZip, writeZip } from '../../apps/web/lib/sheets/io/zip.ts';
import { cellKey, emptySheet, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';

// A small attendance table: header row 0, data rows 1-5.
const GRID: (string | null)[][] = [
  ['Name', 'Status', 'Fee'],
  ['Asha', 'Present', '500'],
  ['Bilal', 'Absent', '0'],
  ['Charu', 'present', '500'],
  ['Dev', null, '250'],
  ['Esha', 'Leave', '0'],
];
const shownAt = (r: number, c: number) => GRID[r]?.[c] ?? null;
const placed = (hidden: Record<number, string[]>): PlacedFilter => ({
  r1: 0, c1: 0, r2: 5, c2: 2,
  hidden: new Map(Object.entries(hidden).map(([c, v]) => [Number(c), new Set(v.map((x) => x.toLowerCase()))])),
});

test('a row is hidden when ANY filtered column shows a hidden value; case does not matter; the header never hides', () => {
  assert.deepEqual([...hiddenRows(placed({ 1: ['present'] }), shownAt)].sort(), [1, 3]);
  assert.deepEqual([...hiddenRows(placed({ 1: ['Absent'], 2: ['250'] }), shownAt)].sort(), [2, 4]);
  assert.deepEqual([...hiddenRows(placed({ 1: [''] }), shownAt)], [4], 'the blank value hides blank cells');
  assert.equal(hiddenRows(placed({ 0: ['Name'] }), shownAt).size, 0, 'the header row is never hidden');
  assert.equal(hiddenRows(placed({}), shownAt).size, 0);
});

test('a column\'s values for the menu: each once (ignoring case), counted; numbers in number order, blanks last', () => {
  assert.deepEqual(columnValues(placed({}), 1, shownAt).map((v) => [v.text, v.count]), [['Absent', 1], ['Leave', 1], ['Present', 2], ['', 1]]);
  assert.deepEqual(columnValues(placed({}), 2, shownAt).map((v) => v.text), ['0', '250', '500']);
});

test('hidden values are cleaned: strings only, each once, bounded', () => {
  assert.deepEqual(cleanHiddenValues(['A', 'a', 3, null, 'B', 'x'.repeat(501)]), ['A', 'B']);
  assert.deepEqual(cleanHiddenValues('A'), []);
  assert.equal(cleanHiddenValues(Array.from({ length: 6000 }, (_, i) => `v${i}`)).length, 5000);
});

function freshModel(doc = new Y.Doc()) {
  const model = new SheetsModel(doc);
  model.ensureSeeded();
  return { doc, model, sid: model.sheetIds()[0]! };
}
function fill(model: SheetsModel, sid: string) {
  model.setInputs(sid, GRID.flatMap((row, r) => row.map((input, c) => ({ r, c, input }))));
}

test('model: a filter needs a header and a data row; it hides by what cells SHOW (₹1,250), and removes cleanly', () => {
  const { model, sid } = freshModel();
  fill(model, sid);
  model.setInputs(sid, [{ r: 1, c: 2, input: '₹1,250' }]);
  assert.equal(model.createFilter(sid, { r1: 0, c1: 0, r2: 0, c2: 2 }), false, 'header only: refused');
  assert.equal(model.createFilter(sid, { r1: 0, c1: 0, r2: 5, c2: 2 }), true);
  assert.equal(model.shownText(sid, 1, 2), '₹1,250');
  assert.ok(model.setFilterHidden(sid, 2, ['₹1,250']));
  assert.deepEqual([...model.filterHiddenRows(sid)], [1]);
  assert.equal(model.setFilterHidden(sid, 7, ['x']), false, 'a column outside the filter is refused');
  model.setFilterHidden(sid, 2, []);
  assert.equal(model.filterHiddenRows(sid).size, 0, 'an empty list shows every value');
  model.removeFilter(sid);
  assert.equal(model.filter(sid), null);
});

test('two people filtering DIFFERENT columns at once both keep their change', () => {
  const a = freshModel();
  fill(a.model, a.sid);
  a.model.createFilter(a.sid, { r1: 0, c1: 0, r2: 5, c2: 2 });
  const b = freshModel(new Y.Doc());
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  // Offline from each other: each filters a different column...
  a.model.setFilterHidden(a.sid, 1, ['Absent']);
  b.model.setFilterHidden(b.sid, 2, ['250']);
  // ...then they sync both ways.
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  for (const side of [a, b]) {
    assert.deepEqual([...side.model.filterHiddenRows(side.sid)].sort(), [2, 4], 'Absent (row 2) and 250 (row 4) both hidden');
  }
});

test('the filter follows inserted rows, shrinks on a deleted last row, and goes with its header row', () => {
  const { model, sid } = freshModel();
  fill(model, sid);
  model.createFilter(sid, { r1: 0, c1: 0, r2: 5, c2: 2 });
  model.setFilterHidden(sid, 1, ['Absent']);
  model.insert(sid, 'row', 0, 2);
  const f1 = model.filter(sid)!;
  assert.deepEqual([f1.r1, f1.r2], [2, 7]);
  assert.deepEqual([...model.filterHiddenRows(sid)], [4], 'still hides Bilal, now two rows down');
  model.remove(sid, 'row', 7, 1);
  assert.deepEqual([model.filter(sid)!.r1, model.filter(sid)!.r2], [2, 6]);
  model.remove(sid, 'row', 2, 1);
  assert.equal(model.filter(sid), null, 'header row deleted: the filter goes');
});

test('a sheet without a filter key opens with none; snapshot, load and duplicate carry the filter', () => {
  const { model, sid } = freshModel();
  assert.equal(model.filter(sid), null);
  fill(model, sid);
  model.createFilter(sid, { r1: 0, c1: 0, r2: 5, c2: 2 });
  model.setFilterHidden(sid, 1, ['Absent', 'Leave']);
  const snap = model.snapshot();
  assert.deepEqual(snap.sheets[0]!.filter, { r1: 0, c1: 0, r2: 5, c2: 2, hidden: { 1: ['Absent', 'Leave'] } });
  const other = freshModel();
  const loaded = other.model.load(snap, 'replace')!;
  assert.deepEqual([...other.model.filterHiddenRows(loaded)].sort(), [2, 5]);
  assert.deepEqual([...model.filterHiddenRows(model.duplicateSheet(sid))].sort(), [2, 5]);
});

function book(): WorkbookData {
  const s = emptySheet('Attendance');
  GRID.forEach((row, r) => row.forEach((input, c) => { if (input !== null) s.cells.set(cellKey(r, c), { input }); }));
  s.merges = [{ r1: 8, c1: 0, r2: 8, c2: 1 }];
  s.filter = { r1: 0, c1: 0, r2: 5, c2: 2, hidden: { 1: ['Absent', ''] } };
  return { sheets: [s] };
}

test('.xlsx: an autoFilter listing the SHOWN values, hidden rows hidden, in the schema\'s place', async () => {
  const files = await readZip(await writeXlsx(book()));
  const sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  assert.match(sheet, /<autoFilter ref="A1:C6"><filterColumn colId="1"><filters><filter val="Leave"\/><filter val="Present"\/><\/filters><\/filterColumn><\/autoFilter>/,
    'Absent and blanks hidden: the list shows Leave and Present, and no blank flag');
  assert.match(sheet, /<row r="3" hidden="1">/, 'Bilal (Absent)');
  assert.match(sheet, /<row r="5" hidden="1">/, 'Dev (blank status)');
  assert.doesNotMatch(sheet, /<row r="2" hidden/, 'Asha shows');
  const at = (s: string) => sheet.indexOf(s);
  assert.ok(at('</sheetData>') < at('<autoFilter') && at('<autoFilter') < at('<mergeCells'), 'after sheetData, before mergeCells');
});

test('.xlsx: the filter reads back as written; a custom condition keeps the range but not its column', async () => {
  const back = await readXlsx(await writeXlsx(book()));
  assert.deepEqual(back.sheets[0]!.filter, book().sheets[0]!.filter);

  const files = await readZip(await writeXlsx(book()));
  let sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  sheet = sheet.replace('</autoFilter>',
    '<filterColumn colId="2"><customFilters><customFilter operator="greaterThan" val="100"/></customFilters></filterColumn></autoFilter>');
  files.set('xl/worksheets/sheet1.xml', new TextEncoder().encode(sheet));
  const custom = await readXlsx(await writeZip([...files].map(([name, data]) => ({ name, data }))));
  assert.deepEqual(custom.sheets[0]!.filter, book().sheets[0]!.filter, 'column C\'s "greater than" is not kept; the rest is');
});
