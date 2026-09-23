'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { AdvancedSearch } from './AdvancedSearch';
import {
  SEARCH_OPERATORS, completeWith, currentFragment, tokenise, withoutToken,
} from '@/lib/mailSearchTokens';

/**
 * The mail search box: what was typed, what it was understood as, and what
 * else can be asked.
 *
 * ── THE POINT OF THE CHIPS ──────────────────────────────────────────────
 *
 *  A query language is only useful if you can see that it was understood.
 *  `from:priya is:unread newer_than:7d` is three conditions, and until the
 *  box says so the only way to find out you fat-fingered `form:priya` is
 *  that the results look thin — which is indistinguishable from there being
 *  no such mail. A chip that reads "from priya" is the product agreeing with
 *  you out loud.
 *
 *  Unrecognised words show as plain "contains" chips rather than being
 *  hidden, because the server treats them as text and the screen must not
 *  disagree with the server.
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
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false); setHelp(false); setAdvanced(false);
      }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, help, advanced]);

  const tokens = tokenise(value);

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

  return (
    <div ref={box} className="relative">
      <div className="flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 shadow-card">
        <Icon name="search" className="h-4 w-4 shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search mail"
          aria-label="Search mail"
          className="w-28 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint sm:w-44"
        />
        {value.length > 0 && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear search"
                  className="text-ink-faint transition hover:text-ink">×</button>
        )}
        {/* The caret is Gmail's "show search options" — the form for people
            who do not know the operators, which is most people. */}
        <button type="button"
                onClick={() => { setAdvanced((v) => !v); setOpen(false); setHelp(false); }}
                aria-label="Advanced search" aria-expanded={advanced}
                title="Advanced search"
                className="text-ink-faint transition hover:text-ink">▾</button>
        <button type="button" onClick={() => { setHelp((v) => !v); setOpen(false); setAdvanced(false); }}
                aria-label="Search options" title="What you can search for"
                className="text-ink-faint transition hover:text-ink">?</button>
      </div>

      {advanced && (
        <AdvancedSearch
          folders={folders}
          initial={value}
          onSearch={(q) => onChange(q)}
          onClose={() => setAdvanced(false)}
        />
      )}

      {/* What the query was understood as. */}
      {tokens.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-wrap gap-1">
          {tokens.map((t, i) => (
            <button
              key={`${t.raw}-${i}`}
              type="button"
              onClick={() => onChange(withoutToken(value, i))}
              title="Remove this condition"
              className="flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-ink shadow-card transition hover:bg-canvas"
            >
              <span className="text-ink-muted">
                {t.negated ? 'not ' : ''}{t.field ? `${t.field} ` : 'contains '}
              </span>
              <span className="font-medium">{t.value || '—'}</span>
              <span className="text-ink-faint">×</span>
            </button>
          ))}
        </div>
      )}

      {/* Operator suggestions while typing. */}
      {open && suggestions.length > 0 && (
        <div role="listbox" aria-label="Search operators"
             className="absolute right-0 top-full z-30 mt-9 w-72 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-raised">
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

      {/* The whole list, for somebody who does not know what to type. */}
      {help && (
        <div className="absolute right-0 top-full z-30 mt-9 max-h-[60vh] w-80 overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-raised">
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
