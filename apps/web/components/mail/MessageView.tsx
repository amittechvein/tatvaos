'use client';

import Link from 'next/link';
import { useState } from 'react';
import { displayName, formatBytes, formatRecipients } from '@tatvaos/core';
import type { Address, Attachment, Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { SafeHtml } from './SafeHtml';

/**
 * One row of the conversation strip. Deliberately the fields a strip needs and
 * no more, so this does not go stale every time the message shape grows.
 */
export interface ThreadRow {
  id: string;
  subject: string;
  snippet: string;
  // The shared Address type, not a copy of its shape: displayName() takes
  // Address, and a duplicated `name: string | null` differs from its
  // `string | undefined` just enough to fail at the call site.
  from: Address;
  sentAt: string;
  isRead: boolean;
  /** A conversation legitimately spans Inbox and Sent — say which. */
  folderName?: string | null;
}

/** An outlined icon button, matching the template's reading-pane toolbar. */
function ToolButton({
  icon,
  label,
  onClick,
  filled,
  tone = 'default',
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onClick?: () => void;
  filled?: boolean;
  tone?: 'default' | 'danger' | 'warn';
}) {
  const toneClass =
    tone === 'danger'
      ? 'hover:text-danger'
      : tone === 'warn'
        ? 'text-warn'
        : 'text-ink-muted hover:text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface transition hover:bg-canvas ${toneClass}`}
    >
      <Icon name={icon} filled={filled} className="h-4.5 w-4.5" />
    </button>
  );
}

