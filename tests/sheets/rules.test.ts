// ============================================================================
//  Colour rules (conditional formatting) — Amit's Phase 2, 9 Oct 2026.
//  lib/sheets/rules.ts, SheetsModel.colourRules, xlsx colourRuleXml /
//  readColourRules.
//
//  Every refusal has its permit twin, as in malformed.test.ts: a junk rule is
//  dropped AND the valid rule beside it survives; a rule that should not
//  match is checked beside one that should.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model.ts';
import { ruleMatches, ruleStyleAt, cleanRule, type ColourRule, type PlacedRule } from '../../apps/web/lib/sheets/rules.ts';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';
import { readZip, writeZip } from '../../apps/web/lib/sheets/io/zip.ts';
import { formulaIsSafe } from '../../apps/web/lib/sheets/io/safety.ts';
import { CellError, INDIA } from '../../apps/web/lib/sheets/engine/types.ts';
import { cellKey, emptySheet, type WorkbookData } from '../../apps/web/lib/sheets/workbook.ts';

const RED = { bg: '#f4c7c3', color: '#a50e0e' };
const rule = (kind: ColourRule['kind'], a?: string, b?: string): ColourRule => ({ kind, a, b, style: RED });
const m = (r: ColourRule, v: Parameters<typeof ruleMatches>[1]) => ruleMatches(r, v, INDIA);

test('numbers compare as numbers, Indian-grouped and rupee operands included', () => {
  assert.equal(m(rule('gt', '0'), 5), true);
  assert.equal(m(rule('gt', '0'), 0), false);
  assert.equal(m(rule('gte', '1,25,000'), 125000), true);
  assert.equal(m(rule('lt', '₹500'), 499.5), true);
  assert.equal(m(rule('lt', '₹500'), 500), false);
  assert.equal(m(rule('between', '10', '20'), 15), true);
  assert.equal(m(rule('between', '20', '10'), 15), true, 'between does not care which way round');
  assert.equal(m(rule('notBetween', '10', '20'), 15), false);
  assert.equal(m(rule('notBetween', '10', '20'), 25), true);
  assert.equal(m(rule('eq', '100'), 100), true);
  assert.equal(m(rule('ne', '100'), 100), false);
});

test('size comparisons never match text; text compares ignoring case', () => {
  assert.equal(m(rule('gt', '0'), 'Paid'), false, 'text is not greater than 0');
  assert.equal(m(rule('eq', 'absent'), 'Absent'), true);
  assert.equal(m(rule('eq', 'absent'), 'Present'), false);
  assert.equal(m(rule('contains', 'due'), 'Fees DUE'), true);
  assert.equal(m(rule('notContains', 'due'), 'Fees DUE'), false);
  assert.equal(m(rule('startsWith', 'fee'), 'Fees due'), true);
  assert.equal(m(rule('endsWith', 'due'), 'Fees due'), true);
  assert.equal(m(rule('endsWith', 'fee'), 'Fees due'), false);
});

test('blank, not blank, and errors', () => {
  assert.equal(m(rule('empty'), null), true);
  assert.equal(m(rule('empty'), ''), true);
  assert.equal(m(rule('empty'), 0), false, 'zero is not empty');
  assert.equal(m(rule('notEmpty'), 0), true);
  const err = new CellError('#DIV/0!');
  assert.equal(m(rule('gt', '0'), err), false, 'an error matches no comparison');
  assert.equal(m(rule('notEmpty'), err), true, '…but it is not empty');
  assert.equal(m(rule('eq', 'absent'), null), false, 'a blank cell is not equal to a word');
});

test('the first matching rule wins, whole; cells outside every range are untouched', () => {
  const rules: PlacedRule[] = [
    { id: 'a', r1: 0, c1: 0, r2: 9, c2: 0, kind: 'gt', a: '100', style: { bg: '#ff0000' } },
    { id: 'b', r1: 0, c1: 0, r2: 9, c2: 0, kind: 'gt', a: '0', style: { bg: '#00ff00', b: true } },
  ];
  assert.deepEqual(ruleStyleAt(rules, 0, 0, () => 500, INDIA), { bg: '#ff0000' }, 'both match: the first is used, not a blend');
  assert.deepEqual(ruleStyleAt(rules, 0, 0, () => 5, INDIA), { bg: '#00ff00', b: true });
  assert.equal(ruleStyleAt(rules, 0, 0, () => -1, INDIA), undefined);
  let asked = 0;
  assert.equal(ruleStyleAt(rules, 0, 1, () => { asked += 1; return 500; }, INDIA), undefined);
  assert.equal(asked, 0, 'a cell outside every rule does not even calculate its value');
});

