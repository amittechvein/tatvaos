'use client';

import { formatMessageDate } from '@tatvaos/core';
import { displayName } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';

/**
 * NOTE for Phase 1: this renders every row.
 *
 * That is fine at the mock data size and NOT fine at production size — a
 * 50,000-message folder must scroll at 60fps, which needs TanStack Virtual.
 * Swapping it in is a change to this component only; everything above and
 * below stays as it is.
 */
export function MessageList({
  messages,
  selectedId,
  onSelect,
  onToggleFlag,
}: {
  messages: Message[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
    <ul className="scroll-thin h-full divide-y divide-line overflow-y-auto">
      {messages.map((m) => {
        const active = m.id === selectedId;
        return (
          <li key={m.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(m.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(m.id);
                }
              }}
              className={`flex cursor-pointer gap-3 px-4 py-3 transition ${
                active ? 'bg-brand-50' : m.isRead ? 'bg-surface hover:bg-canvas' : 'bg-blue-50/40 hover:bg-blue-50'
              }`}
            >
              <Avatar address={m.from} size={36} />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate text-sm ${m.isRead ? 'text-ink' : 'font-semibold text-ink'}`}
                  >
                    {displayName(m.from)}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-ink-muted">
                    {formatMessageDate(m.sentAt)}
                  </span>
                </div>

                <div
                  className={`truncate text-sm ${m.isRead ? 'text-ink-muted' : 'font-medium text-ink'}`}
                >
                  {m.subject || '(no subject)'}
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-ink-muted">{m.snippet}</span>
                  {m.hasAttachments && (
                    <Icon name="attach" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlag(m.id);
                }}
                aria-label={m.isFlagged ? 'Remove star' : 'Add star'}
                className={`self-start p-1 transition ${
                  m.isFlagged ? 'text-warn' : 'text-ink-faint/60 hover:text-ink-faint'
                }`}
              >
                <Icon name="star" filled={m.isFlagged} className="h-4 w-4" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
