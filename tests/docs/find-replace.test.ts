// ============================================================================
//  Find and replace in Docs — the search (components/docs/findReplace.ts).
//  Amit's Docs & Sheets Phase 2, item 3 (10 Oct 2026).
//
//    node --import ./tests/sheets/register.mjs --test tests/docs/find-replace.test.ts
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '../../apps/web/node_modules/@tiptap/pm/dist/model/index.js';
import { EditorState } from '../../apps/web/node_modules/@tiptap/pm/dist/state/index.js';
import { findInText, findInDoc, findKey, FindHighlights } from '../../apps/web/components/docs/findReplace.ts';

const plain = { matchCase: false, wholeWord: false };

test('text: every match, left to right, ignoring case unless asked', () => {
  assert.deepEqual(findInText('Fee, fee, FEE', 'fee', plain), [[0, 3], [5, 8], [10, 13]]);
  assert.deepEqual(findInText('Fee, fee, FEE', 'fee', { ...plain, matchCase: true }), [[5, 8]]);
  assert.deepEqual(findInText('aaaa', 'aa', plain), [[0, 2], [2, 4]], 'not overlapping');
  assert.deepEqual(findInText('anything', '', plain), [], 'an empty query finds nothing');
});

test('text: the query is literal — regular-expression characters mean themselves', () => {
  assert.deepEqual(findInText('Total (₹) is 5.00 + 2*3', '(₹)', plain), [[6, 9]]);
  assert.deepEqual(findInText('5.00 and 5x00', '5.00', plain), [[0, 4]], '"." is a dot, not any character');
  assert.deepEqual(findInText('a+b', '+', plain), [[1, 2]]);
});

test('text: whole words, in any script', () => {
  assert.deepEqual(findInText('fee fees feet fee.', 'fee', { ...plain, wholeWord: true }), [[0, 3], [14, 17]]);
  // Hindi: "फीस" (fee) inside "फीसें" (fees) is not a whole word; on its own it is.
  const hi = 'फीस जमा करें। फीसें बाकी हैं।';
  assert.deepEqual(findInText(hi, 'फीस', { ...plain, wholeWord: true }), [[0, 3]]);
  assert.equal(findInText(hi, 'फीस', plain).length, 2, 'without whole words both are found');
});

// A schema with what matters to the search: paragraphs, text with a mark, and
// inline leaves (an image, a hard break) inside a paragraph.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, atom: true },
    hardBreak: { group: 'inline', inline: true },
  },
  marks: { bold: {} },
});
const t = (s: string, bold = false) => schema.text(s, bold ? [schema.marks.bold!.create()] : []);
const p = (...kids: Parameters<typeof schema.node>[2][]) => schema.node('paragraph', null, kids.flat() as never);

test('document: a word half in bold is ONE match, at the right positions', () => {
  const doc = schema.node('doc', null, [p(t('The pic'), t('nic', true), t(' is on Friday.'))]);
  const m = findInDoc(doc, 'picnic', plain);
  assert.equal(m.length, 1);
  assert.equal(doc.textBetween(m[0]!.from, m[0]!.to), 'picnic');
});

test('document: matches never run from one paragraph into the next, or across an image or a break', () => {
  const doc = schema.node('doc', null, [
    p(t('end of one')), p(t('one more')),
    p(t('pic'), schema.node('image'), t('nic')),
    p(t('pic'), schema.node('hardBreak'), t('nic')),
  ]);
  assert.equal(findInDoc(doc, 'oneone', plain).length, 0);
  assert.equal(findInDoc(doc, 'picnic', plain).length, 0);
  const one = findInDoc(doc, 'one', plain);
  assert.equal(one.length, 2);
  for (const m of one) assert.equal(doc.textBetween(m.from, m.to), 'one');
});

test('the highlights follow the document: a new match typed later is found, one deleted is gone', () => {
  const doc = schema.node('doc', null, [p(t('fee due'))]);
  let state = EditorState.create({ doc, plugins: FindHighlights.config.addProseMirrorPlugins!.call({ } as never) });
  state = state.apply(state.tr.setMeta(findKey, { query: 'fee', opts: plain, current: 0 }));
  assert.equal(findKey.getState(state)!.matches.length, 1);
  state = state.apply(state.tr.insertText(' and late fee', state.doc.content.size - 1));
  assert.equal(findKey.getState(state)!.matches.length, 2, 'a colleague typing a new match: it is highlighted');
  const first = findKey.getState(state)!.matches[0]!;
  state = state.apply(state.tr.insertText('charge', first.from, first.to));
  assert.equal(findKey.getState(state)!.matches.length, 1, 'replaced: one left');
  assert.equal(state.doc.textContent, 'charge due and late fee');
  state = state.apply(state.tr.setMeta(findKey, { clear: true }));
  assert.equal(findKey.getState(state)!.matches.length, 0, 'closing clears every highlight');
});

test('replace all, from the end backwards, keeps every replacement in its place', () => {
  const doc = schema.node('doc', null, [p(t('Rs 100, Rs 250 and Rs 75'))]);
  let state = EditorState.create({ doc, plugins: FindHighlights.config.addProseMirrorPlugins!.call({ } as never) });
  state = state.apply(state.tr.setMeta(findKey, { query: 'Rs ', opts: plain, current: 0 }));
  const matches = findKey.getState(state)!.matches;
  const tr = state.tr;
  for (let i = matches.length - 1; i >= 0; i -= 1) tr.insertText('₹', matches[i]!.from, matches[i]!.to);
  state = state.apply(tr);
  assert.equal(state.doc.textContent, '₹100, ₹250 and ₹75');
});
