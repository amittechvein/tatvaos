// ============================================================================
//  The spreadsheet half of the render service: POST /render/sheet.
//  The gate in docs/SHEETS_SERVER_RENDER_DESIGN.md §5, the parts that need no
//  container (the container's own limits are tests/docs-render/container-test.sh).
//
//    pnpm --filter @tatvaos/render test
//
//  The workbooks are tests/sheets-render/fixtures, built through the editor's
//  own model with values worked out by hand (make-fixtures.mjs).
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Y from 'yjs';
import { SheetsModel } from '../../web/lib/sheets/model.ts';
import { readXlsx, writeXlsx } from '../../web/lib/sheets/io/xlsx.ts';
import { readZip } from '../../web/lib/sheets/io/zip.ts';
import { renderSheet } from '../src/render-sheet.mjs';

const FIXTURES = new URL('../../../tests/sheets-render/fixtures/', import.meta.url);
const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'large.json').map((f) => f.slice(0, -5)).sort();
const fixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
const stateOf = (f) => new Uint8Array(Buffer.from(f.state, 'base64'));

const at = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { r: Number(m[2]) - 1, c: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 };
};
/** "B4" or "Fees!B4" in a read-back workbook. */
const cellIn = (wb, where) => {
  const [sheetName, ref] = where.includes('!') ? where.split('!') : [null, where];
  const sheet = sheetName ? wb.sheets.find((s) => s.name === sheetName) : wb.sheets[0];
  const { r, c } = at(ref);
  return sheet?.cells.get(`${r},${c}`);
};

/** What SheetEditor's checkpoint writes for the same stored state: the editor's own path. */
async function editorPath(updates) {
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, u);
  const model = new SheetsModel(doc);
  try { return await writeXlsx(model.snapshot()); } finally { model.destroy(); doc.destroy(); }
}

/**
 * A workbook as plain data for comparison: every sheet's name, size, merges,
 * widths and cells (input, value, format). Volatile cells (NOW, RAND,
 * TODAY) keep their input but not their value: two builds a moment apart
 * may honestly differ there.
 */
function canonical(wb) {
  const volatile = /\b(NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY)\s*\(/i;
  const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (
    x instanceof Map ? [...x].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      : x && typeof x === 'object' && 'code' in x && Object.keys(x).length <= 2 ? { error: x.code } : x)));
  return plain(wb.sheets.map((s) => ({
    ...s,
    cells: new Map([...s.cells].map(([k, cell]) => [k, volatile.test(String(cell.input ?? ''))
      ? { ...cell, value: undefined } : cell])),
  })));
}

// ---- 1. The same workbook ----------------------------------------------------

for (const name of fixtureNames) {
  test(`${name}: the server's .xlsx is the workbook the editor writes, and holds the hand-worked values`, async () => {
    const f = fixture(name);
    const r = await renderSheet([stateOf(f)]);
    const ours = await readXlsx(r.xlsx);
    const editors = await readXlsx(await editorPath([stateOf(f)]));
    assert.deepEqual(canonical(ours), canonical(editors));
    // The values worked out by hand come back out of the FILE, not the model.
    for (const [where, want] of Object.entries(f.expect)) {
      const got = cellIn(ours, where)?.value;
      if (typeof want === 'number') assert.ok(Math.abs(Number(got) - want) < 1e-9, `${where}: file holds ${JSON.stringify(got)}, by hand ${want}`);
      else assert.equal(got, want, `${where}: file holds ${JSON.stringify(got)}, by hand ${JSON.stringify(want)}`);
    }
    assert.ok(r.html.length > 0 && r.text.length > 0, 'html and text are written');
    assert.equal(r.schema, 'sheets-1');
  });
}

// ---- 2. A colleague's edit ---------------------------------------------------

test("a colleague's edit the saving browser never saw IS in the file (and the control without it is not)", async () => {
  const f = fixture('formulas-every-family');
  const state = stateOf(f);
  // The colleague's browser: the stored state, then two cells typed.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const model = new SheetsModel(doc);
  const before = Y.encodeStateVector(doc);
  model.setInputs(model.sheetIds()[0], [{ r: 40, c: 0, input: 'Added by a colleague' }, { r: 40, c: 1, input: '=B2*2' }]);
  const colleague = Y.encodeStateAsUpdate(doc, before);
  const b2 = model.value(model.sheetIds()[0], 1, 1);
  model.destroy(); doc.destroy();

  const withIt = await readXlsx((await renderSheet([state, colleague])).xlsx);
  assert.equal(cellIn(withIt, 'A41')?.input, 'Added by a colleague');
  assert.equal(cellIn(withIt, 'B41')?.value, Number(b2) * 2);

  // The control: the saving browser's own view (the state alone) lacks it, so the check above can fail.
  const without = await readXlsx((await renderSheet([state])).xlsx);
  assert.equal(cellIn(without, 'A41'), undefined);
  assert.notDeepEqual(canonical(withIt), canonical(without));
});

// ---- 3. TODAY() in India time ----------------------------------------------------

