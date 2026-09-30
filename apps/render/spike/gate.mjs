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
import { applyDrops, logLine } from './storage-drops.mjs';

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
    .filter((f) => f.endsWith('.html') && !f.endsWith('.reloaded.html')) // a reload belongs to its fixture, it is not one
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

// ---- 2. every fixture, two halves (Mr. Singh, 30 Sept 2026) ---------------------
//
//  A. The server's file == the editor RELOADED from storage (the stored Yjs
//     state is the document; every reader sees the reload).
//  B. The editor's FIRST view vs the editor reloaded: every difference must be
//     explained by the closed list of known storage drops (storage-drops.mjs);
//     anything else fails. Each entry that fires writes condition 4's line.
//
//  A fixture with no reloaded HTML (editor-page, made before this ruling) can
//  only be checked the old way, against its first view, and says so.
console.log(`\n2. Every fixture (${fixtures.length}): A = server file vs the editor reloaded; B = first view vs reload, explained by the closed list`);
const reloadedOf = (f) => { try { return readFixture(new URL(f.url.href.replace(/\.html$/, '.reloaded.html'))); } catch { return null; } };
const jsonOf = (f) => { try { return f.json ? JSON.parse(readFileSync(f.json, 'utf8')) : null; } catch { return null; } };
const logLines = [];
for (const f of fixtures) {
  const first = readFixture(f.url);
  if (first.length < 100) { check(`${f.name}: a real page, not an empty file`, false, `${first.length} characters`); continue; }
  const json = jsonOf(f);
  const reloaded = reloadedOf(f);
  if (!json || !reloaded) {
    const diffs = sameDocument(first, json ? serverPathFromJson(json, extensions) : serverPath(first, extensions));
    check(`${f.name}: server file vs its FIRST view (no reloaded copy — made before the ruling)`, diffs.length === 0, diffs.slice(0, 5).join('\n        '));
    continue;
  }
  const a = sameDocument(reloaded, serverPathFromJson(json, extensions));
  check(`A ${f.name}: the server's file is the same document as the editor reloaded from storage`, a.length === 0, a.slice(0, 5).join('\n        '));
  const raw = sameDocument(first, reloaded).length;
  const { json: dropped, fired } = applyDrops(json);
  const b = sameDocument(reloaded, generateHTML(dropped, extensions));
  check(`B ${f.name}: first view vs reload — ${raw} difference(s), ${b.length === 0 ? 'every one on the list' : 'NOT all on the list'}`
    + (fired.length ? ` (${fired.map((x) => `entry ${x.id} x${x.count}`).join(', ')})` : ''), b.length === 0, b.slice(0, 5).join('\n        '));
  for (const x of fired) logLines.push(logLine(f.name, x));
}
if (logLines.length) console.log('\n  condition 4 log lines (document + kind, never content):\n    ' + logLines.join('\n    '));

// ---- 3. the closed list is calibrated ----------------------------------------------
console.log('\n3. The closed list is calibrated');
{
  const g = fixtures.find((f) => f.name === 'google-docs-paste');
  const json = g && jsonOf(g), first = g && readFixture(g.url), reloaded = g && reloadedOf(g);
  if (!json || !reloaded) check('the Google Docs fixture and its reload are present', false);
  else {
    // Entry 1 is doing the work: with an EMPTY list the same fixture fails B.
    const bare = sameDocument(reloaded, generateHTML(applyDrops(json, []).json, extensions));
    check('with the list EMPTY, the Google Docs first view is NOT explained (entry 1 carries it)', bare.length > 0 && sameDocument(first, reloaded).length > 0);
    // A fabricated drop of a different kind: storage "loses" one bold word.
    const i = reloaded.indexOf('<strong>');
    const j = reloaded.indexOf('</strong>', i);
    const fabricated = i < 0 ? reloaded : reloaded.slice(0, i) + reloaded.slice(i + 8, j) + reloaded.slice(j + 9);
    check('the fabrication changed the text', fabricated !== reloaded);
    const fb = sameDocument(fabricated, generateHTML(applyDrops(json).json, extensions));
    check('caught: a bold word losing its bold is NOT on the list, and fails', fb.length > 0);
  }
}

console.log(`\n  passed: ${passed}   failed: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
