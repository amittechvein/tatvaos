// ============================================================================
//  The Sheets server-render gate's workbooks (docs/SHEETS_SERVER_RENDER_DESIGN.md §5)
// ============================================================================
//
//  Each workbook is built through the editor's OWN model (lib/sheets/model.ts:
//  the same setInputs / setFormat / merge / addSheet calls the editor makes)
//  and saved as its stored Yjs state — exactly what the server holds and the
//  render service will be given. Written ahead of Mr. Singh's ruling (Amit,
//  3 Oct 2026): useful whatever the approach.
//
//    node --import ./tests/sheets/register.mjs tests/sheets-render/make-fixtures.mjs [out-dir-for-xlsx]
//
//  Writes tests/sheets-render/fixtures/<name>.json: {name, about, state
//  (base64), cells, formulas, expect}. "expect" holds values worked out BY
//  HAND, checked against the model here, so a fixture cannot quietly carry a
//  wrong answer. With an out-dir it also writes what the existing checks in
//  tests/sheets-xlsx-guard/ read: ours--<name>.xlsx as the editor writes it
//  (snapshot -> writeXlsx), ours--<name>.expected.json (what OUR engine says
//  each cell is — from the model itself, so every sheet's real size counts;
//  make-ours.ts assumes 1,000 rows) and control--cut-short.xlsx (a sheet cut
//  off halfway, which Excel must refuse — the Excel check's red first):
//
//    OURS=<out-dir> dotnet run --project tests/sheets-xlsx-guard -c Release
//    pwsh tests/sheets-xlsx-guard/excel-check.ps1 <out-dir>
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
// The web app's own yjs, the copy the model imports: two copies would not share types.
import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx';
import { readZip, writeZip } from '../../apps/web/lib/sheets/io/zip';
import { formulaIsSafe } from '../../apps/web/lib/sheets/io/safety';

const OUT = new URL('./fixtures/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const XLSX_DIR = process.argv[2] ?? null;
if (XLSX_DIR) mkdirSync(XLSX_DIR, { recursive: true });

/** Column letter -> index, "A1" -> {r, c}. */
const at = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { r: Number(m[2]) - 1, c };
};
const rect = (a, b = a) => { const p = at(a), q = at(b); return { r1: p.r, c1: p.c, r2: q.r, c2: q.c }; };

function workbook() {
  const doc = new Y.Doc();
  const model = new SheetsModel(doc);
  model.ensureSeeded();
  return { doc, model, first: model.sheetIds()[0] };
}
const put = (model, sheet, cells) => model.setInputs(sheet, Object.entries(cells).map(([ref, input]) => ({ ...at(ref), input })));

