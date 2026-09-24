'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { AdvancedSearch } from './AdvancedSearch';
import {
  SEARCH_OPERATORS, completeWith, currentFragment,
} from '@/lib/mailSearchTokens';

/**
 * The mail search box: what was typed, and what else can be asked.
 *
 * ── THE CHIPS LIVE IN SearchChips, NOT HERE ─────────────────────────────
 *
 *  A query language is only useful if you can see that it was understood,
 *  so the conditions read back as chips — but they used to hang off this
 *  box as an `absolute` overlay and covered the message list (Amit's
 *  screenshot, 23 September 2026). They are content, not a popover, so they
 *  moved into the page's flow under the header. SearchChips carries that
 *  reasoning and the rule about which tokens earn a chip at all.
 *
 *  What stays here is transient and SHOULD float: the operator suggestions
 *  while typing, the help list, and the advanced form. Those close on an
 *  outside click; a chip persists for as long as the search does.
 */
export function SearchBox({
  value, onChange, inputRef, folders = [],
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** For the advanced form's "Search in" list. */
  folders?: { label: string; value: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const fragment = currentFragment(value);
  const suggestions = fragment.length >= 1 && !fragment.includes('"')
    ? SEARCH_OPERATORS.filter((o) => o.op.startsWith(fragment.toLowerCase())
        || o.op.replace(':', '').startsWith(fragment.toLowerCase())).slice(0, 6)
    : [];

  useEffect(() => { setActive(0); }, [fragment]);

  // Close on any click outside — a suggestion list that survives a click
  // elsewhere reads as stuck.
  useEffect(() => {
    if (!open && !help && !advanced) return;
    // composedPath, not contains(target). Picking an address suggestion in the
    // advanced form removes that suggestion from the page during React's own
    // mousedown handling, BEFORE this document listener runs — so the target
    // is detached, contains() says "outside", and the whole form closed on
    // the click that filled it in (found driving it with a mouse, 24 Sept
    // 2026). The path is fixed when the event is dispatched.
    const away = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) {
        setOpen(false); setHelp(false); setAdvanced(false);
      }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, help, advanced]);

  const choose = (op: string) => {
    onChange(completeWith(value, op));
    setOpen(false);
    inputRef?.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' && suggestions[active]) { e.preventDefault(); choose(suggestions[active]!.op); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  // ── LAYOUT, FROM AMIT'S DESIGN OF 24 SEPTEMBER 2026 ────────────────────
  //  The box stops at 720px, Gmail's width; filling the whole bar (PR 246,
  //  the same morning) read as too long once seen on a wide screen. One
  //  sliders icon inside it opens the advanced form, and the ? that lists
  //  the operators sits apart at the bar's right end, beside the launcher.
  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-center gap-2">
      <div className="relative w-full max-w-[720px]">
        <div className="flex items-center gap-2 rounded-full bg-surface px-4 py-2.5 shadow-card">
          <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => { onChange(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search mail"
            aria-label="Search mail"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {value.length > 0 && (
            <button type="button" onClick={() => onChange('')} aria-label="Clear search"
                    className="text-ink-faint transition hover:text-ink">×</button>
          )}
          {/* Gmail's "show search options" — the form for people who do not
              know the operators, which is most people. */}
          <button type="button"
                  onClick={() => { setAdvanced((v) => !v); setOpen(false); setHelp(false); }}
                  aria-label="Advanced search" aria-expanded={advanced}
                  title="Advanced search"
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition hover:bg-canvas ${advanced ? 'text-brand-600' : 'text-brand-500 hover:text-brand-600'}`}>
            <i className="ri-equalizer-line text-[18px]" />
          </button>
        </div>

        {advanced && (
          <AdvancedSearch
            folders={folders}
            initial={value}
            onSearch={(q) => onChange(q)}
            onClose={() => setAdvanced(false)}
          />
        )}

        {/* Operator suggestions while typing. */}
        {open && suggestions.length > 0 && (
          <div role="listbox" aria-label="Search operators"
               className="absolute right-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-raised">
            {suggestions.map((s, i) => (
              <button
                key={s.op}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s.op)}
                className={`block w-full px-3 py-2 text-left ${i === active ? 'bg-canvas' : ''}`}
              >
                <div className="text-sm font-medium text-ink">{s.example}</div>
                <div className="text-[11px] text-ink-muted">{s.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hidden on a phone: at 375px it collided with the app launcher, and
          the sliders icon reaches the same help by other means. */}
      <button type="button" onClick={() => { setHelp((v) => !v); setOpen(false); setAdvanced(false); }}
              aria-label="Search options" title="What you can search for" aria-expanded={help}
              className="ml-auto hidden h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-canvas hover:text-ink sm:grid">
        <i className="ri-question-line text-[20px]" />
      </button>

      {/* The whole list, for somebody who does not know what to type. */}
      {help && (
        <div className="absolute right-0 top-full z-30 mt-2 max-h-[60vh] w-80 overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-raised">
          <p className="mb-2 mt-0 text-xs text-ink-muted">
            Combine these freely. A space means <strong className="text-ink">and</strong>,
            {' '}<strong className="text-ink">OR</strong> means either, and a
            {' '}<strong className="text-ink">-</strong> in front leaves something out.
          </p>
          {SEARCH_OPERATORS.map((s) => (
            <button key={s.op} type="button" onClick={() => choose(s.op)}
                    className="block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-canvas">
              <div className="text-[13px] font-medium text-ink">{s.example}</div>
              <div className="text-[11px] text-ink-muted">{s.hint}</div>
            </button>
          ))}
          <p className="mb-0 mt-2 border-t border-line pt-2 text-[11px] text-ink-muted">
            Deleted and junk mail stay out unless you ask for them with
            {' '}<span className="font-medium text-ink">in:trash</span>,
            {' '}<span className="font-medium text-ink">in:spam</span> or
            {' '}<span className="font-medium text-ink">in:anywhere</span>.
          </p>
        </div>
      )}
    </div>
  );
}
