// ============================================================================
//  The file Space serves for a document, built from what the server stored
// ============================================================================
//
//  Decision 0011 condition 1; docs/DOCS_SERVER_RENDER_DESIGN.md. The input is
//  the document's stored Yjs state and every stored update after it — what
//  the server relayed to everyone. Nothing the browser claims is used: not
//  its HTML, not its text, not its state (Mr. Singh, 29 Sept 2026: "stop
//  trusting the browser's state in this same piece of work").
//
//  Output:
//    state   the merged state (state + updates), to store in its place
//    html    written by @tiptap/html with the editor's own schema
//    text    the plain text (search, AI), blocks separated by a newline as
//            the editor's getText({ blockSeparator: '\n' }) does
//    dropped element types in the stored document the schema does not know
//            — y-prosemirror drops them silently (0011 condition 4). Names
//            and counts only, never content.
//
//  The gate that proves the output is the same document as the editor shows
//  after a reload: apps/render/spike/gate.mjs (23/0 on 30 Sept 2026).
// ============================================================================

import * as Y from 'yjs';
import { getSchema, generateText } from '@tiptap/core';
import { generateHTML } from '@tiptap/html';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { documentExtensions } from '../../web/components/docs/schema.ts';

const extensions = documentExtensions();
const schema = getSchema(extensions);
export const SCHEMA_VERSION = 'docs-1';

/**
 * Remove what the schema does not know, as the live editor does, and say so.
 *
 * The editor (y-prosemirror's createNodeFromYElement) cannot build a node
 * whose type the schema lacks: it drops the element, with everything inside
 * it, and shows the rest. yXmlFragmentToProsemirrorJSON has no schema and
 * passes such an element through — and the HTML writer then throws (found
 * 30 Sept 2026 by the unknown-element test). So the render drops exactly what
 * the editor drops: an unknown element with its contents, an unknown mark
 * from its text. Each is counted by NAME for condition 4's log line — never
 * its content.
 */
function dropUnknown(json) {
  const counts = new Map();
  const note = (kind, name) => { const k = `${kind}\u0000${name}`; counts.set(k, (counts.get(k) ?? 0) + 1); };
  (function walk(node) {
    if (!Array.isArray(node.content)) return;
    node.content = node.content.filter((child) => {
      if (!schema.nodes[child.type]) { note('unknown element', child.type); return false; }
      if (Array.isArray(child.marks)) {
        child.marks = child.marks.filter((m) => (schema.marks[m.type] ? true : (note('unknown mark', m.type), false)));
        if (child.marks.length === 0) delete child.marks;
      }
      walk(child);
      return true;
    });
  })(json);
  return [...counts].map(([k, count]) => {
    const [kind, name] = k.split('\u0000');
    return { kind, name: String(name).slice(0, 64), count };
  });
}

/**
 * @param {Uint8Array[]} updates the stored state first, then every stored update after it
 */
export function renderDoc(updates) {
  if (!Array.isArray(updates) || updates.length === 0) throw new RangeError('no updates');
  const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, merged);
    const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'));
    const dropped = dropUnknown(json);
    return {
      state: Y.encodeStateAsUpdate(doc),
      json, // the PDF's input (render-pdf.mjs); not sent by /render/doc
      html: generateHTML(json, extensions),
      text: generateText(json, extensions, { blockSeparator: '\n' }),
      dropped,
      schema: SCHEMA_VERSION,
    };
  } finally {
    doc.destroy();
  }
}
