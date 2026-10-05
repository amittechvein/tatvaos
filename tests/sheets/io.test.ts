// ============================================================================
//  File import and export: the ZIP container, .xlsx, and CSV/TSV.
//    node --import ./tests/sheets/register.mjs --test tests/sheets/
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip, writeZip, crc32 } from '../../apps/web/lib/sheets/io/zip.ts';
import { readXlsx, writeXlsx, parseXml, shiftFormula } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { readCsv, writeCsv } from '../../apps/web/lib/sheets/io/csv.ts';
import { CellError } from '../../apps/web/lib/sheets/engine/types.ts';
import { cellKey, emptySheet, type SheetData, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const at = (s: SheetData, a1: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
  return s.cells.get(cellKey(Number(m[2]) - 1, c - 1));
};

// ---------------------------------------------------------------------------
//  ZIP
// ---------------------------------------------------------------------------

test('zip: stored and deflated entries round-trip byte for byte', async () => {
  const big = enc.encode('<row>hello</row>'.repeat(2000));      // compresses well → deflated
  const tiny = new Uint8Array([1, 2, 3]);                          // would grow → stored
  const unicode = enc.encode('₹1,25,000 — नमस्ते');
  const zip = await writeZip([
    { name: 'xl/big.xml', data: big }, { name: 'tiny.bin', data: tiny }, { name: 'docs/नाम.txt', data: unicode },
  ]);
  assert.ok(zip.length < big.length / 10, 'the big entry was deflated');
  const files = await readZip(zip);
  assert.deepEqual([...files.keys()], ['xl/big.xml', 'tiny.bin', 'docs/नाम.txt']);
  assert.deepEqual(files.get('xl/big.xml'), big);
  assert.deepEqual(files.get('tiny.bin'), tiny);
  assert.equal(dec.decode(files.get('docs/नाम.txt')), '₹1,25,000 — नमस्ते');
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926); // the standard check value
});

test('zip: a damaged entry fails its CRC check; junk and zip64 are refused', async () => {
  const data = enc.encode('abc');
  const zip = await writeZip([{ name: 'a.txt', data }]);   // stored: 30 + 5 name bytes, then "abc"
  const bad = zip.slice();
  bad[35] = 'x'.charCodeAt(0);
  await assert.rejects(readZip(bad), /CRC/);
  await assert.rejects(readZip(enc.encode('not a zip at all')), /not a ZIP/);
  const z64 = zip.slice();
  const end = z64.length - 22;
  z64[end + 10] = 0xff; z64[end + 11] = 0xff;              // entry count 0xFFFF means zip64
  await assert.rejects(readZip(z64), /ZIP64/);
});

test('zip: an entry that inflates past what it claims is refused', async () => {
  const zip = await writeZip([{ name: 'bomb.xml', data: new Uint8Array(100_000) }]);
  const lied = zip.slice();
  // Rewrite the uncompressed size in the central directory to claim 10 bytes.
  const cd = lied.length - 22 - (46 + 'bomb.xml'.length);
  new DataView(lied.buffer).setUint32(cd + 24, 10, true);
  await assert.rejects(readZip(lied), /larger than it claims/);
});

test('xml: DOCTYPE is refused, entities and CDATA are read, prefixes dropped', () => {
  assert.throws(() => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /DOCTYPE/);
  assert.throws(() => parseXml('<x>&unknown;</x>'), /entity/);
  const n = parseXml('<?xml version="1.0"?><!-- c --><x:a xmlns:x="u" x:k="1 &amp; 2">&lt;&#65;&#x42;<![CDATA[<raw>]]></x:a>');
  assert.equal(n.name, 'a');
  assert.equal(n.attrs.k, '1 & 2');
  assert.equal(n.text, '<AB<raw>');
  assert.throws(() => parseXml('<a><b></a>'), /Mismatched/);
});

// ---------------------------------------------------------------------------
//  Formula shifting
// ---------------------------------------------------------------------------

test('shiftFormula moves relative references only, and leaves strings alone', () => {
  assert.equal(shiftFormula('A1*2', 1, 0), 'A2*2');
  assert.equal(shiftFormula('$A1+A$1+$A$1', 2, 1), '$A3+B$1+$A$1');
  assert.equal(shiftFormula('SUM(A1:B2)&"A1"', 1, 1), 'SUM(B2:C3)&"A1"');
  assert.equal(shiftFormula("'My Sheet'!A1+Data!B2", 1, 0), "'My Sheet'!A2+Data!B3");
  assert.equal(shiftFormula('SUM(A:A)+SUM(1:1)+LOG10(A1)', 1, 1), 'SUM(B:B)+SUM(2:2)+LOG10(B2)');
  assert.equal(shiftFormula('A1', -1, 0), '#REF!');
  assert.equal(shiftFormula('Table1[Amount]+Rate2026', 1, 0), 'Table1[Amount]+Rate2026');
});

