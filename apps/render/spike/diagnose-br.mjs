// Diagnosis only (30 Sept): do marks on a hardBreak survive the Yjs round trip?
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';
const ext = documentExtensions();
const json = JSON.parse(readFileSync(new URL('../../../tests/docs-render/fixtures/google-docs-paste.json', import.meta.url), 'utf8'));
const count = (j) => { let all = 0, marked = 0; (function w(n) { if (n.type === 'hardBreak') { all++; if (n.marks?.length) marked++; } (n.content ?? []).forEach(w); })(j); return { all, marked }; };
const d = prosemirrorJSONToYDoc(getSchema(ext), json, 'default');
const f = new Y.Doc(); Y.applyUpdate(f, Y.encodeStateAsUpdate(d));
const back = yXmlFragmentToProsemirrorJSON(f.getXmlFragment('default'));
console.log('hardBreaks in the editor\'s document:', JSON.stringify(count(json)));
console.log('after the Yjs round trip:           ', JSON.stringify(count(back)));
// The minimal case, with no Google Docs at all:
const tiny = { type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'text', text: 'a', marks: [{ type: 'bold' }] }, { type: 'hardBreak', marks: [{ type: 'bold' }] }, { type: 'text', text: 'b', marks: [{ type: 'bold' }] }] }] };
const d2 = prosemirrorJSONToYDoc(getSchema(ext), tiny, 'default'); const f2 = new Y.Doc(); Y.applyUpdate(f2, Y.encodeStateAsUpdate(d2));
console.log('minimal: bold "a", bold <br>, bold "b" -> after Yjs the <br> marks are', JSON.stringify(yXmlFragmentToProsemirrorJSON(f2.getXmlFragment('default')).content[0].content[1].marks ?? null));