test('cleanRule keeps a valid rule and drops junk rather than half-applying it', () => {
  assert.deepEqual(cleanRule({ kind: 'gt', a: '0', style: { bg: '#ffffff' } }), { kind: 'gt', a: '0', style: { bg: '#ffffff' } });
  assert.equal(cleanRule({ kind: 'explode', a: '0', style: { bg: '#ffffff' } }), undefined, 'unknown kind');
  assert.equal(cleanRule({ kind: 'gt', style: { bg: '#ffffff' } }), undefined, 'no value to compare with');
  assert.equal(cleanRule({ kind: 'between', a: '1', style: { bg: '#ffffff' } }), undefined, 'between needs two');
  assert.equal(cleanRule({ kind: 'gt', a: '0', style: { bg: 'red' } }), undefined, 'no style it could show');
  assert.equal(cleanRule({ kind: 'gt', a: 'x'.repeat(501), style: { bg: '#ffffff' } }), undefined, 'operand too long');
  assert.deepEqual(cleanRule({ kind: 'empty', a: 'ignored', style: { b: true, extra: 1 } }), { kind: 'empty', style: { b: true } });
});

function freshModel() {
  const doc = new Y.Doc();
  const model = new SheetsModel(doc);
  model.ensureSeeded();
  const sid = model.sheetIds()[0]!;
  return { doc, model, sid };
}

test('a rule follows its rows when rows are inserted above it', () => {
  const { model, sid } = freshModel();
  model.addColourRule(sid, { r1: 1, c1: 1, r2: 9, c2: 1 }, rule('gt', '0'));
  model.insert(sid, 'row', 0, 3);
  const [r] = model.colourRules(sid);
  assert.deepEqual([r!.r1, r!.c1, r!.r2, r!.c2], [4, 1, 12, 1]);
});

test('deleting a rule\'s last row shrinks it; deleting all its rows removes it; rows inside leave it alone', () => {
  const { model, sid } = freshModel();
  model.addColourRule(sid, { r1: 1, c1: 0, r2: 9, c2: 0 }, rule('gt', '0'));
  model.remove(sid, 'row', 9, 1);
  assert.deepEqual(model.colourRules(sid).map((x) => [x.r1, x.r2]), [[1, 8]], 'lost its last row: B2:B9');
  model.remove(sid, 'row', 0, 2); // deletes row 0 and the rule's first row (1)
  assert.deepEqual(model.colourRules(sid).map((x) => [x.r1, x.r2]), [[0, 6]], 'lost its first row and shifted up');
  model.remove(sid, 'row', 3, 2); // inside the range
  assert.deepEqual(model.colourRules(sid).map((x) => [x.r1, x.r2]), [[0, 4]]);
  model.remove(sid, 'row', 0, 5);
  assert.equal(model.colourRules(sid).length, 0, 'every row gone: the rule goes');
});

test('update keeps a rule\'s place; remove takes it away; order is the order added', () => {
  const { model, sid } = freshModel();
  const a = model.addColourRule(sid, { r1: 0, c1: 0, r2: 0, c2: 0 }, rule('gt', '1'))!;
  const b = model.addColourRule(sid, { r1: 0, c1: 0, r2: 0, c2: 0 }, rule('gt', '2'))!;
  assert.ok(model.updateColourRule(sid, a, { r1: 0, c1: 0, r2: 5, c2: 0 }, rule('lt', '9')));
  assert.deepEqual(model.colourRules(sid).map((x) => [x.id, x.kind, x.r2]), [[a, 'lt', 5], [b, 'gt', 0]]);
  model.removeColourRule(sid, a);
  assert.deepEqual(model.colourRules(sid).map((x) => x.id), [b]);
  assert.equal(model.addColourRule(sid, { r1: 0, c1: 0, r2: 0, c2: 0 }, rule('gt')), null, 'an invalid rule is not added');
});

test('a sheet made before rules existed still opens, with none; a hand-made junk rule is skipped', () => {
  const { doc, model, sid } = freshModel();
  // The seed sheet has no 'rules' map at all (seedUpdate is fixed): it must still be a sheet.
  assert.equal(model.sheetIds().length, 1);
  assert.deepEqual(model.colourRules(sid), []);
  model.addColourRule(sid, { r1: 0, c1: 0, r2: 2, c2: 0 }, rule('gt', '0'));
  doc.transact(() => {
    const rules = (doc.getMap('sheets').get(sid) as Y.Map<unknown>).get('rules') as Y.Map<unknown>;
    rules.set('junk1', 'not a rule');
    rules.set('junk2', { kind: 'gt', a: '0', style: { bg: '#ffffff' }, r1: 'nope', c1: 'c0', r2: 'r1', c2: 'c0' });
    rules.set('junk3', { kind: 'gt', a: '0', style: { bg: '#ffffff' }, r1: 'r5', c1: 'c0', r2: 'r1', c2: 'c0' }); // upside down
  });
  assert.equal(model.colourRules(sid).length, 1, 'junk dropped, the valid rule kept');
  assert.equal(model.snapshot().sheets[0]!.rules!.length, 1);
});

