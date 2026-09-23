'use client';

import { chipsFor, withoutTokens } from '@/lib/mailSearchTokens';

/**
 * What the query was understood as, as a row of removable chips.
 *
 * ── WHY THIS IS NOT INSIDE THE SEARCH BOX ───────────────────────────────
 *
 *  It was, until 23 September 2026, as an `absolute ... top-full` overlay
 *  hanging off the box. Amit sent a screenshot of the inbox with three rows
 *  of chips SITTING ON TOP OF THE MESSAGES — the first result was behind
 *  them, and the sender and time of the second were unreadable. An overlay
 *  cannot push anything down; that is what an overlay is.
 *
 *  Chips are not transient like a suggestion list. They persist for as long
 *  as the search does, so they are content, and content belongs in the flow
 *  where it takes its own room and moves the list down. This renders as a
 *  normal block under the header, full width, and the list starts below it.
 *
 *  It draws NOTHING when the query is only words (chipsFor explains why),
 *  which is the common case — so the usual search adds no row at all.
 */
export function SearchChips({
  value, onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const chips = chipsFor(value);

  // Only worth a row when something was read as a CONDITION. A query of
  // plain words has nothing to confirm, and a row saying "contains <what you
  // just typed>" is the box reading the box back to you.
  if (!chips.some((c) => c.field !== null)) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-1.5">
      {chips.map((c) => (
        <button
          key={c.indices.join(',')}
          type="button"
          onClick={() => onChange(withoutTokens(value, c.indices))}
          title="Remove this condition"
          className="flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-ink transition hover:bg-canvas"
        >
          {/* "not contains holiday" is not a sentence. A left-out word is
              "without"; a left-out condition keeps "not from priya". */}
          <span className="shrink-0 text-ink-muted">
            {c.field
              ? `${c.negated ? 'not ' : ''}${c.field} `
              : (c.negated ? 'without ' : 'contains ')}
          </span>
          <span className="truncate font-medium">{c.value || '—'}</span>
          <span className="shrink-0 text-ink-faint">×</span>
        </button>
      ))}
    </div>
  );
}
