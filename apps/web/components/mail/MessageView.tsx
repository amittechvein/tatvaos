'use client';

import { displayName, formatBytes, formatRecipients } from '@tatvaos/core';
import type { Attachment, Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { SafeHtml } from './SafeHtml';

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
}) {
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
          <ToolButton icon="reply" label="Reply" onClick={() => onReply(message, 'reply')} />
          <ToolButton icon="reply-all" label="Reply all" onClick={() => onReply(message, 'replyAll')} />
          <ToolButton icon="forward" label="Forward" onClick={() => onReply(message, 'forward')} />
        </div>
      </div>

      {/* Sender identity */}
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Avatar address={message.from} size={40} />
        <div className="min-w-0 flex-1">
          <h6 className="truncate text-sm font-semibold text-ink">{displayName(message.from)}</h6>
          <span className="truncate text-xs text-ink-muted">{message.from.email}</span>
        </div>
        <ToolButton
          icon="star"
          label={message.isFlagged ? 'Unstar' : 'Star'}
          filled={message.isFlagged}
          tone={message.isFlagged ? 'warn' : 'default'}
          onClick={() => onToggleFlag(message)}
        />
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto p-6">
        {/* Subject + date */}
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <h1 className="min-w-0 text-lg font-medium text-ink">
            {message.subject || '(no subject)'}
          </h1>
          <time className="shrink-0 text-xs text-ink-muted">
            {new Date(message.sentAt).toLocaleString(undefined, {
              day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </time>
        </div>

        <div className="mb-1 text-xs text-ink-muted">to {formatRecipients(message.to)}</div>
        {message.cc && message.cc.length > 0 && (
          <div className="mb-3 text-xs text-ink-muted">cc {formatRecipients(message.cc)}</div>
        )}

        {/* Body */}
        <div className="mt-4">
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