// ---------------------------------------------------------------------------
//  .xlsx round trip
// ---------------------------------------------------------------------------

function sampleWorkbook(): WorkbookData {
  const fees = emptySheet('Fees 2026');
  const set = (s: SheetData, r: number, c: number, cell: SheetData['cells'] extends Map<string, infer V> ? V : never) =>
    s.cells.set(cellKey(r, c), cell);
  set(fees, 0, 0, { input: 'Student', format: { b: true, bg: '#fce8b2', ha: 'center', va: 'middle' } });
  set(fees, 0, 1, { input: 'Amount', format: { b: true, i: true, u: true, color: '#1a73e8', font: 'Roboto', size: 12 } });
  set(fees, 0, 2, { input: 'Due', format: { s: true, wrap: 'wrap' } });
  set(fees, 1, 0, { input: 'Asha' });
  set(fees, 1, 1, { input: '125000', format: { nf: '#,##0.00' } });
  set(fees, 1, 2, { input: '46289', format: { nf: 'dd/mm/yyyy' } });
  set(fees, 2, 0, { input: "'00123" });                      // forced text keeps its zeros
  set(fees, 2, 1, { input: '0.1' });
  set(fees, 2, 2, { input: 'TRUE' });
  set(fees, 3, 1, { input: '=SUM(B2:B3)', value: 125000.1, format: { nf: '#,##0.00', bt: { style: 'thin', color: '#000000' }, bb: { style: 'double', color: '#d93025' } } });
  set(fees, 3, 0, { input: '=A2&" total"', value: 'Asha total' });
  set(fees, 3, 2, { input: '=C3', value: true });
  set(fees, 4, 0, { input: '=1/0', value: new CellError('#DIV/0!') });
  set(fees, 4, 1, { input: '=XLOOKUP("Asha",A2:A3,B2:B3)', value: 125000 });
  set(fees, 4, 2, { input: '=FILTER(B2:B3,B2:B3>1)', value: 125000 });
  set(fees, 5, 0, { input: null, format: { bl: { style: 'dashed', color: '#188038' }, br: { style: 'medium', color: '#000000' } } });
  set(fees, 5, 1, { input: 'line one\nline two  ' });
  set(fees, 5, 2, { input: '=A1', format: { ha: 'right', va: 'top' } }); // formula with no cached value
  set(fees, 6, 1, { input: 'ctrl\u0001char & <tag> _x0041_ "q"\r\n' }); // XML-hostile text, Excel's _xHHHH_ escape
  fees.merges = [{ r1: 7, c1: 0, r2: 8, c2: 2 }];
  fees.colWidths = { 0: 160, 1: 120, 2: 120 };
  fees.rowHeights = { 0: 32, 10: 50 };
  fees.frozenRows = 1;
  fees.frozenCols = 1;
  fees.tabColor = '#34a853';

  const hidden = emptySheet('Lookups');
  hidden.hidden = true;
  hidden.tabColor = '#ea4335';
  hidden.cells.set(cellKey(0, 0), { input: "='Fees 2026'!B2*2", value: 250000 });
  hidden.cells.set(cellKey(1, 0), { input: '85%' });
  hidden.cells.set(cellKey(2, 0), { input: '#N/A text' });
  return { sheets: [fees, hidden] };
}

test('xlsx: every field of a two-sheet workbook survives write then read', async () => {
  const wb = sampleWorkbook();
  const bytes = await writeXlsx(wb);
  const back = await readXlsx(bytes);

  assert.equal(back.sheets.length, 2);
  const [f, h] = back.sheets as [SheetData, SheetData];
  assert.equal(f.name, 'Fees 2026');
  assert.equal(h.name, 'Lookups');
  assert.equal(f.hidden, undefined);
  assert.equal(h.hidden, true);
  assert.equal(f.tabColor, '#34a853');
  assert.equal(h.tabColor, '#ea4335');
  assert.equal(f.rows, 1000);
  assert.equal(f.cols, 26);
  assert.equal(f.frozenRows, 1);
  assert.equal(f.frozenCols, 1);
  assert.deepEqual(f.merges, [{ r1: 7, c1: 0, r2: 8, c2: 2 }]);
  assert.deepEqual(f.colWidths, { 0: 160, 1: 120, 2: 120 });
  assert.deepEqual(f.rowHeights, { 0: 32, 10: 50 });

  // Every cell of the first sheet, exactly — inputs, values and formats.
  const orig = wb.sheets[0]!;
  assert.deepEqual([...f.cells.keys()].sort(), [...orig.cells.keys()].sort());
  for (const [k, cell] of orig.cells) assert.deepEqual(f.cells.get(k), cell, `cell ${k}`);

  // The second sheet: typed "85%" comes back as its number with the implied format.
  assert.deepEqual(at(h, 'A1'), { input: "='Fees 2026'!B2*2", value: 250000 });
  assert.deepEqual(at(h, 'A2'), { input: '0.85', format: { nf: '0%' } });
  assert.deepEqual(at(h, 'A3'), { input: '#N/A text' });
});

