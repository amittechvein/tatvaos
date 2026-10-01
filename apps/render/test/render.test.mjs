// ============================================================================
//  The render service's own tests. No container, no database: the function,
//  then the real HTTP server started as a child process.
//
//    pnpm --filter @tatvaos/render test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';
import { renderDoc } from '../src/render-doc.mjs';
import { sameDocument } from '../spike/same-document.mjs';

const schema = getSchema(documentExtensions());
const fixtures = new URL('../../../tests/docs-render/fixtures/', import.meta.url);
const read = (f) => { const s = readFileSync(new URL(f, fixtures), 'utf8'); return s.slice(s.indexOf('-->') + 3).trim(); };
const stateOf = (json) => Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json, 'default'));
const paragraph = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

for (const name of ['editor-page', 'word-paste', 'nested-lists', 'merged-cells', 'every-mark-pair', 'google-docs-paste']) {
  test(`${name}: the service's file is the same document as the editor reloaded from storage`, () => {
    const json = JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8'));
    const r = renderDoc([stateOf(json)]);
    assert.deepEqual(sameDocument(read(`${name}.reloaded.html`), r.html), []);
    assert.ok(r.text.length > 0, 'text is written');
    assert.deepEqual(r.dropped, []);
  });
}

test('a colleague\'s stored update the state lacks is in the file (state ⊕ updates, not the browser\'s state)', () => {
  const a = new Y.Doc();
  Y.applyUpdate(a, stateOf(paragraph('Fees are 50,000.')));
  const state = Y.encodeStateAsUpdate(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, state);
  let update = null;
  b.on('update', (u) => { update = u; });
  const text = b.getXmlFragment('default').get(0).get(0); // the paragraph's text
  text.insert(text.length, ' Colleague added this.'); // one edit, one update
  assert.ok(update, 'the colleague\'s edit produced an update');
  const withIt = renderDoc([state, update]);
  const without = renderDoc([state]);
  assert.match(withIt.html, /Colleague added this\./);
  assert.doesNotMatch(without.html, /Colleague added this\./, 'control: the state alone lacks it — so the check can fail');
  // and the merged state it returns carries the colleague's words on its own
  assert.match(renderDoc([withIt.state]).html, /Colleague added this\./);
});

test('an element type the schema does not know is reported by name (0011 condition 4), never its content', () => {
  const d = new Y.Doc();
  const f = d.getXmlFragment('default');
  const known = new Y.XmlElement('paragraph');
  known.insert(0, [new Y.XmlText('Known words')]);
  const odd = new Y.XmlElement('mysteryWidget');
  odd.insert(0, [new Y.XmlText('secret content')]);
  f.insert(0, [known, odd]);
  const r = renderDoc([Y.encodeStateAsUpdate(d)]);
  assert.deepEqual(r.dropped, [{ kind: 'unknown element', name: 'mysteryWidget', count: 1 }]);
  assert.match(r.html, /Known words/);
  assert.doesNotMatch(JSON.stringify(r.dropped), /secret content/);
});

test('an empty list of updates is refused', () => {
  assert.throws(() => renderDoc([]), RangeError);
});

