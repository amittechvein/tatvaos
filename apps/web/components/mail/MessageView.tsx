'use client';

import { displayName, formatBytes, formatRecipients } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { SafeHtml } from './SafeHtml';

export function MessageView({
  message,
  onBack,
  onReply,
}: {
  message: Message | null;
  onBack?: () => void;
  onReply: (m: Message) => void;
}) {
  if (!message) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-ink-faint">
        <Icon name="inbox" className="mb-3 h-12 w-12" />
        <p className="text-sm">Select a message to read</p>
      </div>
    );
  }

  return (
    <article className="scroll-thin flex h-full flex-col overflow-y-auto bg-surface">
      <header className="border-b border-line px-6 py-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-3 flex items-center gap-1 text-sm text-ink-muted hover:text-ink lg:hidden"
          >
            <Icon name="back" className="h-4 w-4" />
            Back
          </button>
        )}

        <h1 className="mb-4 text-xl font-semibold leading-snug text-ink">
          {message.subject || '(no subject)'}
        </h1>

        <div className="flex items-start gap-3">
          <Avatar address={message.from} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-ink">{displayName(message.from)}</span>
              <span className="text-sm text-ink-muted">&lt;{message.from.email}&gt;</span>
            </div>
            <div className="text-sm text-ink-muted">to {formatRecipients(message.to)}</div>
          </div>
          <time className="shrink-0 text-sm text-ink-muted">
            {new Date(message.sentAt).toLocaleString(undefined, {
              day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
            })}
          </time>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onReply(message)}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas"
          >
            <Icon name="reply" className="h-4 w-4" /> Reply
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas"
          >
            <Icon name="reply-all" className="h-4 w-4" /> Reply all
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas"
          >
            <Icon name="forward" className="h-4 w-4" /> Forward
          </button>
        </div>
      </header>

      <div className="flex-1 px-6 py-5">
        {message.bodyHtml ? (
          <SafeHtml html={message.bodyHtml} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
            {message.bodyText ?? message.snippet}
          </pre>
        )}
      </div>

      {message.attachments && message.attachments.length > 0 && (
        <footer className="border-t border-line px-6 py-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            {message.attachments.length} attachment
            {message.attachments.length === 1 ? '' : 's'}
          </div>
          <ul className="flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm"
              >
                <Icon name="attach" className="h-4 w-4 text-ink-faint" />
                <span className="max-w-[16rem] truncate">{a.filename}</span>
                <span className="text-xs text-ink-muted">{formatBytes(a.sizeBytes)}</span>
              </li>
            ))}
          </ul>
          {/* Attachments are never auto-opened. Blocked extensions are refused
              server-side; the client must not be the only check. */}
        </footer>
      )}
    </article>
  );
}
