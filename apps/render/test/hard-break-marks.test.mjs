// ============================================================================
//  No marks on a line break (decision 0011 condition 4, entry 1)
// ============================================================================
//
//  apps/web/components/docs/extensions.ts → stripHardBreakMarks. Storage
//  (y-tiptap) keeps no marks on a hard break, so the editor now removes them
//  as they arrive: the first view equals the reload. Each case is shown first
//  WITHOUT the rule (the break does carry marks; the first view and the reload
//  differ), then with it.
//
//    node --import ./src/register.mjs --test test/hard-break-marks.test.mjs
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state';
import { Slice, Fragment } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';
import { stripHardBreakMarks } from '../../web/components/docs/extensions.ts';

const schema = getSchema(documentExtensions());
const rule = new Plugin({ appendTransaction: stripHardBreakMarks });
const bold = schema.marks.bold.create();

const start = (withRule, json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fees due', marks: [{ type: 'bold' }] }] }] }) =>
  EditorState.create({ schema, doc: schema.nodeFromJSON(json), plugins: withRule ? [rule] : [] });

const breaks = (doc) => { const out = []; doc.descendants((n) => { if (n.type.name === 'hardBreak') out.push(n.marks.map((m) => m.type.name)); }); return out; };
// What a reload shows: the document through storage and back.
const reloaded = (doc) => yXmlFragmentToProsemirrorJSON(
  (() => { const y = new Y.Doc(); Y.applyUpdate(y, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, doc.toJSON(), 'default'))); return y.getXmlFragment('default'); })());
const firstViewIsReload = (doc) => JSON.stringify(doc.toJSON()) === JSON.stringify(schema.nodeFromJSON(reloaded(doc)).toJSON());

/** A paste that carries a bold line break (what a Google Docs paste brings). */
function paste(state) {
  const slice = new Slice(Fragment.from([
    schema.text('one', [bold]), schema.nodes.hardBreak.create(null, null, [bold]), schema.text('two', [bold]),
  ]), 0, 0);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 9)).replaceSelection(slice));
}

/** Shift+Enter inside bold text: the break inherits the marks at the cursor. */
function shiftEnter(state) {
  const tr = state.tr.setSelection(TextSelection.create(state.doc, 5));
  return state.apply(tr.replaceSelectionWith(schema.nodes.hardBreak.create()));
}

for (const [name, act] of [['a paste carrying a bold line break', paste], ['Shift+Enter inside bold text', shiftEnter]]) {
  test(`${name}: red without the rule — the break is bold, and the first view differs from the reload`, () => {
    const s = act(start(false));
    assert.deepEqual(breaks(s.doc), [['bold']], 'the case really produces a marked break');
    assert.equal(firstViewIsReload(s.doc), false, 'and storage really drops it');
  });
  test(`${name}: with the rule — no marks on the break, the text keeps its bold, and the first view IS the reload`, () => {
    const s = act(start(true));
    assert.deepEqual(breaks(s.doc), [[]]);
    let boldText = 0;
    s.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type === schema.marks.bold)) boldText += n.text.length; });
    assert.ok(boldText >= 'Fees due'.length, 'the text around it is still bold');
    assert.equal(firstViewIsReload(s.doc), true);
  });
}

test('a change elsewhere leaves the rest of the document alone (only changed ranges are looked at)', () => {
  // A document that already holds a marked break (only possible from before
  // this rule; storage never keeps one) — typing elsewhere does not touch it.
  const json = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak', marks: [{ type: 'bold' }] }, { type: 'text', text: 'b' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
  ] };
  const s0 = start(true, json);
  const s = s0.apply(s0.tr.insertText('!', s0.doc.content.size - 1));
  assert.deepEqual(breaks(s.doc), [['bold']]);
});

test('a transaction that changes nothing in the document adds nothing', () => {
  const s0 = start(true);
  const r = s0.applyTransaction(s0.tr.setSelection(TextSelection.create(s0.doc, 2)));
  assert.equal(r.transactions.length, 1, 'no appended transaction');
});

test('the editor ships the rule: documentExtensions() includes it, wrapping this same function', () => {
  const ext = documentExtensions().find((e) => e.name === 'noMarksOnHardBreaks');
  assert.ok(ext, 'NoMarksOnHardBreaks is in documentExtensions() — what DocEditor uses');
});
