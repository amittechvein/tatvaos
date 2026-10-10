'use client';

// ============================================================================
//  The find (and replace) bar of a document. The search and the highlights
//  are findReplace.ts; this drives them.
//
//  Ctrl+F opens it for finding, Ctrl+H (or Edit > Find and replace) with the
//  replace row as well — only for someone who can edit. Enter / Shift+Enter
//  step through the matches; Escape closes and clears the highlights.
//
//  Replace all is ONE transaction, so one Ctrl+Z undoes it, and a colleague
//  sees it arrive as one change.
// ============================================================================

import { useEffect, useReducer, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { findKey, findState, type FindMeta } from './findReplace';

export function FindBar({ editor, canEdit, withReplace, onClose, onNotice }: {
  editor: Editor; canEdit: boolean; withReplace: boolean; onClose: () => void; onNotice: (m: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(withReplace && canEdit);
  const findInput = useRef<HTMLInputElement>(null);

  // Re-render on every editor change: matches move as anyone types.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on('transaction', bump);
    return () => { editor.off('transaction', bump); };
  }, [editor]);

  useEffect(() => { setShowReplace(withReplace && canEdit); findInput.current?.focus(); findInput.current?.select(); }, [withReplace, canEdit]);

  const send = (meta: FindMeta, select?: { from: number; to: number }) => {
    const tr = editor.state.tr.setMeta(findKey, meta);
    // Selecting the match scrolls it into view; focus stays in this bar.
    if (select) tr.setSelection(TextSelection.create(tr.doc, select.from, select.to)).scrollIntoView();
    editor.view.dispatch(tr);
  };

  // A new search whenever the words or the options change.
  useEffect(() => {
    send({ query, opts: { matchCase, wholeWord }, current: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeWord]);

  // Clear the highlights when the bar closes.
  useEffect(() => () => { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(findKey, { clear: true })); }, [editor]);

  const s = findState(editor.state);
  const total = s.matches.length;

  function go(delta: number) {
    if (total === 0) return;
    const next = (((s.current + delta) % total) + total) % total;
    send({ current: next }, s.matches[next]);
  }

  function replaceOne() {
    const m = s.matches[s.current];
    if (!canEdit || !m) return;
    // The match is replaced; the plugin re-searches, and the same index is
    // now the NEXT match, so pressing Replace again walks the document.
    editor.view.dispatch(editor.state.tr.insertText(replacement, m.from, m.to).scrollIntoView());
  }

  function replaceAll() {
    if (!canEdit || total === 0) return;
    const tr = editor.state.tr;
    // From the end backwards, so earlier positions stay true as later text changes length.
    for (let i = total - 1; i >= 0; i -= 1) tr.insertText(replacement, s.matches[i]!.from, s.matches[i]!.to);
    editor.view.dispatch(tr);
    onNotice(`Replaced ${total} ${total === 1 ? 'match' : 'matches'}.`);
  }

  const field = 'min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand-600';
  const btn = 'rounded px-2 py-1 text-xs text-ink hover:bg-canvas disabled:opacity-40';

  return (
    <div role="search" aria-label="Find in document"
      className="absolute right-4 top-2 z-30 w-[22rem] rounded-lg border border-line bg-surface p-2 shadow-raised"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <div className="flex items-center gap-1.5">
        <input ref={findInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in document"
          aria-label="Find" className={field}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }} />
        <span className="w-16 shrink-0 text-right text-xs text-ink-muted" aria-live="polite">
          {query === '' ? '' : total === 0 ? 'No matches' : `${s.current + 1} of ${total}`}
        </span>
        <button type="button" className={btn} disabled={total === 0} onClick={() => go(-1)} aria-label="Previous match" title="Previous (Shift+Enter)">▲</button>
        <button type="button" className={btn} disabled={total === 0} onClick={() => go(1)} aria-label="Next match" title="Next (Enter)">▼</button>
        <button type="button" className={btn} onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
      </div>
      {showReplace && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Replace with"
            aria-label="Replace with" className={field}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } }} />
          <button type="button" className={btn} disabled={total === 0} onClick={replaceOne}>Replace</button>
          <button type="button" className={btn} disabled={total === 0} onClick={replaceAll}>Replace all</button>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-3 px-0.5 text-xs text-ink-muted">
        <label className="flex items-center gap-1"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole words</label>
        {canEdit && !showReplace && (
          <button type="button" className="ml-auto text-brand-600 hover:underline" onClick={() => setShowReplace(true)}>Replace…</button>
        )}
      </div>
    </div>
  );
}
