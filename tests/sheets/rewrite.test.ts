// ============================================================================
//  Formula rewriting: copy/paste, inserted and deleted rows, renamed sheets.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateFormula, shiftFormula, renameSheetInFormula, dropSheetInFormula,
} from '../../apps/web/lib/sheets/engine/rewrite.ts';

test('copying moves relative references and keeps absolute ones', () => {
  assert.equal(translateFormula('=A1+$B$1+$C1+D$1', 1, 1), '=B2+$B$1+$C2+E$1');
  assert.equal(translateFormula('=SUM(A1:A10)', 2, 0), '=SUM(A3:A12)');
  assert.equal(translateFormula('=SUM(A:A)', 5, 1), '=SUM(B:B)');
  assert.equal(translateFormula('=Fees!A1*2', 1, 0), '=Fees!A2*2');
  assert.equal(translateFormula("='Fee 2026'!B2", 0, 1), "='Fee 2026'!C2");
});

test('copying leaves text, function names and spacing alone', () => {
  assert.equal(translateFormula('=IF(A1 > 0, "A1", log10(A1))', 1, 0), '=IF(A2 > 0, "A1", log10(A2))');
  assert.equal(translateFormula('15000', 1, 1), '15000');
});

test('copying a reference off the top of the grid makes #REF!', () => {
  assert.equal(translateFormula('=A1+1', -1, 0), '=#REF!+1');
  assert.equal(translateFormula('=SUM(A1:A3)', -1, 0), '=SUM(#REF!)');
});

test('inserting rows moves references below the insertion point', () => {
  assert.equal(shiftFormula('=A1+A5', 'Sheet1', 'Sheet1', 'row', 2, 3), '=A1+A8');
  assert.equal(shiftFormula('=SUM(A1:A10)', 'Sheet1', 'Sheet1', 'row', 4, 2), '=SUM(A1:A12)');
  assert.equal(shiftFormula('=$A$5', 'Sheet1', 'Sheet1', 'row', 0, 1), '=$A$6');
  // Another sheet's insertion does not touch unqualified references…
  assert.equal(shiftFormula('=A5', 'Sheet1', 'Fees', 'row', 0, 1), '=A5');
  // …but does touch references qualified with it.
  assert.equal(shiftFormula('=Fees!A5', 'Sheet1', 'Fees', 'row', 0, 1), '=Fees!A6');
});

test('deleting rows: references move up, deleted cells become #REF!, ranges shrink', () => {
  assert.equal(shiftFormula('=A10', 'S', 'S', 'row', 2, -3), '=A7');
  assert.equal(shiftFormula('=A3+1', 'S', 'S', 'row', 2, -3), '=#REF!+1');
  assert.equal(shiftFormula('=SUM(A1:A10)', 'S', 'S', 'row', 2, -3), '=SUM(A1:A7)');
  assert.equal(shiftFormula('=SUM(A3:A4)', 'S', 'S', 'row', 2, -3), '=SUM(#REF!)');
  assert.equal(shiftFormula('=SUM(A4:A10)', 'S', 'S', 'row', 2, -3), '=SUM(A3:A7)');
});

test('inserting and deleting columns', () => {
  assert.equal(shiftFormula('=C1+A1', 'S', 'S', 'col', 1, 1), '=D1+A1');
  assert.equal(shiftFormula('=SUM(B:D)', 'S', 'S', 'col', 0, -1), '=SUM(A:C)');
  assert.equal(shiftFormula('=B1', 'S', 'S', 'col', 1, -1), '=#REF!');
});

test('renaming and deleting sheets', () => {
  assert.equal(renameSheetInFormula('=Fees!A1+fees!B1+A1', 'Fees', 'Fee 2026'), "='Fee 2026'!A1+'Fee 2026'!B1+A1");
  assert.equal(renameSheetInFormula("='Old name'!A1", 'Old name', 'New'), '=New!A1');
  assert.equal(dropSheetInFormula('=Fees!A1+1', 'Fees'), '=#REF!+1');
  assert.equal(dropSheetInFormula('=SUM(Fees!A1:A3)', 'Fees'), '=SUM(#REF!)');
});
