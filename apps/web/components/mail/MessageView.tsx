'use client';

import { displayName, formatBytes, formatRecipients } from '@tatvaos/core';
import type { Attachment, Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { SafeHtml } from './SafeHtml';

/**
 * Gmail-shaped reading view: it REPLACES the list rather than sitting beside
 * it, with a toolbar of icon actions up top and the reply controls at the
 * bottom of the message where the reading finishes.
 */
export function MessageView({
  message,
  bodyLoading = false,
  onBack,
  onReply,
  onDelete,
  onToggleFlag,
  onSetUnread,
  onDownloadAttachment,
}: {
  message: Message;
  /** True while the full body is still on its way; the header renders from the summary. */
  bodyLoading?: boolean;
  onBack: () => void;
  onReply: (m: Message) => void;
  onDelete: (m: Message) => void;
  onToggleFlag: (m: Message) => void;
  onSetUnread: (m: Message) => void;
  onDownloadAttachment?: (m: Message, a: Attachment) => void;
}) {
  return (
    <article className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to list"
          title="Back"
          className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
        >
          <Icon name="back" className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(message)}
          aria-label="Delete"
          title="Delete"
          className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
        >
          <Icon name="trash" className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onSetUnread(message)}
          aria-label="Mark as unread"
          title="Mark as unread"
          className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
        >
          <Icon name="envelope" className="h-5 w-5" />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto">
        <header className="px-6 pb-2 pt-5 sm:px-14">
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-xl font-normal leading-snug text-ink sm:text-2xl">
              {message.subject || '(no subject)'}
            </h1>
            <button
              type="button"
              onClick={() => onToggleFlag(message)}
              aria-label={message.isFlagged ? 'Remove star' : 'Add star'}
              className={`mt-1 shrink-0 p-1 transition ${
                message.isFlagged ? 'text-warn' : 'text-ink-faint/60 hover:text-ink-faint'
              }`}
            >
              <Icon name="star" filled={message.isFlagged} className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="flex items-start gap-3 px-6 py-3 sm:px-14">
          <Avatar address={message.from} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-ink">{displayName(message.from)}</span>
              <span className="text-xs text-ink-muted">&lt;{message.from.email}&gt;</span>
              <time className="ml-auto shrink-0 text-xs text-ink-muted">
                {new Date(message.sentAt).toLocaleString(undefined, {
                  day: 'numeric', month: 'short', year: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                })}
              </time>
            </div>
            <div className="text-xs text-ink-muted">to {formatRecipients(message.to)}</div>
            {message.cc && message.cc.length > 0 && (
              <div className="text-xs text-ink-muted">cc {formatRecipients(message.cc)}</div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 sm:px-14">
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

        {message.attachments && message.attachments.length > 0 && (
          <div className="border-t border-line px-6 py-4 sm:px-14">
            <div className="mb-2 text-xs font-medium text-ink-muted">
              {message.attachments.length} attachment
              {message.attachments.length === 1 ? '' : 's'}
            </div>
            <ul className="flex flex-wrap gap-2">
              {message.attachments.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onDownloadAttachment?.(message, a)}
                    className="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm transition hover:bg-canvas"
                    title={`Download ${a.filename}`}
                  >
                    <Icon name="attach" className="h-4 w-4 text-ink-faint" />
                    <span className="max-w-[16rem] truncate">{a.filename}</span>
                    <span className="text-xs text-ink-muted">{formatBytes(a.sizeBytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {/* Attachments are never auto-opened, and the server serves them
                as octet-stream regardless of declared type — a text/html
                attachment rendered on our origin would be stored XSS. */}
          </div>
        )}

        {/* Reply controls live where reading ends, like Gmail */}
        <div className="flex gap-2 px-6 py-6 sm:px-14">
          <button
            type="button"
            onClick={() => onReply(message)}
            className="flex items-center gap-2 rounded-full border border-line px-5 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
          >
            <Icon name="reply" className="h-4 w-4" /> Reply
          </button>
        </div>
      </div>
    </article>
  );
}
