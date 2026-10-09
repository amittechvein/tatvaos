// ============================================================================
//  Dropdowns (data validation lists) — Amit's Phase 2, 9 Oct 2026.
//  lib/sheets/dropdowns.ts, SheetsModel dropdowns, xlsx dropdownsXml /
//  readDropdowns. Refusals sit beside their permit twins, as elsewhere.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model.ts';
import {
  asListed, cleanDropdown, dropdownAt, isChoice, parseItems, type PlacedDropdown,
} from '../../apps/web/lib/sheets/dropdowns.ts';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { readZip, writeZip } from '../../apps/web/lib/sheets/io/zip.ts';
import { cellKey, emptySheet, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';

const ATT = { items: ['Present', 'Absent', 'Leave'], strict: true };

test('choices from the dialog: one per line, or commas on one line; trimmed; repeats dropped', () => {
  assert.deepEqual(parseItems('Present\n Absent \n\nLeave\nabsent'), ['Present', 'Absent', 'Leave']);
  assert.deepEqual(parseItems('Paid, Due ,Waived'), ['Paid', 'Due', 'Waived']);
  assert.deepEqual(parseItems('One, with comma\nTwo'), ['One, with comma', 'Two'], 'several lines: commas are part of a choice');
  assert.deepEqual(parseItems('  \n '), []);
});

test('cleanDropdown keeps a real list and drops junk', () => {
  assert.deepEqual(cleanDropdown(ATT), ATT);
  assert.deepEqual(cleanDropdown({ items: ['A', 'a', ' B ', 7, '', 'x'.repeat(101)] }), { items: ['A', 'B'], strict: true }, 'strict unless said otherwise');
  assert.equal(cleanDropdown({ items: [] }), undefined);
  assert.equal(cleanDropdown({ items: 'Present,Absent' }), undefined);
  assert.equal(cleanDropdown(null), undefined);
  assert.equal(cleanDropdown({ items: Array.from({ length: 600 }, (_, i) => `i${i}`) })!.items.length, 500);
  assert.equal(cleanDropdown({ items: ['A'], strict: false })!.strict, false);
});

test('a choice matches ignoring case and is stored as listed; empty is always allowed', () => {
  assert.equal(isChoice(ATT, 'absent'), true);
  assert.equal(asListed(ATT, ' absent '), 'Absent');
  assert.equal(isChoice(ATT, 'Late'), false);
  assert.equal(isChoice(ATT, ''), true);
  assert.equal(isChoice(ATT, null), true);
});

test('where two dropdowns cover a cell the later wins', () => {
  const list: PlacedDropdown[] = [
    { id: 'a', r1: 0, c1: 0, r2: 9, c2: 0, items: ['X'], strict: true },
    { id: 'b', r1: 5, c1: 0, r2: 5, c2: 0, items: ['Y'], strict: true },
  ];
  assert.equal(dropdownAt(list, 5, 0)!.id, 'b');
  assert.equal(dropdownAt(list, 4, 0)!.id, 'a');
  assert.equal(dropdownAt(list, 4, 1), undefined);
});

function freshModel() {
  const doc = new Y.Doc();
  const model = new SheetsModel(doc);
  model.ensureSeeded();
  return { doc, model, sid: model.sheetIds()[0]! };
}

test('a new dropdown replaces those wholly inside its range; one that only overlaps stays, under it', () => {
  const { model, sid } = freshModel();
  const inner = model.addDropdown(sid, { r1: 2, c1: 1, r2: 4, c2: 1 }, { items: ['Old'], strict: true })!;
  const overlap = model.addDropdown(sid, { r1: 8, c1: 1, r2: 20, c2: 1 }, { items: ['Other'], strict: true })!;
  model.addDropdown(sid, { r1: 1, c1: 1, r2: 10, c2: 1 }, ATT);
  const ids = model.dropdowns(sid).map((d) => d.id);
  assert.ok(!ids.includes(inner), 'the one inside was replaced');
  assert.ok(ids.includes(overlap), 'the overlapping one stays');
  assert.deepEqual(model.dropdownAt(sid, 9, 1)!.items, ATT.items, 'the newer one wins where they meet');
  assert.deepEqual(model.dropdownAt(sid, 15, 1)!.items, ['Other']);
});

test('remove takes every dropdown touching the range and leaves the values', () => {
  const { model, sid } = freshModel();
  model.addDropdown(sid, { r1: 1, c1: 1, r2: 10, c2: 1 }, ATT);
  model.setInputs(sid, [{ r: 3, c: 1, input: 'Absent' }]);
  assert.equal(model.removeDropdownsIn(sid, { r1: 3, c1: 1, r2: 3, c2: 1 }), 1);
  assert.equal(model.dropdowns(sid).length, 0);
  assert.equal(model.input(sid, 3, 1), 'Absent');
  assert.equal(model.removeDropdownsIn(sid, { r1: 3, c1: 1, r2: 3, c2: 1 }), 0);
});

test('dropdowns follow inserts and shrink on deletes, like colour rules (one shared mechanism)', () => {
  const { model, sid } = freshModel();
  model.addDropdown(sid, { r1: 1, c1: 2, r2: 9, c2: 2 }, ATT);
  model.addColourRule(sid, { r1: 1, c1: 2, r2: 9, c2: 2 }, { kind: 'eq', a: 'Absent', style: { bg: '#f4c7c3' } });
  model.insert(sid, 'row', 0, 2);
  model.remove(sid, 'row', 11, 1); // the last row of both (was 9, now 11)
  assert.deepEqual(model.dropdowns(sid).map((d) => [d.r1, d.r2]), [[3, 10]]);
  assert.deepEqual(model.colourRules(sid).map((d) => [d.r1, d.r2]), [[3, 10]]);
  model.remove(sid, 'col', 2, 1);
  assert.equal(model.dropdowns(sid).length, 0, 'its only column deleted: gone');
});

test('a sheet without a lists map still opens; junk in it is skipped; snapshot, load and duplicate carry dropdowns', () => {
  const { doc, model, sid } = freshModel();
  assert.deepEqual(model.dropdowns(sid), []);
  model.addDropdown(sid, { r1: 1, c1: 0, r2: 3, c2: 0 }, ATT);
  doc.transact(() => {
    const lists = (doc.getMap('sheets').get(sid) as Y.Map<unknown>).get('lists') as Y.Map<unknown>;
    lists.set('junk1', 42);
    lists.set('junk2', { items: [], r1: 'r0', c1: 'c0', r2: 'r1', c2: 'c0' });
  });
  assert.equal(model.dropdowns(sid).length, 1);
  const snap = model.snapshot();
  assert.deepEqual(snap.sheets[0]!.dropdowns, [{ r1: 1, c1: 0, r2: 3, c2: 0, ...ATT }]);
  const other = freshModel();
  const loaded = other.model.load(snap, 'replace')!;
  assert.deepEqual(other.model.dropdowns(loaded).map(({ id: _id, ...d }) => d), snap.sheets[0]!.dropdowns);
  assert.equal(model.dropdowns(model.duplicateSheet(sid)).length, 1);
});

function book(): WorkbookData {
  const s = emptySheet('Attendance');
  s.cells.set(cellKey(0, 0), { input: 'Name' });
  s.dropdowns = [
    { r1: 1, c1: 1, r2: 30, c2: 1, ...ATT },
    { r1: 1, c1: 2, r2: 30, c2: 2, items: ['Paid', 'Due', 'Say "hi"'], strict: false },
    { r1: 1, c1: 3, r2: 30, c2: 3, items: ['One, two', 'Three'], strict: true },            // a comma: cannot be written
    { r1: 1, c1: 4, r2: 30, c2: 4, items: Array.from({ length: 60 }, (_, i) => `Choice ${i}`), strict: true }, // > 255 chars
  ];
  s.rules = [{ r1: 1, c1: 1, r2: 30, c2: 1, kind: 'eq', a: 'Absent', style: { bg: '#f4c7c3' } }];
  return { sheets: [s] };
}

test('.xlsx: dropdowns are written as list validations after the colour rules; what Excel cannot hold is left out', async () => {
  const files = await readZip(await writeXlsx(book()));
  const sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  assert.match(sheet, /<dataValidations count="2">/, 'the two that fit; the comma and the long list are left out');
  assert.match(sheet, /<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B2:B31"><formula1>&quot;Present,Absent,Leave&quot;<\/formula1>/);
  assert.match(sheet, /showErrorMessage="0" sqref="C2:C31"><formula1>&quot;Paid,Due,Say &quot;&quot;hi&quot;&quot;&quot;<\/formula1>/);
  assert.ok(sheet.indexOf('<conditionalFormatting') < sheet.indexOf('<dataValidations'), 'conditionalFormatting first');
  assert.ok(sheet.indexOf('<dataValidations') < sheet.indexOf('<pageMargins'), 'before pageMargins');
});

test('.xlsx: dropdowns read back as written (the two that fit)', async () => {
  const back = await readXlsx(await writeXlsx(book()));
  assert.deepEqual(back.sheets[0]!.dropdowns, book().sheets[0]!.dropdowns!.slice(0, 2));
});

test('.xlsx import: a list from cells on the same sheet is read as values; other sheets, names and other types are dropped', async () => {
  const files = await readZip(await writeXlsx(book()));
  let sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  // Source cells for the same-sheet list: H2:H4 = Red, Green, Blue (inline strings).
  sheet = sheet.replace('<sheetData>', '<sheetData>'.concat(
    ...['Red', 'Green', 'Blue'].map((v, i) => `<row r="${i + 40}"><c r="H${i + 40}" t="inlineStr"><is><t>${v}</t></is></c></row>`)));
  sheet = sheet.replace('</dataValidations>',
    '<dataValidation type="list" showErrorMessage="1" sqref="F2:F9"><formula1>$H$40:$H$42</formula1></dataValidation>' +
    '<dataValidation type="list" sqref="G2:G9"><formula1>Lists!$A$1:$A$3</formula1></dataValidation>' +
    '<dataValidation type="list" sqref="I2:I9"><formula1>MyNamedRange</formula1></dataValidation>' +
    '<dataValidation type="whole" operator="between" sqref="J2:J9"><formula1>1</formula1><formula2>10</formula2></dataValidation>' +
    '</dataValidations>');
  // The <row>s must stay in order for a strict reader; ours accepts any order, Excel's writer never makes this.
  files.set('xl/worksheets/sheet1.xml', new TextEncoder().encode(sheet));
  const back = await readXlsx(await writeZip([...files].map(([name, data]) => ({ name, data }))));
  const dds = back.sheets[0]!.dropdowns!;
  assert.deepEqual(dds.find((d) => d.c1 === 5), { r1: 1, c1: 5, r2: 8, c2: 5, items: ['Red', 'Green', 'Blue'], strict: true });
  assert.equal(dds.filter((d) => d.c1 >= 6).length, 0, 'other sheet, a name, a whole-number rule: none kept');
});