test('TODAY() built at 00:30 in India is that day, in India time; the same instant in UTC is the day before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-tz-'));
  // The clock, fixed: 2 Oct 2026 19:00 UTC = 3 Oct 2026 00:30 IST.
  writeFileSync(join(dir, 'clock.mjs'), `
    const FIXED = Date.parse('2026-10-02T19:00:00Z');
    const Real = Date;
    globalThis.Date = class extends Real {
      constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
      static now() { return FIXED; }
    };`);
  const src = new URL('../src/render-sheet.mjs', import.meta.url).href;
  const xlsx = new URL('../../web/lib/sheets/io/xlsx.ts', import.meta.url).href;
  const fx = fileURLToPath(new URL('dates-and-today.json', FIXTURES));
  writeFileSync(join(dir, 'run.mjs'), `
    import { readFileSync } from 'node:fs';
    import { renderSheet } from ${JSON.stringify(src)};
    import { readXlsx } from ${JSON.stringify(xlsx)};
    const f = JSON.parse(readFileSync(${JSON.stringify(fx)}, 'utf8'));
    const wb = await readXlsx((await renderSheet([new Uint8Array(Buffer.from(f.state, 'base64'))])).xlsx);
    const v = (r, c) => wb.sheets[0].cells.get(r + ',' + c)?.value;
    console.log(JSON.stringify({ fixed: v(0, 1), today: v(7, 1) }));`);
  // --import takes a URL: a bare Windows path (C:\...) is read as the scheme "c:".
  const register = new URL('../src/register.mjs', import.meta.url).href;
  const run = (tz) => {
    const p = spawnSync(process.execPath, ['--import', register, '--import', pathToFileURL(join(dir, 'clock.mjs')).href, join(dir, 'run.mjs')],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout.trim().split('\n').pop());
  };
  const india = run('Asia/Kolkata');
  assert.equal(india.fixed, 46298, 'B1 is DATE(2026,10,3)'); // Excel serial for 3 Oct 2026
  assert.equal(india.today, india.fixed, 'India time: TODAY() is 3 Oct');
  const utc = run('UTC');
  assert.equal(utc.today, utc.fixed - 1, 'UTC: the same instant is still 2 Oct, which is why the container runs in India time');
});

// ---- 4. Unsafe formulas never go into the file as formulas -------------------------

test('unsafe formulas are written as text, never as formulas; a safe https HYPERLINK stays a formula', async () => {
  const r = await renderSheet([stateOf(fixture('unsafe-formulas'))]);
  const files = await readZip(r.xlsx);
  const sheets = [...files].filter(([n]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map(([, d]) => new TextDecoder().decode(d)).join('\n');
  const formulas = [...sheets.matchAll(/<f>([^<]*)<\/f>/g)].map((m) => m[1]);
  assert.ok(formulas.some((x) => x.includes('HYPERLINK(&quot;https://')), 'the safe link is a formula (so this check reads formulas at all)');
  for (const bad of ['WEBSERVICE', 'IMPORTXML', 'cmd|', 'javascript:']) {
    assert.ok(!formulas.some((x) => x.includes(bad)), `${bad} is not in any formula`);
  }
});

// ---- 5. A large sheet, inside the time limit ---------------------------------------

test('a 20,000-cell sheet builds inside the 10 s limit', async () => {
  const doc = new Y.Doc();
  const model = new SheetsModel(doc);
  model.ensureSeeded();
  const s = model.sheetIds()[0];
  const entries = [];
  for (let r = 0; r < 1000; r += 1) {
    for (let c = 0; c < 19; c += 1) entries.push({ r, c, input: String(r * 19 + c) });
    entries.push({ r, c: 19, input: `=SUM(A${r + 1}:S${r + 1})` });
  }
  model.setInputs(s, entries);
  const state = Y.encodeStateAsUpdate(doc);
  model.destroy(); doc.destroy();
  const t0 = Date.now();
  const r = await renderSheet([state]);
  const ms = Date.now() - t0;
  console.log(`  large: ${r.cells} cells, xlsx ${r.xlsx.length} B, ${ms} ms`);
  assert.equal(r.cells, 20_000);
  assert.ok(ms < 10_000, `took ${ms} ms, over the 10 s limit`);
  const back = await readXlsx(r.xlsx);
  assert.equal(cellIn(back, 'T1000')?.value, [...Array(19).keys()].reduce((n, c) => n + 999 * 19 + c, 0));
});

// ---- 6. The HTTP route ------------------------------------------------------------

async function startServer(port) {
  const child = spawn(process.execPath, ['--import', './src/register.mjs', 'src/server.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, log: () => out }; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${out}`);
}

test('POST /render/sheet builds the file, refuses bad input, leaves /render/doc alone, and never logs a cell', async () => {
  const port = 18441;
  const s = await startServer(port);
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    const f = fixture('hindi-text');
    const ok = await post('/render/sheet', { updates: [f.state] });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.schema, 'sheets-1');
    const back = await readXlsx(new Uint8Array(Buffer.from(body.xlsx, 'base64')));
    assert.equal(cellIn(back, 'A1')?.input, 'छात्र का नाम');
    assert.equal(typeof body.state, 'string');

    assert.equal((await post('/render/sheet', 'not json')).status, 400);
    assert.equal((await post('/render/sheet', { updates: [] })).status, 400);
    const bad = await post('/render/sheet', { updates: [Buffer.from([9, 9, 9, 9, 9]).toString('base64')] });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /spreadsheet/);
    // A Docs document is not a spreadsheet: it has no sheets, so it is refused rather than built empty.
    const empty = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64');
    assert.equal((await post('/render/sheet', { updates: [empty] })).status, 422);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.sheetsSchema, 'sheets-1');
    assert.equal(health.schema, 'docs-1');

    assert.match(s.log(), /sheet 200 .*xlsx=\d+B .*cells=\d+/);
    assert.match(s.log(), /sheet 422 /);
    for (const content of ['छात्र', 'कक्षा', 'महाराष्ट्र']) assert.ok(!s.log().includes(content), `the log never carries a cell (${content})`);
  } finally { s.child.kill(); }
});