test('xlsx: the written file declares prefixes Excel needs, and dedupes styles', async () => {
  const files = await readZip(await writeXlsx(sampleWorkbook()));
  const sheet1 = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet1, /<f>_xlfn\.XLOOKUP\(&quot;Asha&quot;,A2:A3,B2:B3\)<\/f>/);
  assert.match(sheet1, /<f>_xlfn\._xlws\.FILTER\(/);
  assert.match(sheet1, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  const styles = dec.decode(files.get('xl/styles.xml'));
  assert.match(styles, /<numFmt numFmtId="164" formatCode="dd\/mm\/yyyy"\/>/);
  // "#,##0.00" is built-in 4 and is used twice; it must not appear as a custom format.
  assert.doesNotMatch(styles, /formatCode="#,##0.00"/);
  const workbook = dec.decode(files.get('xl/workbook.xml'));
  assert.match(workbook, /<sheet name="Lookups" sheetId="2" state="hidden" r:id="rId2"\/>/);
});

test('xlsx: sheet names are made legal for Excel', async () => {
  const a = emptySheet('Q1: [draft] / final?*');
  const b = emptySheet('A very long sheet name that goes past thirty-one');
  const c = emptySheet('a very long sheet name that goes past thirty-one too');
  const back = await readXlsx(await writeXlsx({ sheets: [a, b, c] }));
  assert.deepEqual(back.sheets.map((s) => s.name), [
    'Q1_ _draft_ _ final__', 'A very long sheet name that goe', 'a very long sheet name that (2)',
  ]);
});

// ---------------------------------------------------------------------------
//  A hand-made .xlsx, the way Excel writes one
// ---------------------------------------------------------------------------

test('xlsx: reads shared strings, a shared formula, built-in formats and _xlfn names', async () => {
  const x = (s: string) => enc.encode(s);
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: x('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: '_rels/.rels', data: x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: x(`<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/sharedStrings.xml', data: x(`<sst xmlns="${main}" count="4" uniqueCount="4"><si><t>Name</t></si><si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text</t></r><rPh><t>ignored</t></rPh></si><si><t>123</t></si><si><t>=not a formula</t></si></sst>`) },
    { name: 'xl/styles.xml', data: x(`<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color theme="4" tint="0.39997558519241921"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor indexed="13"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: x(`<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${main}"><x:dimension ref="A1:D1200"/><x:sheetData>` +
      '<x:row r="1"><x:c r="A1" t="s" s="2"><x:v>0</x:v></x:c><x:c r="B1"><x:f t="shared" ref="B1:B3" si="0">A1*2</x:f><x:v>2</x:v></x:c><x:c r="C1" s="1"><x:v>46289</x:v></x:c><x:c r="D1" t="s"><x:v>1</x:v></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2"><x:v>5</x:v></x:c><x:c r="B2"><x:f t="shared" si="0"/><x:v>10</x:v></x:c><x:c r="C2" t="s"><x:v>2</x:v></x:c><x:c r="D2" t="s"><x:v>3</x:v></x:c></x:row>' +
      '<x:row r="3"><x:c r="B3"><x:f t="shared" si="0"/><x:v>0</x:v></x:c><x:c r="C3" t="str"><x:f>_xlfn.XLOOKUP("a",A1:A2,_xlfn._xlws.SORT(B1:B2),"_xlfn.")</x:f><x:v>x</x:v></x:c>' +
      '<x:c r="D3" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c><x:c r="E3" t="e"><x:v>#N/A</x:v></x:c><x:c t="b"><x:v>1</x:v></x:c></x:row>' +
      '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A5:B6"/></x:mergeCells></x:worksheet>') },
  ];
  const wb = await readXlsx(await writeZip(files));
  const s = wb.sheets[0]!;
  assert.equal(s.name, 'Data');
  assert.equal(s.rows, 1200);                              // grown to the dimension
  assert.deepEqual(at(s, 'A1'), { input: 'Name', format: { b: true, color: '#8faadc', bg: '#ffff00' } });
  assert.deepEqual(at(s, 'B1'), { input: '=A1*2', value: 2 });
  assert.deepEqual(at(s, 'B2'), { input: '=A2*2', value: 10 });
  assert.deepEqual(at(s, 'B3'), { input: '=A3*2', value: 0 });
  assert.deepEqual(at(s, 'C1'), { input: '46289', format: { nf: 'dd/mm/yyyy' } });
  assert.deepEqual(at(s, 'D1'), { input: 'Rich text' });
  assert.deepEqual(at(s, 'C2'), { input: "'123" });       // a number stored as text stays text
  assert.deepEqual(at(s, 'D2'), { input: "'=not a formula" });
  assert.deepEqual(at(s, 'C3'), { input: '=XLOOKUP("a",A1:A2,SORT(B1:B2),"_xlfn.")', value: 'x' });
  assert.deepEqual(at(s, 'D3'), { input: 'inline' });
  assert.equal(at(s, 'E3')?.input, '#N/A');
  assert.equal((at(s, 'E3')?.value as CellError).code, '#N/A');
  assert.deepEqual(at(s, 'F3'), { input: 'TRUE' });        // no r attribute: the next column
  assert.deepEqual(s.merges, [{ r1: 4, c1: 0, r2: 5, c2: 1 }]);
});

