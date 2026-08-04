import type { Message, Thread } from '@tatvaos/types';

/** Strip Re:/Fwd: prefixes, including repeated and localised forms. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^((re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
}

/**
 * Group messages into threads.
 *
 * Deliberately subject-based for now. Real threading uses In-Reply-To and
 * References headers with subject as a fallback - that lives here too once the
 * API returns those headers, and both clients get it at once.
 */
export function groupIntoThreads(messages: Message[]): Thread[] {
  const buckets = new Map<string, Message[]>();

  for (const m of messages) {
    const key = m.threadId ?? normalizeSubject(m.subject).toLowerCase() ?? m.id;
    const existing = buckets.get(key);
    if (existing) existing.push(m);
    else buckets.set(key, [m]);
  }

  const threads: Thread[] = [];
  for (const [key, msgs] of buckets) {
    msgs.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    const first = msgs[0];
    if (!first) continue;
    const participants = new Set(msgs.map((m) => m.from.email));
    threads.push({
      id: first.threadId ?? key,
      subject: normalizeSubject(first.subject) || '(no subject)',
      messages: msgs,
      participantCount: participants.size,
    });
  }

  threads.sort((a, b) => {
    const at = a.messages[a.messages.length - 1]?.sentAt ?? '';
    const bt = b.messages[b.messages.length - 1]?.sentAt ?? '';
    return new Date(bt).getTime() - new Date(at).getTime();
  });

  return threads;
}
