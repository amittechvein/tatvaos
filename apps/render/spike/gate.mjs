// ============================================================================
//  THE GATE, redefined (Mr. Singh, 29 Sept 2026): "the same document", strictly
// ============================================================================
//
//  For every fixture — HTML the REAL editor's getHTML() returned — the whole
//  server path runs (HTML -> JSON -> Yjs as the live editor writes it ->
//  stored bytes -> fresh doc -> JSON -> @tiptap/html in Node, with the
//  editor's own schema), and the result must be the same document as the
//  fixture by same-document.mjs's rule.
//
//  Before any fixture counts, the COMPARISON is calibrated: each planted
//  difference Mr. Singh listed must be caught, and each planted change must
//  actually have changed the text (a plant that changed nothing proves
//  nothing). The one-extension-removed case stays.
//
//    pnpm --filter @tatvaos/render gate
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { Window } from 'happy-dom';
import { documentExtensions } from '../../web/components/docs/schema.ts';
import { sameDocument } from './same-document.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

/** From the editor's own document (editor.getJSON()) — what the live editor stores. */
function serverPathFromJson(json, extensions) {
  const ydoc = prosemirrorJSONToYDoc(getSchema(extensions), json, 'default');
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(ydoc));
  return generateHTML(yXmlFragmentToProsemirrorJSON(fresh.getXmlFragment('default')), extensions);
}

/**
 * From HTML: re-reads the editor's HTML into a document first. The SERVER
 * NEVER DOES THIS — it reads the stored Yjs. Used only where no editor
 * document was captured (editor-page.html, made before this gate). Found 29
 * Sept: re-reading is lossy — a <span> with no attributes (a text-style mark
 * with no settings, which a Word paste leaves) is not read back as a mark.
 */
function serverPath(html, extensions) {
  const json = generateJSON(html, extensions);
  const ydoc = prosemirrorJSONToYDoc(getSchema(extensions), json, 'default');
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(ydoc));
  return generateHTML(yXmlFragmentToProsemirrorJSON(fresh.getXmlFragment('default')), extensions);
}

/** A fixture file: the editor's HTML after the comment saying how it was made. */
function readFixture(url) {
  const raw = readFileSync(url, 'utf8');
  return raw.slice(raw.indexOf('-->') + 3).trim();
}

const extensions = documentExtensions();
const root = new URL('../../../tests/', import.meta.url);
const fixtures = [
  { name: 'editor-page (one of every node and mark)', url: new URL('docs-html/editor-page.html', root) },
  ...readdirSync(new URL('docs-render/fixtures/', root))
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => ({
      name: f.replace(/\.html$/, ''),
      url: new URL(`docs-render/fixtures/${f}`, root),
      json: new URL(`docs-render/fixtures/${f.replace(/\.html$/, '.json')}`, root),
    })),
];

// ---- 1. the comparison itself ------------------------------------------------
console.log('1. The comparison is calibrated: every planted difference is caught');
const page = readFixture(fixtures[0].url);
const out = serverPath(page, extensions);
check('identical input is the same document', sameDocument(page, page).length === 0);
check('the server\'s render of the page is the same document (attribute order, rgb/#hex tolerated)',
  sameDocument(page, out).length === 0, sameDocument(page, out).join('\n        '));

function plant(label, mutated) {
  if (mutated === out) { check(`plant "${label}" changed the text`, false, 'the plant matched nothing'); return; }
  const diffs = sameDocument(page, mutated);
  check(`caught: ${label}`, diffs.length > 0, 'NOT caught — the comparison is blind to this');
}
const once = (s, from, to) => { const i = s.indexOf(from); return i < 0 ? s : s.slice(0, i) + to + s.slice(i + from.length); };
plant('a changed word', once(out, 'Admission notice', 'Admission notices'));
plant('one colour one digit different (#fff475 vs rgb(255, 244, 118))', once(out, 'background-color: #fff475', 'background-color: rgb(255, 244, 118)'));
plant('an attribute dropped', once(out, ' data-style="title"', ''));
plant('an extra attribute', once(out, '<p ', '<p data-extra="1" '));
plant('a style declaration dropped', once(out, ' color: inherit;', ''));
{
  // Two elements swapped: the first two top-level siblings that differ.
  const w = new Window();
  const body = new w.DOMParser().parseFromString(`<body>${out}</body>`, 'text/html').body;
  const kids = [...body.children];
  const j = kids.findIndex((k, i) => i > 0 && k.outerHTML !== kids[0].outerHTML);
  body.insertBefore(kids[j], kids[0]);
  plant('two elements swapped', body.innerHTML);
}
const short = extensions.filter((e) => e.name !== 'highlight');
check('caught: one extension removed (highlight)', short.length === extensions.length - 1
  && sameDocument(page, serverPath(page, short)).length > 0);

// ---- 2. every fixture ------------------------------------------------------------
console.log(`\n2. Every fixture (${fixtures.length}): the server's render is the same document`);
for (const f of fixtures) {
  const html = readFixture(f.url);
  if (html.length < 100) { check(`${f.name}: a real page, not an empty file`, false, `${html.length} characters`); continue; }
  // The editor's own document when it was captured (the real path);
  // otherwise re-read from its HTML (see serverPath's warning).
  let json = null;
  try { if (f.json) json = JSON.parse(readFileSync(f.json, 'utf8')); } catch { json = null; }
  const rendered = json ? serverPathFromJson(json, extensions) : serverPath(html, extensions);
  const diffs = sameDocument(html, rendered);
  check(`${f.name} (${html.length} chars, from ${json ? "the editor's document" : 'its HTML'})`,
    diffs.length === 0, diffs.slice(0, 5).join('\n        '));
  if (json) {
    const viaHtml = sameDocument(html, serverPath(html, extensions));
    if (viaHtml.length) console.log(`        (for the record: re-read from its HTML instead, ${viaHtml.length} differences — the lossy re-read, not the server path)`);
  }
}

console.log(`\n  passed: ${passed}   failed: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
