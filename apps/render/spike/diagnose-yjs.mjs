// Diagnosis only: which JSON paths differ after the Yjs round trip, nulls ignored.
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';
const raw = readFileSync(new URL('../../../tests/docs-html/editor-page.html', import.meta.url), 'utf8');
const ext = documentExtensions();
const json = generateJSON(raw.slice(raw.indexOf('-->') + 3).trim(), ext);
const d = prosemirrorJSONToYDoc(getSchema(ext), json, 'default');
const f = new Y.Doc(); Y.applyUpdate(f, Y.encodeStateAsUpdate(d));
const back = yXmlFragmentToProsemirrorJSON(f.getXmlFragment('default'));
const diffs = [];
(function walk(a, b, path) {
  if (a === b) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] === null && !(k in b)) continue;
      walk(a[k], b[k], `${path}.${k}`);
    }
    return;
  }
  diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
})(json, back, '');
console.log(`${diffs.length} differences (nulls ignored)`);
for (const x of diffs.slice(0, 8)) console.log('  ' + x.replace(/content\.(\d+)/g, 'c$1'));