export function MessageView({
  message,
  bodyLoading = false,
  onBack,
  onReply,
  onDelete,
  onToggleFlag,
  onArchive,
  onMarkUnread,
  onPrint,
  onDownloadAttachment,
  onBlockSender,
  threadMessages,
  onOpenMessage,
  threadTotal,
  expanded,
  onToggleExpand,
}: {
  message: Message;
  bodyLoading?: boolean;
  onBack: () => void;
  /** Reply, reply-all, or forward — the composer opens pre-filled for each. */
  onReply: (m: Message, mode: 'reply' | 'replyAll' | 'forward') => void;
  onDelete: (m: Message) => void;
  onToggleFlag: (m: Message) => void;
  /** Junk in our folders; the template calls it Archive/Spam. */
  onArchive: (m: Message) => void;
  onMarkUnread: (m: Message) => void;
  onPrint: (m: Message) => void;
  onDownloadAttachment?: (m: Message, a: Attachment) => void;
  /**
   * Block this sender. Future mail from the address is filed to Junk at
   * ingest — never refused at SMTP, which would confirm to a spammer that the
   * address is live. Absent when the caller has nothing to wire it to.
   */
  onBlockSender?: (m: Message) => void;
  /**
   * The rest of this conversation, oldest first, INCLUDING the open message.
   *
   * Passed in rather than fetched here, because everything else in this
   * component arrives as a prop and the folder page already owns loading. Undefined
   * means "not a thread, or not loaded" — both render nothing, which is the
   * honest state while it is in flight.
   */
  threadMessages?: ThreadRow[];
  /** Opening a sibling. Absent when the caller has nowhere to route it. */
  onOpenMessage?: (id: string) => void;
  /** The untruncated count. A long thread is capped server-side; saying so is
   *  better than silently showing the first N. */
  threadTotal?: number;
  /** Full-page reading: the list is hidden and the message takes the width. */
  expanded?: boolean;
  /** Absent hides the toggle — small screens are always full-page already. */
  onToggleExpand?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface">
      {/* Toolbar — the open-message action row */}
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <ToolButton icon="back" label="Back" onClick={onBack} />
        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <ToolButton icon="junk" label="Move to Junk" onClick={() => onArchive(message)} />
        <ToolButton icon="trash" label="Delete" tone="danger" onClick={() => onDelete(message)} />
        <ToolButton icon="envelope" label="Mark as unread" onClick={() => onMarkUnread(message)} />
        <ToolButton icon="print" label="Print" onClick={() => onPrint(message)} />
        <div className="ml-auto flex items-center gap-1">
          {/* Gmail's split/full-page choice, as one toggle. */}
          {onToggleExpand && (
            <span className="hidden lg:block">
              <ToolButton
                icon={expanded ? 'collapse' : 'expand'}
                label={expanded ? 'Show the message list' : 'Read full page'}
                onClick={onToggleExpand}
              />
            </span>
          )}
          <ToolButton icon="reply" label="Reply" onClick={() => onReply(message, 'reply')} />
          <ToolButton icon="reply-all" label="Reply all" onClick={() => onReply(message, 'replyAll')} />
          <ToolButton icon="forward" label="Forward" onClick={() => onReply(message, 'forward')} />

          {/* Sender-level actions. These are deliberately behind a menu rather
              than another toolbar button: blocking someone is a decision, and a
              one-click icon next to Reply invites the mis-click. */}
          <div className="relative">
            <ToolButton icon="more" label="More" onClick={() => setMenu((v) => !v)} />
            {menu && (
              <>
                {/* Transparent click-away layer, below the menu, above the page. */}
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden="true" />
                <div
                  role="menu"
                  className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface py-1.5 text-sm shadow-raised"
                >
                  {onBlockSender && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { onBlockSender(message); setMenu(false); }}
                      className="block w-full truncate px-4 py-2 text-left text-ink hover:bg-canvas"
                    >
                      Block {message.from.email}
                    </button>
                  )}
                  <Link
                    role="menuitem"
                    href={`/mail/filters?from=${encodeURIComponent(message.from.email)}`}
                    className="block w-full px-4 py-2 text-left text-ink hover:bg-canvas"
                  >
                    Filter messages like this
                  </Link>
                  <div className="my-1 border-t border-line" />
                  <Link
                    role="menuitem"
                    href="/mail/filters"
                    className="block w-full px-4 py-2 text-left text-ink hover:bg-canvas"
                  >
                    Manage filters and blocked senders
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>


      {/* Subject first, as the title of the whole view — Gmail's order. The
          old layout spent three stacked blocks (identity header, subject,
          recipients) before any body text was visible. */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {message.subject || '(no subject)'}
        </h1>
        <ToolButton
          icon="star"
          label={message.isFlagged ? 'Unstar' : 'Star'}
          filled={message.isFlagged}
          tone={message.isFlagged ? 'warn' : 'default'}
          onClick={() => onToggleFlag(message)}
        />
      </div>

      {/* ------------------------------------------------------------------
          The conversation.

          Shown only when there is more than one message, because a strip
          saying "1 message" on every single email is noise that teaches people
          to stop reading the area.

          Collapsed by default with the open message marked. Expanding a whole
          thread inline is Gmail's model and it fights the reading pane —
          people came here to read ONE message and the rest is context.
      ------------------------------------------------------------------ */}
      {threadMessages && threadMessages.length > 1 && (
        <details className="border-b border-line bg-canvas/50 px-4 py-2">
          <summary className="cursor-pointer select-none text-xs text-ink-muted">
            {threadMessages.length} messages in this conversation
            {threadTotal && threadTotal > threadMessages.length
              ? ` — showing the most recent ${threadMessages.length} of ${threadTotal}`
              : ''}
          </summary>

          <ul className="mt-2 list-none space-y-1 p-0">
            {threadMessages.map((t) => {
              const open = t.id === message.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={open || !onOpenMessage}
                    onClick={() => onOpenMessage?.(t.id)}
                    className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                      open ? 'bg-brand-50 text-ink' : 'text-ink-muted hover:bg-surface'
                    }`}
                  >
                    <span className={`shrink-0 ${t.isRead ? '' : 'font-semibold text-ink'}`}>
                      {displayName(t.from)}
                    </span>
                    <span className="truncate">{t.snippet}</span>
                    <span className="ml-auto shrink-0 text-ink-faint">
                      {new Date(t.sentAt).toLocaleDateString(undefined,
                        { day: 'numeric', month: 'short' })}
                      {/* A thread spans folders; a reply of yours living in
                          Sent is not a mystery if the row says so. */}
                      {t.folderName ? ` · ${t.folderName}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* Sender identity — ONE dense row, Gmail-style: who, to whom, when. */}
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Avatar address={message.from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-ink">{displayName(message.from)}</span>
            <span className="hidden truncate text-xs text-ink-muted sm:inline">{message.from.email}</span>
          </div>
          <div className="truncate text-xs text-ink-muted">
            to {formatRecipients(message.to)}
            {message.cc && message.cc.length > 0 && ` · cc ${formatRecipients(message.cc)}`}
          </div>
        </div>
        <time className="shrink-0 text-xs text-ink-muted">
          {new Date(message.sentAt).toLocaleString(undefined, {
            day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
          })}
        </time>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-6 py-4">
        {/* Body */}
        <div>
          {message.bodyHtml ? (
            <SafeHtml html={message.bodyHtml} />
          ) : bodyLoading ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
              {message.bodyText ?? message.snippet}
            </pre>
          )}
        </div>

        {/* Attachments — thumbnail tiles like the template */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink">
              <Icon name="attach" className="h-4 w-4 text-ink-muted" />
              {message.attachments.length} attachment
              {message.attachments.length === 1 ? '' : 's'}
            </div>
            <div className="flex flex-wrap gap-3">
              {message.attachments.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onDownloadAttachment?.(message, a)}
                  title={`Download ${a.filename}`}
                  className="flex w-40 items-center gap-2 rounded-xl border border-line p-2.5 text-left transition hover:bg-canvas"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-600/20">
                    <Icon name="attach" className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{a.filename}</span>
                    <span className="block text-[11px] text-ink-muted">{formatBytes(a.sizeBytes)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
