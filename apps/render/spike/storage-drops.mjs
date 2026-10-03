// ============================================================================
//  The CLOSED LIST of known storage drops (decision 0011, condition 4)
// ============================================================================
//
//  Mr. Singh, 30 Sept 2026: the gate compares the server's file with the
//  editor RELOADED from storage — the stored Yjs state is the document. But
//  two things derived from the same stored state would also agree if storage
//  dropped something visible. So the gate ALSO compares the editor's first
//  view (before storage) with the editor reloaded, and every difference must
//  be explained by an entry here. Any other kind of difference fails the
//  gate. A new entry needs his ruling. Whenever an entry fires, condition 4's
//  log line is written: the document and the kind of drop, never content.
//
//  Each entry is a function over the editor's document (editor JSON) that
//  applies the drop and returns how many times it did so.
// ============================================================================

export const STORAGE_DROPS = [
  {
    id: 1,
    kind: 'marks on a hard break',
    why: 'y-tiptap stores no marks on a non-text inline node. Invisible in practice (a line break shows no glyph); proven 30 Sept 2026 (14 of 60 in the Google Docs fixture, a 3-character reproduction). Ruled by Mr. Singh, 30 Sept 2026.',
    apply(node) {
      let n = 0;
      (function walk(x) {
        if (x.type === 'hardBreak' && x.marks?.length) { delete x.marks; n += 1; }
        (x.content ?? []).forEach(walk);
      })(node);
      return n;
    },
  },
];

/** A copy of the document with every listed drop applied, and what fired. */
export function applyDrops(json, list = STORAGE_DROPS) {
  const copy = structuredClone(json);
  const fired = [];
  for (const d of list) {
    const count = d.apply(copy);
    if (count > 0) fired.push({ id: d.id, kind: d.kind, count });
  }
  return { json: copy, fired };
}

/** Condition 4's log line: the document and the kind of drop, never content. */
export function logLine(documentName, f) {
  return `storage drop: document "${documentName}": ${f.kind} (entry ${f.id}) x${f.count}`;
}
