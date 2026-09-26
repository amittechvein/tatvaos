'use client';

import { useEffect, useState } from 'react';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';
import { useAuth } from '@/lib/auth';
import { mailAiSuggest } from '@/lib/mailAi';
import { useMailAiAvailable } from './HelpMeWrite';

// ============================================================================
//  Suggested replies — TatvaOS AI in Mail, step 2 of 3 (Amit, 25 Sept 2026).
//
//  Three short replies under an open message. Click one and a reply opens
//  with it already typed, for the person to edit and send — nothing is ever
//  sent on their behalf.
//
//  WHEN IT ASKS. Only when the organisation has Mail AI on (the button in the
//  composer uses the same answer), only for the message on screen, and only
//  after it has STAYED on screen for a moment: arrowing down a list of forty
//  messages must not send forty of them to the provider, nor spend forty of
//  the person's hourly AI allowance. The server skips Sent/Drafts/Junk/Trash,
//  mail you sent, and automated senders without asking the model, and
//  remembers an answer for six hours so reopening costs nothing.
//
//  WHAT IT SHOWS. Chips or nothing. A refusal (limit reached, provider down)
//  is silent here: nobody asked for suggestions, so an error about them is
//  noise. Help me write, which somebody DID ask for, says the sentence.
// ============================================================================

/** How long a message must stay open before its text is sent for suggestions. */
const SETTLE_MS = 1200;

export function SuggestedReplies({
  message,
  mailboxId,
  onPick,
}: {
  message: Message;
  mailboxId?: string;
  onPick: (text: string) => void;
}) {
  const { authedFetch } = useAuth();
  const available = useMailAiAvailable('suggest');
  const [state, setState] = useState<{ id: string; list: string[]; partial: boolean } | null>(null);

  useEffect(() => {
    setState(null);
    if (!available) return;
    let live = true;
    const t = window.setTimeout(() => {
      void mailAiSuggest(authedFetch, message.id, mailboxId).then((r) => {
        if (live) setState({ id: message.id, list: r.suggestions, partial: Boolean(r.partial) });
      });
    }, SETTLE_MS);
    return () => { live = false; window.clearTimeout(t); };
  }, [available, authedFetch, message.id, mailboxId]);

  if (!state || state.id !== message.id || state.list.length === 0) return null;

  return (
    <div className="mt-2" role="group" aria-label="Suggested replies">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <Icon name="sparkle" className="h-3.5 w-3.5 text-brand-600" />
        <span>Suggested replies · TatvaOS AI{state.partial ? ' · from the start of a long message' : ''}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {state.list.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            title="Start a reply with this — you can edit it before sending"
            className="rounded-full border border-brand-400/60 bg-surface px-3.5 py-1.5 text-left text-sm text-brand-700 transition hover:border-brand-500 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-600/15"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