test('snapshot → load and duplicate sheet carry the rules', () => {
  const { model, sid } = freshModel();
  model.addColourRule(sid, { r1: 1, c1: 2, r2: 4, c2: 2 }, rule('contains', 'due'));
  const snap = model.snapshot();
  assert.deepEqual(snap.sheets[0]!.rules, [{ r1: 1, c1: 2, r2: 4, c2: 2, kind: 'contains', a: 'due', style: RED }]);
  const other = freshModel();
  const loaded = other.model.load(snap, 'replace')!;
  assert.deepEqual(other.model.colourRules(loaded).map(({ id: _id, ...r }) => r), snap.sheets[0]!.rules);
  const copy = model.duplicateSheet(sid);
  assert.equal(model.colourRules(copy).length, 1);
});

function book(): WorkbookData {
  const s = emptySheet('Fees');
  s.cells.set(cellKey(0, 0), { input: 'Due' });
  s.cells.set(cellKey(1, 0), { input: '5000' });
  s.rules = [
    { r1: 1, c1: 0, r2: 20, c2: 0, kind: 'gt', a: '0', style: { bg: '#f4c7c3', color: '#a50e0e', b: true } },
    { r1: 1, c1: 1, r2: 20, c2: 1, kind: 'between', a: '1,000', b: '5000', style: { bg: '#fff2cc' } },
    { r1: 1, c1: 2, r2: 20, c2: 2, kind: 'eq', a: 'Absent', style: { color: '#c5221f' } },
    { r1: 1, c1: 3, r2: 20, c2: 3, kind: 'contains', a: 'say "hi" [x] | y', style: { bg: '#cfe2f3' } },
    { r1: 1, c1: 4, r2: 20, c2: 4, kind: 'empty', style: { bg: '#e7e6e6' } },
  ];
  return { sheets: [s] };
}

test('.xlsx: rules are written as Excel conditional formats, first-match-wins, after mergeCells', async () => {
  const files = await readZip(await writeXlsx(book()));
  const sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  const styles = new TextDecoder().decode(files.get('xl/styles.xml')!);
  const cfs = sheet.match(/<conditionalFormatting /g) ?? [];
  assert.equal(cfs.length, 5);
  assert.match(sheet, /<conditionalFormatting sqref="A2:A21"><cfRule type="cellIs" operator="greaterThan" dxfId="\d+" priority="1" stopIfTrue="1"><formula>0<\/formula>/);
  assert.match(sheet, /operator="between"[^>]*><formula>1000<\/formula><formula>5000<\/formula>/, 'Indian-grouped operand written as a plain number');
  assert.match(sheet, /operator="equal"[^>]*><formula>&quot;Absent&quot;<\/formula>/, 'text written as a quoted string');
  assert.match(sheet, /type="containsBlanks"/);
  assert.ok(sheet.indexOf('<conditionalFormatting') < sheet.indexOf('<pageMargins'), 'before pageMargins');
  assert.match(styles, /<dxfs count="5">/);
  // Every rule formula passes the same check the server runs on the file.
  for (const f of sheet.matchAll(/<formula>(.*?)<\/formula>/g)) {
    const text = f[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    assert.ok(formulaIsSafe(text), `unsafe rule formula written: ${text}`);
  }
  // Calibration for the loop above: the quoted operand really holds the characters the check refuses outside quotes.
  assert.match(sheet, /SEARCH\(&quot;say &quot;&quot;hi&quot;&quot; \[x\] \| y&quot;,D2\)/);
  assert.equal(formulaIsSafe('ISERROR(SEARCH(x [x] | y,D2))'), false, 'the same characters unquoted are refused');
});

test('.xlsx: rules read back exactly as written', async () => {
  const back = await readXlsx(await writeXlsx(book()));
  assert.deepEqual(back.sheets[0]!.rules, book().sheets[0]!.rules!.map((r) =>
    r.kind === 'between' ? { ...r, a: '1000' } : r));
});

test('.xlsx import keeps the kinds TatvaOS has and drops the rest (formula rules, colour scales, unknown styles)', async () => {
  const files = await readZip(await writeXlsx(book()));
  let sheet = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml')!);
  sheet = sheet.replace('<pageMargins',
    '<conditionalFormatting sqref="F2:F9"><cfRule type="expression" dxfId="0" priority="0"><formula>MOD(ROW(),2)=0</formula></cfRule></conditionalFormatting>' +
    '<conditionalFormatting sqref="G2:G9"><cfRule type="colorScale" priority="0"><colorScale/></cfRule></conditionalFormatting>' +
    '<conditionalFormatting sqref="H2:H9"><cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="0"><formula>$Z$1</formula></cfRule></conditionalFormatting>' +
    '<conditionalFormatting sqref="I2:I9"><cfRule type="cellIs" operator="greaterThan" dxfId="99" priority="0"><formula>1</formula></cfRule></conditionalFormatting>' +
    '<pageMargins');
  files.set('xl/worksheets/sheet1.xml', new TextEncoder().encode(sheet));
  const back = await readXlsx(await writeZip([...files].map(([name, data]) => ({ name, data }))));
  assert.equal(back.sheets[0]!.rules!.length, 5, 'only the five TatvaOS kinds survive');
  assert.ok(back.sheets[0]!.rules!.every((r) => r.c1 <= 4), 'nothing from F, G, H or I');
});
