// ============================================================================
//  THE GATE (Mr. Singh, 29 Sept 2026): does the server's render reproduce
//  editor.getHTML() for the real editor's fixture page?
// ============================================================================
//
//  "If @tiptap/html in Node doesn't reproduce editor.getHTML() for the
//  fixture page, stop and bring it back to me. Don't patch around it."
//  (docs/DOCS_SERVER_RENDER_DESIGN.md §12.1)
//
//  The fixture (tests/docs-html/editor-page.html) is what the REAL editor's
//  getHTML() returned for a document holding one of every node and mark. The
//  path tested is the server's path, all of it:
//
//    fixture HTML --generateJSON--> editor JSON
//                 --prosemirrorJSONToYDoc--> Yjs document (what the live
//                   editor's sync plugin writes: the same y-tiptap mapping)
//                 --encodeStateAsUpdate--> BYTES (what docs.documents.state holds)
//                 --applyUpdate into a fresh Y.Doc--> (what the server reads)
//                 --yXmlFragmentToProsemirrorJSON--> editor JSON
//                 --generateHTML--> the HTML the server would store
//
//  and the answer must equal the fixture, character for character. Nothing
//  is normalised before comparing: a difference in attribute order or
//  whitespace is a difference in the file Space serves.
//
//  Two stages are also reported on their own, so a failure says WHERE:
//    Yjs      JSON in == JSON out            (the bytes lose nothing)
//    writer   generateHTML(JSON) == fixture  (Node writes what the browser wrote)
//
//  CALIBRATION (a comparison that cannot fail proves nothing): the same path
//  with one extension removed from the schema must NOT match.
//
//    pnpm --filter @tatvaos/render parity
// ============================================================================

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

/** Where two strings first differ, with a little of each around it. */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length && i === b.length) return 'identical';
  const from = Math.max(0, i - 60);
  return `at character ${i} of ${b.length}:\n        expected …${b.slice(from, i + 80)}\n        got      …${a.slice(from, i + 80)}`;
}

/** The whole server path: HTML -> JSON -> Yjs bytes -> fresh doc -> JSON -> HTML. */
function serverPath(html, extensions) {
  const schema = getSchema(extensions);
  const json = generateJSON(html, extensions);
  const ydoc = prosemirrorJSONToYDoc(schema, json, 'default');
  const bytes = Y.encodeStateAsUpdate(ydoc);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, bytes);
  const back = yXmlFragmentToProsemirrorJSON(fresh.getXmlFragment('default'));
  const t0 = performance.now();
  const out = generateHTML(back, extensions);
  const renderMs = performance.now() - t0;
  return { json, back, bytes, out, renderMs };
}

const raw = readFileSync(new URL('../../../tests/docs-html/editor-page.html', import.meta.url), 'utf8');
// The fixture opens with a comment saying how it was made; the page follows it
// (tests/docs-html/Program.cs reads it the same way).
const fixture = raw.slice(raw.indexOf('-->') + 3).trim();

console.log('The gate: the server render against the real editor\'s page');
const extensions = documentExtensions();
const r = serverPath(fixture, extensions);

check('the fixture is the real page, not an empty file',
  fixture.length > 1500 && fixture.includes('<table'), `${fixture.length} characters`);
check('Yjs: the document comes back from the stored bytes unchanged',
  JSON.stringify(r.back) === JSON.stringify(r.json), firstDifference(JSON.stringify(r.back), JSON.stringify(r.json)));
const writer = generateHTML(r.json, extensions);
check('writer: Node writes exactly what the browser\'s editor wrote', writer === fixture, firstDifference(writer, fixture));
check('THE GATE: stored Yjs bytes -> server HTML == editor.getHTML(), character for character',
  r.out === fixture, firstDifference(r.out, fixture));

console.log('\nCalibration: a schema one extension short must NOT match');
// Highlight (<mark>) is in the fixture; without it the render must differ.
const short = extensions.filter((e) => e.name !== 'highlight');
check('one extension fewer (highlight) is caught', short.length === extensions.length - 1
  && serverPath(fixture, short).out !== fixture, `${extensions.length} -> ${short.length} extensions`);

console.log('\nCost (Mr. Singh, §9 point 3: measure before choosing "every checkpoint")');
const times = [];
for (let i = 0; i < 20; i += 1) times.push(serverPath(fixture, extensions).renderMs);
times.sort((a, b) => a - b);
console.log(`  fixture (${fixture.length} chars, ${r.bytes.length} Yjs bytes): render median ${times[10].toFixed(1)} ms, worst ${times[19].toFixed(1)} ms of 20`);
for (const copies of [50, 400]) {
  const big = Array.from({ length: copies }, () => fixture).join('');
  const t0 = performance.now();
  const b = serverPath(big, extensions);
  const all = performance.now() - t0;
  console.log(`  ${copies} copies (${(big.length / 1e6).toFixed(2)} M chars, ${(b.bytes.length / 1e6).toFixed(2)} MB Yjs): render ${b.renderMs.toFixed(0)} ms; whole path incl. parse ${all.toFixed(0)} ms; equal to its input: ${b.out === big}`);
}

console.log(`\n  passed: ${passed}   failed: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
