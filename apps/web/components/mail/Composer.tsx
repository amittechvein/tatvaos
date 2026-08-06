'use client';

import { useState } from 'react';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';

/** Comma- or semicolon-separated addresses → a clean list. */
function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function Composer({
  replyTo,
  fromAddress,
  onClose,
  onSend,
}: {
  replyTo?: Message | null;
  fromAddress: string;
  onClose: () => void;
  onSend: (draft: { to: string[]; cc?: string[]; subject: string; bodyText: string }) => Promise<unknown>;
}) {
  const [to, setTo] = useState(replyTo ? replyTo.from.email : '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(
    replyTo ? (replyTo.subject.match(/^re:/i) ? replyTo.subject : `Re: ${replyTo.subject}`) : '',
  );
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      await onSend({
        to: splitAddresses(to),
        cc: showCc ? splitAddresses(cc) : undefined,
        subject,
        bodyText: body,
      });
      onClose();
    } catch (err) {
      // The server's words, verbatim — most usefully the outbound gate's
      // "verify your domain first", which the sender can actually act on.
      setError(err instanceof Error ? err.message : 'The message could not be sent.');
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 p-0 sm:items-center sm:p-6">
      <div className="flex h-full w-full flex-col rounded-none bg-surface shadow-2xl sm:h-auto sm:max-h-[85vh] sm:max-w-2xl sm:rounded-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{replyTo ? 'Reply' : 'New message'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-faint hover:bg-canvas hover:text-ink"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <span className="w-14 shrink-0 text-sm text-ink-muted">From</span>
            <span className="truncate text-sm text-ink">{fromAddress}</span>
          </div>

          <label className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <span className="w-14 shrink-0 text-sm text-ink-muted">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@example.com — commas for several"
              className="w-full border-0 p-0 text-sm outline-none placeholder:text-ink-faint"
            />
            {!showCc && (
              <button
                type="button"
                onClick={() => setShowCc(true)}
                className="shrink-0 text-xs font-medium text-ink-muted hover:text-ink"
              >
                Cc
              </button>
            )}
          </label>

          {showCc && (
            <label className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <span className="w-14 shrink-0 text-sm text-ink-muted">Cc</span>
              <input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="name@example.com"
                className="w-full border-0 p-0 text-sm outline-none placeholder:text-ink-faint"
              />
            </label>
          )}

          <label className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <span className="w-14 shrink-0 text-sm text-ink-muted">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full border-0 p-0 text-sm outline-none placeholder:text-ink-faint"
            />
          </label>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message"
            rows={14}
            className="w-full resize-none border-0 px-4 py-3 text-sm outline-none placeholder:text-ink-faint"
          />
        </div>

        {error && (
          <div className="border-t border-line bg-danger/5 px-4 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        <footer className="flex items-center gap-3 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !to.trim()}
            className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          <span className="ml-auto text-xs text-ink-faint">
            Attachments arrive in the next update
          </span>
        </footer>
      </div>
    </div>
  );
}