const results = [];
const colName = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** What our engine says every cell is, in excel-check.ps1's shape. */
function expectedOf(model) {
  const all = {};
  for (const meta of model.sheets()) {
    const cells = {};
    const snapSheet = model.snapshot().sheets.find((x) => x.name === meta.name);
    for (const [key, cell] of snapSheet.cells) {
      const input = cell.input ?? '';
      if (input === '') continue;
      const [r, c] = key.split(',').map(Number);
      const a1 = `${colName(c)}${r + 1}`;
      if (input.startsWith('=') && !formulaIsSafe(input)) { cells[a1] = { text: input }; continue; }
      const v = model.value(meta.id, r, c);
      cells[a1] = v !== null && typeof v === 'object' ? { error: v.code }
        : input.startsWith('=') ? { formula: input, value: v } : { value: v };
    }
    all[meta.name] = cells;
  }
  return all;
}
let controlSource = null;
async function save(name, about, { doc, model }, expect) {
  // Every hand-worked answer must be what the model computes.
  for (const [where, want] of Object.entries(expect)) {
    const [sheetName, ref] = where.includes('!') ? where.split('!') : [null, where];
    const sheet = sheetName ? model.sheets().find((s) => s.name === sheetName)?.id : model.sheetIds()[0];
    const { r, c } = at(ref);
    const got = model.value(sheet, r, c);
    const same = typeof want === 'number' ? Math.abs(Number(got) - want) < 1e-9 : got === want;
    if (!same) throw new Error(`${name}: ${where} is ${JSON.stringify(got)}, worked out by hand as ${JSON.stringify(want)}`);
  }
  const snap = model.snapshot();
  let cells = 0, formulas = 0;
  for (const s of snap.sheets) for (const cell of s.cells.values()) { if (cell.input != null) { cells += 1; if (String(cell.input).startsWith('=')) formulas += 1; } }
  const state = Y.encodeStateAsUpdate(doc);
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify({
    name, about, cells, formulas, expect, state: Buffer.from(state).toString('base64'),
  }, null, 1)}\n`);
  // The editor's own path, read back: every input survives the .xlsx.
  const bytes = await writeXlsx(snap);
  const back = await readXlsx(bytes);
  let lost = 0;
  snap.sheets.forEach((s, i) => { for (const [k, cell] of s.cells) if (cell.input != null && back.sheets[i]?.cells.get(k)?.input == null) lost += 1; });
  if (XLSX_DIR) {
    writeFileSync(`${XLSX_DIR}/ours--${name}.xlsx`, bytes);
    writeFileSync(`${XLSX_DIR}/ours--${name}.expected.json`, JSON.stringify(expectedOf(model), null, 1));
    if (!controlSource) controlSource = bytes;
  }
  results.push({ name, sheets: snap.sheets.length, cells, formulas, stateKB: (state.length / 1024).toFixed(1), xlsxKB: (bytes.length / 1024).toFixed(1), lostOnReadBack: lost });
}

// ---- 1. a formula from every family ------------------------------------------
{
  const w = workbook(); const { model, first: s } = w;
  put(model, s, {
    A1: 'Student', B1: 'Fees', C1: 'Paid', D1: 'Joined', E1: 'Class',
    A2: 'asha', B2: '15000', C2: '15000', D2: '2026-04-01', E2: 'VI',
    A3: 'ravi kumar', B3: '18000', C3: '9000', D3: '2026-04-15', E3: 'VII',
    A4: 'meena', B4: '15000', C4: '0', D4: '2026-06-10', E4: 'VI',
    A5: ' john  ', B5: '21000', C5: '21000', D5: '2026-07-01', E5: 'VIII',
    // math
    G1: '=SUM(B2:B5)', G2: '=AVERAGE(B2:B5)', G3: '=ROUND(G2/7,2)', G4: '=MAX(B2:B5)-MIN(B2:B5)',
    G5: '=SUMPRODUCT(B2:B5,C2:C5)/1000', G6: '=MOD(G1,7)', G7: '=POWER(2,10)', G8: '=CEILING(G2,1000)',
    // stats
    H1: '=LARGE(B2:B5,2)', H2: '=SMALL(B2:B5,1)',
    // text
    I1: '=UPPER(A2)', I2: '=PROPER(A3)', I3: '=TRIM(A5)', I4: '=LEN(A3)', I5: '=CONCATENATE(A2," - ",E2)',
    I6: '=SUBSTITUTE(A3," ","_")', I7: '=TEXTJOIN(", ",TRUE,E2:E5)', I8: '=LEFT(A3,4)',
    // logical
    J1: '=IF(C2>=B2,"paid","due")', J2: '=IFS(C3=0,"none",C3<B3,"part",TRUE,"full")', J3: '=AND(C2>0,C5>0)',
    J4: '=OR(C4>0,C3>0)', J5: '=IFERROR(1/0,"no division")', J6: '=SWITCH(E4,"VI","junior","VIII","senior","other")',
    // lookup
    K1: '=VLOOKUP("meena",A2:C5,2,FALSE)', K2: '=INDEX(C2:C5,MATCH("ravi kumar",A2:A5,0))', K3: '=XLOOKUP("asha",A2:A5,E2:E5)',
    // date
    L1: '=DATE(2026,10,3)', L2: '=EDATE(L1,1)', L3: '=EOMONTH(L1,0)', L4: '=DATEDIF(D2,L1,"m")', L5: '=WEEKDAY(L1)',
    L6: '=NETWORKDAYS(DATE(2026,10,1),DATE(2026,10,31))', L7: '=DAYS(L3,L1)',
    // info
    M1: '=ISBLANK(F1)', M2: '=ISNUMBER(B2)', M3: '=ISTEXT(A2)', M4: '=ISERROR(1/0)',
    // conditional
    N1: '=COUNTIF(E2:E5,"VI")', N2: '=SUMIF(E2:E5,"VI",B2:B5)', N3: '=COUNTIFS(E2:E5,"VI",C2:C5,">0")',
    N4: '=AVERAGEIF(E2:E5,"VI",B2:B5)', N5: '=MAXIFS(B2:B5,E2:E5,"VI")',
  });
  await save('formulas-every-family', 'One formula or more from each family the engine has: math, stats, text, logical, lookup, date, info, conditional. No volatile functions.', w, {
    G1: 69000, G2: 17250, G6: 69000 % 7, G7: 1024, G8: 18000, H1: 18000, H2: 15000,
    I1: 'ASHA', I2: 'Ravi Kumar', I3: 'john', I4: 10, I5: 'asha - VI', I6: 'ravi_kumar', I7: 'VI, VII, VI, VIII', I8: 'ravi',
    J1: 'paid', J2: 'part', J3: true, J4: true, J5: 'no division', J6: 'junior',
    K1: 15000, K2: 9000, K3: 'VI', L4: 6, L7: 28, M1: true, M2: true, M3: true, M4: true,
    N1: 2, N2: 30000, N3: 1, N4: 15000, N5: 15000,
  });
}

// ---- 2. several sheets that refer to each other ---------------------------------
{
  const w = workbook(); const { model, first: s1 } = w;
  model.renameSheet(s1, 'Students');
  put(model, s1, { A1: 'Name', B1: 'Class', A2: 'Asha', B2: 'VI', A3: 'Ravi', B3: 'VII', A4: 'Meena', B4: 'VI' });
  const s2 = model.addSheet(s1, 'Fees');
  put(model, s2, { A1: 'Name', B1: 'Amount', A2: '=Students!A2', B2: '15000', A3: '=Students!A3', B3: '18000', A4: '=Students!A4', B4: '15000' });
  const s3 = model.addSheet(s2, 'Summary and totals');
  put(model, s3, { A1: 'Total fees', B1: '=SUM(Fees!B2:B4)', A2: 'Class VI', B2: "=SUMIF(Students!B2:B4,\"VI\",Fees!B2:B4)", A3: 'First student', B3: "='Students'!A2" });
  model.setSheetProp(s3, 'tabColor', '#1a73e8');
  model.moveSheet(s3, -1); // Summary before Fees: order is part of the workbook
  const s4 = model.addSheet(s3, 'Notes');
  put(model, s4, { A1: 'Hidden working sheet' });
  model.setSheetProp(s4, 'hidden', true);
  await save('multi-sheet', 'Four sheets: cross-sheet references (incl. a quoted name with spaces), a moved sheet, a tab colour, a hidden sheet.', w, {
    'Summary and totals!B1': 48000, 'Summary and totals!B2': 30000, 'Summary and totals!B3': 'Asha', 'Fees!A3': 'Ravi',
  });
}

// ---- 3. merges, formats, borders, sizes -------------------------------------------
{
  const w = workbook(); const { model, first: s } = w;
  put(model, s, {
    A1: 'Annual fee statement 2026-27',
    A2: 'Item', B2: 'Amount', C2: 'Share', D2: 'Due',
    A3: 'Tuition', B3: '150000', C3: '=B3/B6', D3: '2026-04-10',
    A4: 'Transport', B4: '24000', C4: '=B4/B6', D4: '2026-05-10',
    A5: 'Books', B5: '6000', C5: '=B5/B6', D5: '2026-06-10',
    A6: 'Total', B6: '=SUM(B3:B5)', C6: '=SUM(C3:C5)',
    A8: 'Left', B8: 'Centre', C8: 'Right', A9: 'A long sentence that should wrap inside its cell rather than run across.',
  });
  model.merge(s, rect('A1', 'D1'), 'all');
  model.merge(s, rect('A9', 'D10'), 'all');
  model.setFormat(s, rect('A1'), { b: true, size: 16, ha: 'center', bg: '#fff2cc', font: 'Georgia' });
  model.setFormat(s, rect('A2', 'D2'), { b: true, bg: '#d9ead3', color: '#274e13' });
  model.setFormat(s, rect('A3'), { i: true }); model.setFormat(s, rect('A4'), { u: true }); model.setFormat(s, rect('A5'), { s: true });
  model.setFormat(s, rect('B3', 'B6'), { nf: '#,##,##0' });
  model.setFormat(s, rect('C3', 'C6'), { nf: '0.0%' });
  model.setFormat(s, rect('D3', 'D5'), { nf: 'dd/mm/yyyy' });
  model.setFormat(s, rect('A6', 'D6'), { b: true, color: '#cc0000' });
  model.setFormat(s, rect('A8'), { ha: 'left' }); model.setFormat(s, rect('B8'), { ha: 'center', va: 'middle' }); model.setFormat(s, rect('C8'), { ha: 'right', va: 'bottom' });
  model.setFormat(s, rect('A9'), { wrap: 'wrap', va: 'top' });
  model.setBorders(s, rect('A2', 'D6'), 'all', { style: 'thin', color: '#666666' });
  model.setBorders(s, rect('A6', 'D6'), 'top', { style: 'double', color: '#000000' });
  model.setColWidth(s, [0], 160); model.setColWidth(s, [1, 2], 110);
  model.setRowHeight(s, [0], 36); model.setRowHeight(s, [8], 48);
  model.freeze(s, 2, 1);
  await save('merges-and-formats', 'Merged title and paragraph, bold/italic/underline/strike, font, size, colours, fills, alignment, wrap, Indian-grouped currency, %, dd/mm/yyyy dates, borders (thin all + double top), column widths, row heights, a frozen pane.', w, {
    B6: 180000, C6: 1,
  });
}

// ---- 4. dates, and the clock (the time-zone check) --------------------------------
{
  const w = workbook(); const { model, first: s } = w;
  model.setLocale('indian', 'dmy');
  put(model, s, {
    A1: 'Fixed date', B1: '=DATE(2026,10,3)', A2: 'Plus one month', B2: '=EDATE(B1,1)', A3: 'Month end', B3: '=EOMONTH(B1,0)',
    A4: 'Weekday (1=Sun)', B4: '=WEEKDAY(B1)', A5: 'Typed date', B5: '03/10/2026', A6: 'Same day?', B6: '=B5=B1',
    // The clock: the server must read India time (Amit, 2 Oct 2026). The gate
    // builds this at 00:30 IST and checks TODAY() is that day, not the day before.
    A8: 'Today', B8: '=TODAY()', A9: 'Now', B9: '=NOW()', A10: 'Days to month end', B10: '=EOMONTH(TODAY(),0)-TODAY()',
  });
  model.setFormat(s, rect('B1', 'B3'), { nf: 'dd/mm/yyyy' }); model.setFormat(s, rect('B5'), { nf: 'dd/mm/yyyy' });
  model.setFormat(s, rect('B8'), { nf: 'dd/mm/yyyy' }); model.setFormat(s, rect('B9'), { nf: 'dd/mm/yyyy hh:mm' });
  await save('dates-and-today', 'Fixed dates and date arithmetic in the Indian day-first locale, a typed dd/mm/yyyy date, and the volatile TODAY()/NOW() the time-zone check reads.', w, {
    B4: 7, B6: true,
  });
}

// ---- 5. Hindi and Marathi -----------------------------------------------------
{
  const w = workbook(); const { model, first: s } = w;
  model.renameSheet(s, 'शुल्क विवरण');
  model.setLocale('indian', 'dmy');
  put(model, s, {
    A1: 'छात्र का नाम', B1: 'कक्षा', C1: 'वार्षिक शुल्क',
    A2: 'आशा शर्मा', B2: 'छठी', C2: '150000',
    A3: 'रवि कुमार', B3: 'सातवीं', C3: '175000',
    A4: 'मीना पाटील', B4: 'छठी', C4: '150000',
    A6: 'कुल', C6: '=SUM(C2:C4)', A7: 'छठी कक्षा', C7: '=SUMIF(B2:B4,"छठी",C2:C4)',
    A8: 'नाम की लंबाई', C8: '=LEN(A2)', A9: 'जोड़', C9: '=CONCATENATE(A2," (",B2,")")',
    A11: 'शाळेची वेळ सकाळी ९ ते दुपारी २', A12: 'महाराष्ट्र राज्य शिक्षण मंडळ, पुणे',
  });
  model.setFormat(s, rect('C2', 'C7'), { nf: '₹#,##,##0' });
  model.setFormat(s, rect('A1', 'C1'), { b: true, font: 'Noto Sans Devanagari' });
  await save('hindi-text', 'A Hindi-named sheet, Hindi and Marathi text, formulas over Devanagari text (SUMIF on a Hindi value, LEN, CONCATENATE), rupee format in Indian grouping.', w, {
    C6: 475000, C7: 300000, C8: 9, C9: 'आशा शर्मा (छठी)',
  });
}

// ---- 6. large: 20,000 cells ---------------------------------------------------------
{
  const w = workbook(); const { model, first: s } = w;
  model.growTo(s, 2002, 12);
  const rows = 2000;
  const heading = {}; ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((L, i) => { heading[`${L}1`] = `Term ${i + 1}`; });
  heading.I1 = 'Total'; heading.J1 = 'With GST';
  put(model, s, heading);
  for (let start = 0; start < rows; start += 250) {
    const entries = [];
    for (let i = start; i < Math.min(rows, start + 250); i += 1) {
      const r = i + 1;
      for (let c = 0; c < 8; c += 1) entries.push({ r, c, input: String(1000 + ((i * 37 + c * 11) % 500)) });
      entries.push({ r, c: 8, input: `=SUM(A${r + 1}:H${r + 1})` });
      entries.push({ r, c: 9, input: `=ROUND(I${r + 1}*1.18,2)` });
    }
    model.setInputs(s, entries);
  }
  put(model, s, { H2002: 'Grand total', I2002: `=SUM(I2:I${rows + 1})`, J2002: `=SUM(J2:J${rows + 1})` });
  // Hand-worked: row 2 (i=0) is 1000,1011,...,1077 -> 8000 + 11*28 = 8308.
  let grand = 0; for (let i = 0; i < rows; i += 1) for (let c = 0; c < 8; c += 1) grand += 1000 + ((i * 37 + c * 11) % 500);
  await save('large', '2,000 rows x 10 columns = 20,000 cells (4,000 formulas) plus a grand total: the size check (10 s, 512 MB, 1 CPU).', w, {
    I2: 8308, J2: 9803.44, I2002: grand,
  });
}

// ---- 7. formulas that must never reach a file as formulas ------------------------
{
  const w = workbook(); const { model, first: s } = w;
  put(model, s, {
    A1: 'Ordinary', B1: '=SUM(1,2)', A2: 'Safe link', B2: '=HYPERLINK("https://tatvaos.com","TatvaOS")',
    A3: 'Calls out', B3: '=WEBSERVICE("https://example.com/x")', A4: 'Script link', B4: '=HYPERLINK("javascript:alert(1)","click")',
    A5: 'DDE', B5: "=cmd|'/c calc'!A1", A6: 'Import', B6: '=IMPORTXML("https://example.com","//a")',
    A7: 'Text that looks like a formula', B7: "'=1+1",
  });
  await save('unsafe-formulas', 'Calling-out and script formulas (WEBSERVICE, javascript: HYPERLINK, DDE, IMPORTXML) beside ordinary ones: the writer must turn the unsafe ones into text, so XlsxGuard passes the file; a safe HYPERLINK stays a formula.', w, {
    B1: 3,
  });
}

if (XLSX_DIR && controlSource) {
  // The control: the first workbook with its first sheet cut off halfway.
  const parts = await readZip(controlSource);
  const files = [...parts].map(([name, data]) => ({
    name, data: name === 'xl/worksheets/sheet1.xml' ? data.slice(0, Math.floor(data.length / 2)) : data,
  }));
  writeFileSync(`${XLSX_DIR}/control--cut-short.xlsx`, await writeZip(files));
}
console.table(results);
