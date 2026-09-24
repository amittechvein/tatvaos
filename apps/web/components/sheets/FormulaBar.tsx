'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FUNCTIONS, FUNCTION_NAMES } from '@/lib/sheets/engine/functions';
import { SI } from './icons';

// ============================================================================
//  The formula bar: the name box (where you are; type B5 or A1:C9 to go
//  there) and the contents of the active cell. Typing here and typing in
//  the cell are the same edit — both write the grid's draft.
//
//  While a formula is being typed, two helpers appear under the bar:
//  function names matching what you are typing, and the signature of the
//  function the caret is inside ("SUMIF(range, criterion, [sum_range])").
// ============================================================================

export function FormulaBar({ address, value, editing, readOnly, note, onJump, onFocusEdit, onChange, onCommit, onCancel }: {
  address: string;
  /**
   * A short warning about this cell, shown INSIDE the bar (a banner below it
   * would push the grid down and back up as the selection moves — measured:
   * clicks landed a row off). The full sentence is the label's tooltip.
   */
  note?: string | null;
  /** The draft while editing, else the active cell's input. */
  value: string;
  editing: boolean;
  readOnly: boolean;
  onJump: (target: string) => boolean;
  onFocusEdit: () => void;
  onChange: (text: string) => void;
  onCommit: (move: 'down' | 'right' | 'none') => void;
  onCancel: () => void;
}) {
  const [box, setBox] = useState(address);
  const [boxFocused, setBoxFocused] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [pick, setPick] = useState(0);

  useEffect(() => { if (!boxFocused) setBox(address); }, [address, boxFocused]);

  const help = useMemo(() => formulaHelp(value, editing), [value, editing]);
  useEffect(() => setPick(0), [help.prefix]);

  function accept(name: string) {
    const text = value.slice(0, value.length - help.prefix.length) + name + '(';
    onChange(text);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(text.length, text.length); });
  }

  return (
    <div className="relative flex items-stretch border-y border-line bg-surface text-sm">
      <input aria-label="Name box — type a cell or range to go there" value={box}
        onFocus={(e) => { setBoxFocused(true); e.target.select(); }}
        onBlur={() => { setBoxFocused(false); setBox(address); }}
        onChange={(e) => setBox(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (onJump(box.trim())) (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setBox(address); (e.target as HTMLInputElement).blur(); }
        }}
        className="w-24 shrink-0 border-r border-line bg-transparent px-2 py-1 font-mono text-[13px] text-ink outline-none focus:bg-canvas" />
      <span className="flex w-8 shrink-0 items-center justify-center border-r border-line text-ink-faint" aria-hidden="true">
        <SI.functions className="h-4 w-4" />
      </span>
      <textarea ref={input} data-sheets-formula-bar="true" aria-label="Cell contents" rows={1}
        value={value} readOnly={readOnly} spellCheck={false}
        onFocus={() => { if (!editing && !readOnly) onFocusEdit(); }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (help.names.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && help.names.length > 0 && help.prefix.length > 0))) {
            e.preventDefault();
            accept(help.names[pick]!);
            return;
          }
          if (help.names.length > 0 && e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(help.names.length - 1, p + 1)); return; }
          if (help.names.length > 0 && e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); return; }
          if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); onCommit('down'); return; }
          if (e.key === 'Tab') { e.preventDefault(); onCommit('right'); return; }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="min-h-[30px] flex-1 resize-none bg-transparent px-2 py-1.5 font-mono text-[13px] leading-5 text-ink outline-none" />
      {note && (
        <span role="note" title={note} aria-label={note}
          className="m-1 flex shrink-0 cursor-help items-center gap-1 self-center rounded-full bg-[#f1f3f4] px-2.5 py-0.5 text-xs text-[#3c4043] dark:bg-canvas dark:text-ink-muted">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
          Saved as text in downloads
        </span>
      )}

      {editing && (help.names.length > 0 || help.sig) && (
        <div className="absolute left-32 top-full z-40 mt-1 w-[26rem] max-w-[80vw] rounded-lg border border-line bg-surface py-1 text-sm shadow-raised">
          {help.names.length > 0 ? help.names.map((n, i) => (
            <button key={n} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => accept(n)}
              className={`block w-full px-3 py-1.5 text-left ${i === pick ? 'bg-canvas' : ''}`}>
              <span className="font-mono font-semibold text-ink">{n}</span>
              <span className="ml-2 text-xs text-ink-muted">{FUNCTIONS[n]!.desc}</span>
            </button>
          )) : help.sig && (
            <div className="px-3 py-1.5">
              <p className="font-mono text-ink">{help.sig}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{help.desc}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Suggestions for the formula text so far (the caret is taken to be at the end). */
export function formulaHelp(text: string, editing: boolean): { prefix: string; names: string[]; sig: string | null; desc: string | null } {
  const none = { prefix: '', names: [], sig: null, desc: null };
  if (!editing || !text.startsWith('=')) return none;
  // Strip text inside quotes so a "(" in a string does not count.
  const bare = text.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));
  const m = /(?:^=|[=(,+\-*/^&<>:;\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(bare);
  if (m && !/^\$?[A-Za-z]{1,3}\$?\d+$/.test(m[1]!)) {
    const p = m[1]!.toUpperCase();
    const names = FUNCTION_NAMES.filter((n) => n.startsWith(p)).slice(0, 8);
    if (names.length > 0 && !(names.length === 1 && names[0] === p)) return { prefix: m[1]!, names, sig: null, desc: null };
  }
  // The innermost unclosed call.
  const stack: string[] = [];
  const re = /([A-Za-z][A-Za-z0-9.]*)\s*\(|\(|\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(bare))) {
    if (x[0] === ')') stack.pop();
    else stack.push(x[1] ? x[1].toUpperCase() : '');
  }
  const fn = stack.reverse().find((s) => s && FUNCTIONS[s]);
  if (fn) return { prefix: '', names: [], sig: FUNCTIONS[fn]!.sig, desc: FUNCTIONS[fn]!.desc };
  return none;
}
