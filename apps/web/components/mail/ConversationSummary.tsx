'use client';

import { useEffect, useState } from 'react';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';
import { useAuth } from '@/lib/auth';
import { mailAiSummary } from '@/lib/mailAi';
import { useMailAiAvailable } from './HelpMeWrite';

// ============================================================================
//  Summarise this conversation — TatvaOS AI in Mail (Amit, 26 Sept 2026).
//
//  One button above the conversation. Read-only: it changes no mail and
//  sends none — but the conversation IS sent to TatvaOS AI to be summarised,
//  which is why it has its own switch and asks only when clicked.
//
//  The summary is text the model wrote, so it is rendered as TEXT (React
//  escapes it) with line breaks kept — never as HTML. It says it is AI and
//  to check it, because a summary that drops the one date that matters reads
//  exactly as confidently as one that keeps it.
// ============================================================================

type State =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; text: string; messages: number; partial: boolean }
  | { kind: 'error'; message: string };

export function ConversationSummary({
  message,
  mailboxId,
  count,
}: {
  message: Message;
  mailboxId?: string;
  /** Messages in the conversation, where known; a single short one is not worth a request. */
  count?: number;
}) {
  const { authedFetch } = useAuth();
  const available = useMailAiAvailable('summary');
  const [state, setState] = useState<State>({ kind: 'idle' });

  // A different conversation starts closed again.
  useEffect(() => { setState({ kind: 'idle' }); }, [message.id]);

  if (!available) return null;

  async function run() {
    setState({ kind: 'working' });
    const r = await mailAiSummary(authedFetch, message.id, mailboxId);
    if (r.summary) setState({ kind: 'done', text: r.summary, messages: r.messages ?? count ?? 1, partial: Boolean(r.partial) });
    else setState({
      kind: 'error',
      message: r.error
        ?? (r.skipped === 'short' ? 'This conversation is short enough to read — there is nothing to summarise.'
          : r.skipped === 'junk' ? 'Messages in Junk are not summarised.'
            : 'A summary is not available for this conversation.'),
    });
  }

  if (state.kind === 'idle') {
    return (
      <div className="border-b border-line px-5 py-2">
        <button
          type="button"
          onClick={() => void run()}
          title="Summarise this conversation with TatvaOS AI — the conversation is sent to TatvaOS AI; nothing is changed or sent to anyone"
          className="inline-flex items-center gap-1.5 rounded-full border border-brand-400/60 px-3 py-1 text-xs font-medium text-brand-700 transition hover:border-brand-500 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-600/15"
        >
          <Icon name="sparkle" className="h-3.5 w-3.5" />
          Summarise this conversation
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-line bg-canvas/50 px-5 py-3" role="region" aria-label="Summary of this conversation">
      <div className="mb-1.5 flex items-center gap-2">
        <Icon name="sparkle" className="h-4 w-4 text-brand-600" />
        <span className="text-sm font-medium text-ink">Summary</span>
        <span className="text-[11px] text-ink-faint">
          TatvaOS AI
          {state.kind === 'done' && ` · ${state.messages} message${state.messages === 1 ? '' : 's'}`}
          {state.kind === 'done' && state.partial && ' · from the most recent part of a long conversation'}
        </span>
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          aria-label="Close summary"
          className="ml-auto rounded p-1 text-ink-faint hover:bg-line hover:text-ink"
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      </div>
      {state.kind === 'working' && <p className="mb-0 text-xs text-ink-muted" aria-live="polite">Summarising…</p>}
      {state.kind === 'error' && <p className="mb-0 text-xs text-ink-muted">{state.message}</p>}
      {state.kind === 'done' && (
        <>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{state.text}</div>
          <p className="mb-0 mt-1.5 text-[11px] text-ink-faint">Written by TatvaOS AI. Check names, dates and numbers against the messages.</p>
        </>
      )}
    </div>
  );
}
