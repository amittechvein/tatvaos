'use client';

import { displayName, formatMessageDate } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { CATEGORY_COLOURS, type MailCategory } from '../../lib/mail';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';

/**
 * The Yzen table-style message list: checkbox, a star + bookmark cluster,
 * avatar + sender, subject over a muted preview line, and the received time.
 * The whole sender/subject region opens the reading pane.
 *
 * NOTE for Phase 1: renders every row. Fine at a page of 50; a huge folder
 * needs TanStack Virtual, swapped in here only.
 */
export function MessageList({
  messages,
  selectedIds,
  openId,
  onToggleSelect,
  onOpen,
  onToggleFlag,
  categoriesById,
}: {
  messages: Message[];
  selectedIds: Set<string>;
  openId: string | null;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onToggleFlag: (id: string) => void;
  /**
   * The person's categories, keyed by id, for the colour chip on rows whose
   * message carries a categoryId. Optional: search results and shared views
   * that have not loaded categories render plainly rather than wrongly.
   */
  categoriesById?: Record<string, MailCategory>;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand-500 dark:bg-brand-600/15">
          <Icon name="inbox" className="h-7 w-7" />
        </span>
        <p className="text-sm font-medium text-ink">You&rsquo;re all caught up</p>
        <p className="mt-1 text-xs text-ink-muted">New mail will appear here.</p>
      </div>
    );
  }

  // ==========================================================================
  //  Calm-premium row rules, 24 Aug 2026, so the choices survive their author:
  //
  //  · UNREAD IS A DOT, not a typeface shout. Bolding sender+subject+date at
  //    once made every unread row yell; a 6px brand dot in a fixed slot says
  //    the same thing quietly, and the slot is ALWAYS there so read and
  //    unread rows never mis-align by six pixels.
  //  · THE CHECKBOX EARNS ITS INK. Visible on hover, when checked, and while
  //    any selection is in progress — invisible the rest of the time. A
  //    column of empty checkboxes is furniture; Gmail's is the look Amit
  //    asked to leave behind.
  //  · THE ACTIVE ROW IS A LEFT ACCENT BAR + tint, not just a tint. The bar
  //    survives squinting; a pale wash alone does not.
  //  · The decorative bookmark icon is gone — it did nothing, and dead
  //    controls are the opposite of premium.
  // ==========================================================================
  const selecting = selectedIds.size > 0;

  // PASS TWO, after Amit's verdict on pass one: "still look same as gmail."
  // He was right, and the reason was structural: a continuous ruled table IS
  // the Gmail signature, whatever the shadows do. So the table is gone. Each
  // message is a CARD floating on the canvas — read mail sits translucent
  // and calm, unread lifts with a real shadow, the open one carries the
  // brand ring. Same data, same density within a card, unmistakably not a
  // spreadsheet of email.
  return (
    <ul className="scroll-thin h-full list-none space-y-2 overflow-y-auto p-3 pl-3">
      {messages.map((m) => {
        const checked = selectedIds.has(m.id);
        const active = m.id === openId;
        return (
          <li key={m.id}>
            <div
              className={`group relative flex items-center gap-3 rounded-xl px-3.5 py-3 transition ${
                active
                  ? 'bg-surface shadow-card ring-1 ring-brand-500/60'
                  : checked
                    ? 'bg-brand-50 dark:bg-brand-600/15'
                    : m.isRead
                      ? 'bg-surface/50 hover:bg-surface hover:shadow-card'
                      : 'bg-surface shadow-card hover:shadow-raised'
              }`}
            >
              {/* The active accent — a pill, inset so the card's radius stays clean. */}
              {active && (
                <span aria-hidden="true"
                  className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-full bg-brand-500" />
              )}

              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleSelect(m.id)}
                aria-label="Select message"
                className={`h-4 w-4 shrink-0 cursor-pointer accent-brand-600 transition ${
                  checked || selecting
                    ? 'opacity-100'
                    : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                }`}
              />

              <button
                type="button"
                onClick={() => onToggleFlag(m.id)}
                aria-label={m.isFlagged ? 'Remove star' : 'Add star'}
                className={`shrink-0 transition ${
                  m.isFlagged
                    ? 'text-warn'
                    : 'text-ink-faint/40 opacity-0 hover:text-warn focus-visible:opacity-100 group-hover:opacity-100'
                }`}
              >
                <Icon name="star" filled={m.isFlagged} className="h-4.5 w-4.5" />
              </button>

              {/* The unread dot's slot — present on every row, so nothing shifts. */}
              <span className="flex w-1.5 shrink-0 justify-center" aria-hidden="true">
                {!m.isRead && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />}
              </span>

              <button
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <Avatar address={m.from} size={36} />
                {/* The sender column was a flat w-40 - 160px reserved for a
                    name whatever the pane was doing. In a list panel beside an
                    open reading pane that is most of the room, so subjects
                    truncated to "Minutes: 24-08-2026 - 24 ..." with white space
                    sitting next to them. Narrow by default and only generous
                    where there is genuinely space; the subject is the thing
                    being scanned for. */}
                <span
                  className={`hidden w-28 shrink-0 truncate text-sm sm:block lg:w-36 ${
                    m.isRead ? 'text-ink-muted' : 'font-semibold text-ink'
                  }`}
                >
                  {displayName(m.from)}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm sm:hidden ${
                      m.isRead ? 'text-ink-muted' : 'font-semibold text-ink'
                    }`}
                  >
                    {displayName(m.from)}
                  </span>
                  <span
                    className={`block truncate text-sm ${
                      m.isRead ? 'text-ink' : 'font-semibold text-ink'
                    }`}
                  >
                    {m.subject || '(no subject)'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-muted/80">
                    {m.hasAttachments && <Icon name="attach" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
                    {(() => {
                      /* categoryId rides on the API payload; the shared
                         Message type does not carry it yet - a shared-types
                         addition is Core's, so this reads it structurally
                         rather than editing packages/types. */
                      const catId = (m as Message & { categoryId?: string | null }).categoryId;
                      const cat = catId && categoriesById ? categoriesById[catId] : undefined;
                      if (!cat) return null;
                      const c = CATEGORY_COLOURS[cat.colour] ?? CATEGORY_COLOURS.grey!;
                      /* A NAMED CHIP, not a bare dot. Nine dots are only
                         distinguishable to people with full colour vision
                         and a good memory; the name makes the colour
                         decoration rather than information. */
                      return (
                        <span className={`inline-flex max-w-24 shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium ${c.chip}`}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
                          <span className="truncate">{cat.name}</span>
                        </span>
                      );
                    })()}
                    <span className="truncate">{m.snippet}</span>
                  </span>
                </span>
              </button>

              {/* tabular-nums so a column of times forms a column, not a
                  ragged edge — small, and exactly the kind of small that
                  separates calm from busy. */}
              <span
                className={`shrink-0 text-xs tabular-nums ${
                  m.isRead ? 'text-ink-faint' : 'font-medium text-ink-muted'
                }`}
              >
                {formatMessageDate(m.sentAt)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
