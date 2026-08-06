'use client';

import { displayName, formatMessageDate } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';

/**
 * The Gmail-shaped list row: checkbox, star, sender column, subject — snippet
 * inline, attachment chips underneath, date on the right. On hover the date
 * yields to quick actions, so the common operations never need the message
 * opened first.
 *
 * NOTE for Phase 1: this renders every row. Fine at 100 rows a page; a
 * 50,000-message folder needs TanStack Virtual, swapped in here only.
 */
export function MessageList({
  messages,
  selectedIds,
  onToggleSelect,
  onOpen,
  onToggleFlag,
  onDelete,
  onSetRead,
  onDownloadAttachment,
}: {
  messages: Message[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onToggleFlag: (id: string) => void;
  onDelete: (id: string) => void;
  onSetRead: (id: string, isRead: boolean) => void;
  onDownloadAttachment?: (m: Message, attachmentId: string, filename: string) => void;
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
        return (
          <li key={m.id} className="border-b border-line/60 last:border-0">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(m.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(m.id);
                }
              }}
              className={`group relative flex cursor-pointer items-start gap-1 py-2 pl-2 pr-4 transition sm:gap-2 ${
                checked
                  ? 'bg-brand-50 dark:bg-brand-600/15'
                  : m.isRead
                    ? 'bg-transparent hover:bg-canvas/60'
                    : 'bg-surface hover:bg-canvas/60'
              }`}
            >
              {/* Checkbox — its own click target, never opens the message */}
              <label
                onClick={(e) => e.stopPropagation()}
                className="mt-1.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelect(m.id)}
                  aria-label="Select message"
                  className="h-4 w-4 cursor-pointer accent-brand-600"
                />
              </label>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlag(m.id);
                }}
                aria-label={m.isFlagged ? 'Remove star' : 'Add star'}
                className={`mt-1.5 shrink-0 p-1 transition ${
                  m.isFlagged ? 'text-warn' : 'text-ink-faint/50 hover:text-ink-faint'
                }`}
              >
                <Icon name="star" filled={m.isFlagged} className="h-4.5 w-4.5" />
              </button>

              {/* Sender column — fixed width so subjects align, like Gmail */}
              <span
                className={`mt-1.5 hidden w-44 shrink-0 truncate text-sm sm:block ${
                  m.isRead ? 'text-ink-muted' : 'font-semibold text-ink'
                }`}
              >
                {displayName(m.from)}
              </span>

              <div className="min-w-0 flex-1">
                {/* Mobile: sender above subject */}
                <div
                  className={`truncate text-sm sm:hidden ${
                    m.isRead ? 'text-ink-muted' : 'font-semibold text-ink'
                  }`}
                >
                  {displayName(m.from)}
                </div>

                <div className="mt-1.5 truncate text-sm leading-6 sm:mt-0">
                  <span className={m.isRead ? 'text-ink-muted' : 'font-semibold text-ink'}>
                    {m.subject || '(no subject)'}
                  </span>
                  {m.snippet && (
                    <span className="text-ink-faint">
                      {' '}&mdash; {m.snippet}
                    </span>
                  )}
                </div>

                {m.attachments && m.attachments.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5 pb-0.5">
                    {m.attachments.slice(0, 3).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownloadAttachment?.(m, a.id, a.filename);
                        }}
                        title={`Download ${a.filename}`}
                        className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted transition hover:bg-canvas hover:text-ink"
                      >
                        <Icon name="attach" className="h-3.5 w-3.5 text-ink-faint" />
                        <span className="max-w-[10rem] truncate">{a.filename}</span>
                      </button>
                    ))}
                    {m.attachments.length > 3 && (
                      <span className="self-center text-xs text-ink-faint">
                        +{m.attachments.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Date — yields to quick actions on hover (pointer devices) */}
              <span
                className={`mt-1.5 shrink-0 text-xs sm:group-hover:hidden ${
                  m.isRead ? 'text-ink-faint' : 'font-semibold text-ink'
                }`}
              >
                {formatMessageDate(m.sentAt)}
              </span>
              <span className="mt-0.5 hidden shrink-0 items-center gap-0.5 sm:group-hover:flex">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(m.id);
                  }}
                  aria-label="Delete"
                  title="Delete"
                  className="rounded-full p-1.5 text-ink-muted transition hover:bg-canvas hover:text-ink"
                >
                  <Icon name="trash" className="h-4.5 w-4.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetRead(m.id, !m.isRead);
                  }}
                  aria-label={m.isRead ? 'Mark as unread' : 'Mark as read'}
                  title={m.isRead ? 'Mark as unread' : 'Mark as read'}
                  className="rounded-full p-1.5 text-ink-muted transition hover:bg-canvas hover:text-ink"
                >
                  <Icon name={m.isRead ? 'envelope' : 'envelope-open'} className="h-4.5 w-4.5" />
                </button>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
