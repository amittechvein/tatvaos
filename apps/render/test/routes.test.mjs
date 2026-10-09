// ============================================================================
//  The render service's three routes, against the MERGED service.
//
//  Written when 390 (POST /render/sheet) met 370 (POST /render/pdf) on the
//  same dispatch lines (6 Oct 2026). Mr. Singh: the merged dispatch needs one
//  shape for three routes with both downstream uses rewired to it, and
//  "JavaScript will compile a half-rewired version perfectly happily and
//  misroute at runtime". So this proves, through real HTTP:
//    - /render/doc renders a document, and its answer is exactly what it was
//      before either pull request (no `json`, no `xlsx`);
//    - /render/sheet builds a spreadsheet;
//    - /render/pdf reaches the PDF builder, and `pictures` is parsed on that
//      route only;
//    - an unknown POST path (including '/constructor' and '/__proto__') is 404;
//    - /health names both schemas.
//
//  No Typst here (the laptop and CI's render job have none; the PDF gate runs
//  it in its own container). Without it the PDF builder fails with
//  typst_missing, which the server answers 500 pdf_failed. That answer comes
//  from the PDF path and nowhere else, so it proves the dispatch. Where Typst
//  is installed the same request gets a real PDF; both are accepted, and the
//  document's answer is never accepted.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';

const PORT = 18461;
const b64 = (u) => Buffer.from(u).toString('base64');
const schema = getSchema(documentExtensions());
const docState = (text) => Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema,
  { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, 'default'));
const sheetState = () => JSON.parse(readFileSync(new URL('../../../tests/sheets-render/fixtures/hindi-text.json', import.meta.url), 'utf8')).state;

async function startServer() {
  const child = spawn(process.execPath, ['--import', './src/register.mjs', 'src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), TYPST_BIN: process.env.TYPST_BIN ?? 'typst-not-installed-for-this-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 300; i += 1) { // up to 30 s: a cold start can be slow
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return { child, log: () => out }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${out}`);
}
const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('one dispatch, three routes: each reaches its own builder, and nothing else answers', async () => {
  const s = await startServer();
  try {
    // /render/doc: a document, and its answer exactly as before 370 and 390.
    const doc = await post('/render/doc', { updates: [b64(docState('Fee notice for October'))] });
    assert.equal(doc.status, 200);
    const docBody = await doc.json();
    assert.deepEqual(Object.keys(docBody).sort(), ['dropped', 'html', 'schema', 'state', 'text'],
      'the document answer has exactly its old fields: no json (the PDF\'s), no xlsx (the sheet\'s)');
    assert.match(docBody.html, /Fee notice for October/);
    assert.equal(docBody.schema, 'docs-1');

    // /render/sheet: a spreadsheet.
    const sheet = await post('/render/sheet', { updates: [sheetState()] });
    assert.equal(sheet.status, 200);
    const sheetBody = await sheet.json();
    assert.equal(sheetBody.schema, 'sheets-1');
    assert.equal(Buffer.from(sheetBody.xlsx, 'base64').subarray(0, 2).toString(), 'PK', 'a real zip');

    // /render/pdf: the PDF builder, never the document's answer.
    const pdf = await post('/render/pdf', { updates: [b64(docState('Fee notice for October'))] });
    const pdfBody = await pdf.json();
    const builtPdf = pdf.status === 200 && Buffer.from(pdfBody.pdf ?? '', 'base64').subarray(0, 5).toString() === '%PDF-';
    const builderRan = pdf.status === 500 && pdfBody.reason === 'pdf_failed';
    assert.ok(builtPdf || builderRan, `the PDF route reached the PDF builder: ${pdf.status} ${JSON.stringify(pdfBody).slice(0, 120)}`);
    assert.equal(pdfBody.html, undefined, 'the PDF route never answers with the document');
    if (builderRan) assert.match(s.log(), /pdf FAILED typst_missing/, 'and the log says why (here: no Typst)');

    // pictures: parsed on the PDF route only. A malformed value (an array) is
    // ignored by /render/doc and refused (400) by /render/pdf.
    const docWithBadPictures = await post('/render/doc', { updates: [b64(docState('x'))], pictures: ['not', 'an', 'object'] });
    assert.equal(docWithBadPictures.status, 200, '/render/doc does not read pictures at all');
    const pdfWithBadPictures = await post('/render/pdf', { updates: [b64(docState('x'))], pictures: ['not', 'an', 'object'] });
    assert.equal(pdfWithBadPictures.status, 400, '/render/pdf reads pictures, and refuses this shape');

    // Unknown paths, including the ones a plain object would have answered.
    for (const path of ['/render/x', '/render/', '/render/docs', '/constructor', '/__proto__', '/render/constructor', '/toString']) {
      assert.equal((await post(path, { updates: [b64(docState('x'))] })).status, 404, `${path} is 404`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/render/doc`)).status, 404, 'GET on a route is 404');

    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    assert.equal(health.schema, 'docs-1');
    assert.equal(health.sheetsSchema, 'sheets-1');
    assert.equal(health.limitMs, 10_000);
  } finally { s.child.kill(); }
});
