// ============================================================================
//  The older-Excel hint on .xlsx download (Amit, 3 Oct 2026; design §4a).
//  Excel 2019 and older show #NAME? for XLOOKUP and friends even though our
//  file stores them correctly, so the download names the ones a workbook uses.
//    node --import ./tests/sheets/register.mjs --test tests/sheets/older-excel.test.ts
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWER_THAN_EXCEL_2019, excelPrefixes, functionsNeedingNewerExcel, olderExcelNote,
} from '../../apps/web/lib/sheets/io/xlsx.ts';
import { FUNCTION_NAMES } from '../../apps/web/lib/sheets/engine/functions/index.ts';
import { cellKey, emptySheet, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';

/** A workbook whose first sheet holds these inputs down column A. */
function book(...inputs: string[]): WorkbookData {
  const s = emptySheet('Sheet1');
  inputs.forEach((input, r) => s.cells.set(cellKey(r, 0), { input, value: null }));
  return { sheets: [s] } as WorkbookData;
}

test('a workbook using XLOOKUP gets the hint, naming it', () => {
  const names = functionsNeedingNewerExcel(book('=XLOOKUP(5,B1:B9,C1:C9)', '=SUM(B1:B9)'));
  assert.deepEqual(names, ['XLOOKUP']);
  assert.equal(olderExcelNote(names),
    'This workbook uses XLOOKUP. It works in Excel 2021 and Microsoft 365; older Excel shows #NAME? in those cells.');
});

test('a workbook with nothing newer than Excel 2019 gets no hint', () => {
  const names = functionsNeedingNewerExcel(book(
    '=VLOOKUP(5,B1:C9,2,FALSE)', '=IFS(A1>1,"big",TRUE,"small")', '=TEXTJOIN(",",TRUE,B1:B9)',
    '="XLOOKUP(1,2,3)"',      // the name inside text is not a call
    'XLOOKUP(1,2,3)',         // not a formula at all
    "='XMATCH(x'!A1",          // a sheet called "XMATCH(x"
  ));
  assert.deepEqual(names, []);
  assert.equal(olderExcelNote(names), null);
});

test('lower case counts, several are listed, and a Microsoft 365-only one says so', () => {
  const names = functionsNeedingNewerExcel(book('=xlookup(1,B1:B2,C1:C2)', '=REGEXEXTRACT(B1,"[0-9]+")', '=XLOOKUP(2,B1:B2,C1:C2)'));
  assert.deepEqual(names, ['REGEXEXTRACT', 'XLOOKUP']);
  assert.equal(olderExcelNote(names),
    'This workbook uses REGEXEXTRACT and XLOOKUP. They work in Microsoft 365; older Excel shows #NAME? in those cells.');
  assert.equal(olderExcelNote(['CHOOSECOLS', 'XMATCH', 'XLOOKUP']),
    'This workbook uses CHOOSECOLS, XMATCH and XLOOKUP. They work in Microsoft 365; older Excel shows #NAME? in those cells.');
});

test('an unsafe formula is written as text, so it does not count', () => {
  // The | makes it a DDE call-out (safety.ts): cellXml writes the typed text, not a formula.
  assert.deepEqual(functionsNeedingNewerExcel(book("=XLOOKUP(1,B1:B2,C1:C2)&cmd|'/c calc'!A0")), []);
});

// Prefixed functions the engine has that Excel 2019 already knows (2010–2019).
// A new engine function that is prefixed must be added here or to
// NEWER_THAN_EXCEL_2019 in xlsx.ts. Choose by checking Microsoft's page for it.
const FINE_IN_EXCEL_2019 = [
  // Excel 2010
  'MODE.SNGL', 'NETWORKDAYS.INTL', 'PERCENTILE.INC', 'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ',
  'STDEV.P', 'STDEV.S', 'VAR.P', 'VAR.S', 'WORKDAY.INTL',
  // Excel 2013
  'DAYS', 'IFNA', 'ISFORMULA', 'ISOWEEKNUM', 'UNICHAR', 'UNICODE', 'XOR',
  // Excel 2019
  'CONCAT', 'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'TEXTJOIN',
];

test('every prefixed engine function is classified, and the hint names only real ones', () => {
  const prefixed = FUNCTION_NAMES.filter(excelPrefixes);
  const unclassified = prefixed.filter((n) => !NEWER_THAN_EXCEL_2019.has(n) && !FINE_IN_EXCEL_2019.includes(n));
  assert.deepEqual(unclassified, [], `classify these in older-excel.test.ts or xlsx.ts: ${JSON.stringify(unclassified)}`);
  for (const n of NEWER_THAN_EXCEL_2019.keys()) {
    assert.ok(FUNCTION_NAMES.includes(n), `${n} is in the hint list but the engine has no such function`);
    assert.ok(excelPrefixes(n), `${n} is in the hint list but is not written with a prefix`);
  }
});
