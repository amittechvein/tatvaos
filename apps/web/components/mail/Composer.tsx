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

/**
 * Gmail-shaped composer: a card docked to the bottom-right on desktop — mail
 * keeps being readable behind it — and full-screen on phones.
 */
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
    <div className="fixed inset-0 z-50 sm:inset-auto sm:bottom-0 sm:right-8">
      <div className="flex h-full w-full flex-col bg-surface shadow-raised sm:h-auto sm:max-h-[80vh] sm:w-[540px] sm:rounded-t-xl sm:border sm:border-b-0 sm:border-line">
        <header className="flex items-center justify-between rounded-t-none bg-rail px-4 py-2.5 sm:rounded-t-xl">
          <h2 className="text-sm font-medium text-white">
            {replyTo ? 'Reply' : 'New message'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-rail-text hover:text-white"
          >
            <Icon name="close" className="h-4.5 w-4.5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
            <span className="shrink-0 text-ink-muted">From</span>
            <span className="truncate text-ink">{fromAddress}</span>
          </div>

          <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
            <span className="shrink-0 text-ink-muted">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Recipients — commas for several"
              className="w-full border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
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
            <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
              <span className="shrink-0 text-ink-muted">Cc</span>
              <input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="name@example.com"
                className="w-full border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
              />
            </label>
          )}

          <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </label>

          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message"
            rows={12}
            className="w-full resize-none border-0 bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-faint"
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
            className="rounded-full bg-brand-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
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
