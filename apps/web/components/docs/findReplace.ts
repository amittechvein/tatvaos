// ============================================================================
//  Find and replace in Docs (Amit's Docs & Sheets Phase 2, item 3; 10 Oct 2026)
//
//  Two layers, kept apart so the search itself can be tested without an
//  editor (tests/docs/find-replace.test.ts):
//    findInText    plain text + query -> [start, end) index pairs
//    findInDoc     a ProseMirror document -> [from, to) document positions,
//                  block by block, so a word half in bold is still one match
//                  and a match never runs from one paragraph into the next
//  and a decoration plugin that paints the matches (the current one
//  stronger), fed by the find bar through plugin meta.
//
//  Matches never cross an image, a hard line break or a page break: those
//  leaves are an object character in the block's text, which no query
//  contains.
// ============================================================================

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

/** Stands for an image or a break inside a block's text: no query contains it. */
const OBJECT = '￼';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A letter or digit in any script (Devanagari included), for "whole words". */
const WORD = /[\p{L}\p{N}\p{M}_]/u;

/** Every match of `query` in `text`, left to right, not overlapping. An empty query finds nothing. */
export function findInText(text: string, query: string, opts: FindOptions): [number, number][] {
  if (query === '') return [];
  const re = new RegExp(escapeRegExp(query), opts.matchCase ? 'gu' : 'giu');
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (opts.wholeWord) {
      const before = start > 0 ? text[start - 1]! : '';
      const after = end < text.length ? text[end]! : '';
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
    }
    out.push([start, end]);
  }
  return out;
}

export interface Match { from: number; to: number }

/** Every match in a document, as document positions, block by block. */
export function findInDoc(doc: PMNode, query: string, opts: FindOptions): Match[] {
  const out: Match[] = [];
  if (query === '') return out;
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    // The block's text, and for each character the document position it sits at.
    let text = '';
    const at: number[] = [];
    block.forEach((child, offset) => {
      const pos = blockPos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? '';
        for (let i = 0; i < t.length; i += 1) at.push(pos + i);
        text += t;
      } else {
        at.push(pos);
        text += OBJECT;
      }
    });
    for (const [s, e] of findInText(text, query, opts)) out.push({ from: at[s]!, to: at[e - 1]! + 1 });
    return false; // a text block's children are inline: nothing further down to search
  });
  return out;
}

// ---- the painting -------------------------------------------------------------

export const findKey = new PluginKey<FindState>('docsFind');

interface FindState { query: string; opts: FindOptions; current: number; matches: Match[] }

const EMPTY: FindState = { query: '', opts: { matchCase: false, wholeWord: false }, current: 0, matches: [] };

/** What the find bar sends (tr.setMeta(findKey, …)): a new search, or a new current match. */
export type FindMeta = { query: string; opts: FindOptions; current?: number } | { current: number } | { clear: true };

export const FindHighlights = Extension.create({
  name: 'findHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (meta && 'clear' in meta) return EMPTY;
            const query = meta && 'query' in meta ? meta.query : prev.query;
            const opts = meta && 'opts' in meta ? meta.opts : prev.opts;
            // Re-searched on every change to the document — a colleague's
            // typing moves and adds matches — or to the search itself.
            const matches = tr.docChanged || (meta && 'query' in meta)
              ? findInDoc(tr.doc, query, opts)
              : prev.matches;
            let current = meta && 'current' in meta && typeof meta.current === 'number' ? meta.current : prev.current;
            if (matches.length === 0) current = 0;
            else current = ((current % matches.length) + matches.length) % matches.length;
            return { query, opts, current, matches };
          },
        },
        props: {
          decorations(state: EditorState) {
            const s = findKey.getState(state);
            if (!s || s.matches.length === 0) return DecorationSet.empty;
            return DecorationSet.create(state.doc, s.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, { class: i === s.current ? 'docs-find docs-find-current' : 'docs-find' })));
          },
        },
      }),
    ];
  },
});

/** The find state now: its matches and which is current. */
export const findState = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY;
