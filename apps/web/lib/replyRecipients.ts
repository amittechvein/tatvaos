//
// Who a reply goes to.
//
// ─────────────────────────────────────────────────────────────────────────
//  WHY THIS IS ITS OWN FILE. A client of ShippingXpress, 28 September 2026,
//  sent a reminder on a message he had written himself. The composer put the
//  ORIGINAL SENDER in To, as it does for every reply — and the original
//  sender was him. The reminder went "to vipin · cc" the three people it was
//  meant for, a copy came back to his own Inbox, and the conversation then
//  showed the same mail twice. He reported it as two mails being sent.
//
//  Answering your own message means "say more to the people I wrote to",
//  which is what Gmail does and what the phone already did
//  (apps/mobile/lib/mail.js replyAllRecipients). The web did not.
//
//  Pure, and free of React, so tests/mail-reply-recipients can run it.
// ─────────────────────────────────────────────────────────────────────────
//

export interface ReplyParty { email: string }

export interface ReplyOriginal {
  from: ReplyParty;
  to?: ReplyParty[] | null;
  cc?: ReplyParty[] | null;
}

export type ReplyKind = 'reply' | 'replyAll' | 'forward' | 'new';

export interface ReplyRecipients { to: string; cc: string }

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

/** Addresses in order, nobody twice, none of `skip`. Case-blind; first spelling kept. */
function pick(list: (ReplyParty[] | null | undefined)[], skip: Set<string>): string[] {
  const seen = new Set(skip);
  const out: string[] = [];
  for (const group of list) {
    for (const a of group ?? []) {
      const key = norm(a?.email);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a.email.trim());
    }
  }
  return out;
}

/**
 * @param self The address the reply goes out FROM — a shared mailbox's own
 *             address when one is open, so the queue does not write to itself.
 */
export function replyRecipients(
  original: ReplyOriginal | null | undefined,
  kind: ReplyKind,
  self: string,
): ReplyRecipients {
  if (!original || kind === 'forward' || kind === 'new') return { to: '', cc: '' };

  const me = norm(self);
  const sender = norm(original.from?.email);
  const mine = me.length > 0 && sender === me;

  if (!mine) {
    // Somebody else's message: answer them; reply-all copies everyone else
    // who was on it, never me and never the sender a second time.
    const to = original.from.email;
    const cc = kind === 'replyAll'
      ? pick([original.to, original.cc], new Set([me, sender].filter(Boolean)))
      : [];
    return { to, cc: cc.join(', ') };
  }

  // MY OWN message. The people it went to, not me.
  const skipMe = new Set([me]);
  const to = pick([original.to], skipMe);
  const cc = kind === 'replyAll' ? pick([original.cc], new Set([me, ...to.map(norm)])) : [];

  // It was addressed only to me, with the real audience on Cc — the shape the
  // report was in. Reply all: they move up to To, so the next one is not
  // "to vipin" again. Plain Reply: it was a note to myself, and stays one.
  if (to.length === 0) {
    if (kind === 'replyAll' && cc.length > 0) return { to: cc.join(', '), cc: '' };
    return { to: original.from.email, cc: '' };
  }
  return { to: to.join(', '), cc: cc.join(', ') };
}