test('xlsx: a file that is not a spreadsheet is refused with a plain error', async () => {
  await assert.rejects(readXlsx(await writeZip([{ name: 'hello.txt', data: enc.encode('hi') }])), /no workbook/);
});

// ---------------------------------------------------------------------------
//  CSV
// ---------------------------------------------------------------------------

test('csv: quotes, embedded commas and newlines, CRLF, a BOM', () => {
  const s = readCsv('﻿Name,Note,Amount\r\n"Rao, Asha","said ""hi""\nthen left",1,25,000\r\nBharat,,=SUM(A1)\r\n');
  assert.equal(s.name, 'Sheet1');
  assert.equal(at(s, 'A1')?.input, 'Name');
  assert.equal(at(s, 'A2')?.input, 'Rao, Asha');
  assert.equal(at(s, 'B2')?.input, 'said "hi"\nthen left');
  assert.equal(at(s, 'C2')?.input, '1');                  // unquoted commas split, as they must
  assert.equal(at(s, 'E2')?.input, '000');
  assert.equal(at(s, 'B3'), undefined);                   // an empty field is no cell
  assert.equal(at(s, 'C3')?.input, "'=SUM(A1)");           // never a formula from a CSV
  assert.equal(at(s, 'A4'), undefined);                   // the final newline adds no row
});

test('csv: the delimiter is detected — tab, semicolon, comma', () => {
  const tsv = readCsv('a\tb, c\tc\n1\t2\t3\n');
  assert.equal(at(tsv, 'B1')?.input, 'b, c');
  assert.equal(at(tsv, 'C2')?.input, '3');
  const semi = readCsv('Name;Amount\nAsha;1,5\n');
  assert.equal(at(semi, 'B2')?.input, '1,5');
  const one = readCsv('just one column\nsecond');
  assert.equal(at(one, 'A2')?.input, 'second');
});

test('csv: write then read keeps every value; formulas are written as their values', () => {
  const s = emptySheet('Anything');
  s.cells.set(cellKey(0, 0), { input: 'Name, with comma' });
  s.cells.set(cellKey(0, 1), { input: 'He said "no"' });
  s.cells.set(cellKey(0, 3), { input: 'multi\nline' });
  s.cells.set(cellKey(1, 0), { input: "'00123" });
  s.cells.set(cellKey(1, 1), { input: '=A3*2', value: 0.30000000000000004 });
  s.cells.set(cellKey(1, 2), { input: '=1/0', value: new CellError('#DIV/0!') });
  s.cells.set(cellKey(1, 3), { input: '=B9' });               // value unknown → empty, not formula text
  s.cells.set(cellKey(2, 0), { input: '₹1,25,000' });
  s.cells.set(cellKey(2, 2), { input: null, format: { b: true } });
  const text = writeCsv(s);
  assert.equal(text,
    '"Name, with comma","He said ""no""",,"multi\nline"\r\n00123,0.3,#DIV/0!,\r\n"₹1,25,000",,,\r\n');
  const back = readCsv(text);
  assert.equal(at(back, 'A1')?.input, 'Name, with comma');
  assert.equal(at(back, 'B1')?.input, 'He said "no"');
  assert.equal(at(back, 'D1')?.input, 'multi\nline');
  assert.equal(at(back, 'B2')?.input, '0.3');
  assert.equal(at(back, 'A3')?.input, '₹1,25,000');
  assert.equal(writeCsv(s, '\t').split('\r\n')[0], 'Name, with comma\t"He said ""no"""\t\t"multi\nline"');
});
