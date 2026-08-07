'use client';

import { displayName, formatMessageDate } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
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
}: {
  messages: Message[];
  selectedIds: Set<string>;
  openId: string | null;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onToggleFlag: (id: string) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-ink-faint">
        <Icon name="inbox" className="mb-3 h-10 w-10" />
        <p className="text-sm">Nothing here</p>
      </div>
    );
  }

  return (
    <ul className="scroll-thin h-full overflow-y-auto">
      {messages.map((m) => {
        const checked = selectedIds.has(m.id);
        const active = m.id === openId;
        return (
          <li key={m.id} className="border-b border-line/70 last:border-0">
            <div
              className={`group flex items-center gap-3 px-4 py-3 transition ${
                active
                  ? 'bg-brand-50 dark:bg-brand-600/15'
                  : checked
                    ? 'bg-canvas'
                    : m.isRead
                      ? 'hover:bg-canvas/70'
                      : 'bg-surface hover:bg-canvas/70'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleSelect(m.id)}
                aria-label="Select message"
                className="h-4 w-4 shrink-0 cursor-pointer accent-brand-600"
              />

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onToggleFlag(m.id)}
                  aria-label={m.isFlagged ? 'Remove star' : 'Add star'}
                  className={`transition ${m.isFlagged ? 'text-warn' : 'text-ink-faint/50 hover:text-ink-faint'}`}
                >
                  <Icon name="star" filled={m.isFlagged} className="h-4.5 w-4.5" />
                </button>
                <span className="hidden text-ink-faint/40 sm:inline">
                  <Icon name="bookmark" className="h-4 w-4" />
                </span>
              </div>

              <button
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <Avatar address={m.from} size={34} />
                <span
                  className={`hidden w-40 shrink-0 truncate text-sm sm:block ${
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
                    className={`block truncate text-sm ${m.isRead ? 'font-medium text-ink' : 'font-semibold text-ink'}`}
                  >
                    {m.subject || '(no subject)'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-muted">
                    {m.hasAttachments && <Icon name="attach" className="h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate">{m.snippet}</span>
                  </span>
                </span>
              </button>

              <span
                className={`shrink-0 text-xs ${m.isRead ? 'text-ink-faint' : 'font-semibold text-ink'}`}
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
