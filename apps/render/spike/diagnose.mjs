// Diagnosis only, after the gate FAILED (29 Sept 2026). Nothing here changes
// the render; it measures what the difference IS, for Mr. Singh's ruling.
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { Window } from 'happy-dom';
import { documentExtensions } from '../../web/components/docs/schema.ts';

const raw = readFileSync(new URL('../../../tests/docs-html/editor-page.html', import.meta.url), 'utf8');
const fixture = raw.slice(raw.indexOf('-->') + 3).trim();
const ext = documentExtensions();
const json = generateJSON(fixture, ext);
const ydoc = prosemirrorJSONToYDoc(getSchema(ext), json, 'default');
const fresh = new Y.Doc(); Y.applyUpdate(fresh, Y.encodeStateAsUpdate(ydoc));
const back = yXmlFragmentToProsemirrorJSON(fresh.getXmlFragment('default'));
const out = generateHTML(back, ext);

// 1. Is the Yjs difference ONLY attributes whose value is null?
const dropNulls = (v) => Array.isArray(v) ? v.map(dropNulls)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]))
  : v;
console.log('1. Yjs: equal once null-valued attributes are ignored:', JSON.stringify(dropNulls(back)) === JSON.stringify(dropNulls(json)));
console.log('   …and the HTML written from each is identical:', generateHTML(back, ext) === generateHTML(json, ext));

// 2. Is the HTML difference ONLY the order of attributes inside tags?
const sortAttrs = (html) => html.replace(/<([a-z][a-z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)+)\s*(\/?)>/gi, (m, tag, attrs, slash) => {
  const list = attrs.match(/[^\s=>]+(?:="[^"]*")?/g).sort();
  return `<${tag} ${list.join(' ')}${slash}>`;
});
console.log('2. HTML: equal once attributes inside each tag are sorted:', sortAttrs(out) === sortAttrs(fixture));
const tagsFixture = fixture.match(/<[a-z][^>]*>/gi) ?? [];
const tagsOut = out.match(/<[a-z][^>]*>/gi) ?? [];
const reordered = tagsFixture.filter((t, i) => t !== tagsOut[i]);
console.log(`   tags: ${tagsFixture.length} in the fixture, ${tagsOut.length} in the render; ${reordered.length} differ, e.g.`);
for (const t of reordered.slice(0, 4)) console.log(`     editor ${t}\n     server ${tagsOut[tagsFixture.indexOf(t)]}`);

// 3. Where the order comes from: the DOM, not TipTap. Same two setAttribute
// calls, in the same order, into happy-dom:
const w = new Window();
const p = w.document.createElement('p');
p.setAttribute('data-style', 'title');
p.setAttribute('style', 'text-align: center;');
console.log('3. happy-dom, setAttribute(data-style) then setAttribute(style) ->', p.outerHTML);
console.log('   a browser keeps the order the attributes were set in (the fixture: data-style first)');