// ---- the HTTP server, started for real ----------------------------------------
async function startServer(port, env = {}) {
  const child = spawn(process.execPath, ['--import', './src/register.mjs', 'src/server.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, log: () => out }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${out}`);
}
const post = (port, body) => fetch(`http://127.0.0.1:${port}/render/doc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const b64 = (u) => Buffer.from(u).toString('base64');

test('the server renders, refuses bad input, and never logs content', async () => {
  const s = await startServer(18431);
  try {
    const ok = await post(18431, { updates: [b64(stateOf(paragraph('Hello from the server')))] });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.match(body.html, /Hello from the server/);
    assert.equal(typeof body.state, 'string');
    assert.equal((await post(18431, 'not json')).status, 400);
    assert.equal((await post(18431, { updates: [] })).status, 400);
    assert.equal((await post(18431, { updates: [b64(new Uint8Array([9, 9, 9, 9, 9]))] })).status, 422);
    assert.equal((await fetch('http://127.0.0.1:18431/anything')).status, 404);
    assert.doesNotMatch(s.log(), /Hello from the server/, 'the log never carries content');
  } finally { s.child.kill(); }
});

test('a render past the limit is killed (504), and the next render still works', async () => {
  // 250 ms: far above a small render even in a fresh worker (40 ms failed the SMALL
  // render too on a busy laptop and on one CPU). The slow document must be far
  // past it on ANY machine: the Google Docs fixture alone (~400 ms on a busy
  // laptop on 30 Sept) took 130-190 ms on an idle one on 1 Oct and this test
  // failed 5 runs in 5 — it was measuring the machine. Twenty copies: ~2.5 s
  // on that idle laptop, 10x the limit (8.5 MB request, cap 48 MB).
  //
  // SELF-CALIBRATING (Mr. Singh, 1 Oct 2026): first the same document is timed
  // on THIS machine with the normal limit. Unless it takes at least twice the
  // test limit, the test FAILS saying the document is too small for this
  // machine — so a faster machine can never turn the 504 check into a pass, or
  // a fail, for the wrong reason. RENDER_TEST_COPIES (default 20) exists only
  // to show that failure (1 copy on a quiet laptop).
  const LIMIT = 250;
  const copies = Number(process.env.RENDER_TEST_COPIES ?? 20);
  const fixture = JSON.parse(readFileSync(new URL('google-docs-paste.json', fixtures), 'utf8'));
  const big = stateOf({ ...fixture, content: Array.from({ length: copies }, () => fixture.content).flat() });
  const body = { updates: [b64(big)] };

  const free = await startServer(18434, { RENDER_WORKERS: '1' });
  let took = Infinity;
  try {
    for (let i = 0; i < 2; i += 1) { // the faster of two: a warm worker, the conservative figure
      const t = performance.now();
      const r = await post(18434, body);
      assert.equal(r.status, 200, 'calibration: the document renders under the normal limit');
      took = Math.min(took, performance.now() - t);
    }
  } finally { free.child.kill(); }
  assert.ok(took >= 2 * LIMIT,
    `CALIBRATION: the document is too small for this machine — ${copies} copies rendered in ${Math.round(took)} ms, `
    + `needs at least ${2 * LIMIT} ms (twice the ${LIMIT} ms test limit). Use more copies.`);

  const s = await startServer(18432, { RENDER_TIMEOUT_MS: String(LIMIT), RENDER_WORKERS: '1' });
  try {
    const slow = await post(18432, body);
    // Every check says what it saw: on 1 Oct this test failed 2 runs in 5
    // once and then passed 37 in a row (also with every core busy), and the
    // run that failed had not kept its message. The next failure must explain itself.
    const slowBody = await slow.text();
    assert.equal(slow.status, 504,
      `a document measured at ${Math.round(took)} ms should outrun the ${LIMIT} ms limit; got ${slow.status} ${slowBody.slice(0, 120)}`);
    const t = performance.now();
    const after = await post(18432, { updates: [b64(stateOf(paragraph('small')))] });
    const afterBody = await after.text();
    assert.equal(after.status, 200,
      `the killed worker was replaced: a small render answered ${after.status} in ${Math.round(performance.now() - t)} ms ${afterBody.slice(0, 120)}`
      + `\nserver log: ${s.log().slice(-400)}`);
  } finally { s.child.kill(); }
});

test('the limit can be lowered for a test but never raised past 10 s', async () => {
  const s = await startServer(18433, { RENDER_TIMEOUT_MS: '600000' });
  try {
    assert.equal((await (await fetch('http://127.0.0.1:18433/health')).json()).limitMs, 10000);
  } finally { s.child.kill(); }
});
