/**
 * Search the way the web searches: Gmail-style operators, understood by the
 * SERVER (apps/api/Modules/Mail/MailSearch.cs, PR 232, 23 Sept 2026).
 *
 * Amit, 24 Sept 2026: "search in mail … fix all the things that fixed in
 * web version yesterday". The grammar already worked from the phone — the
 * query string goes to /api/mail/search unchanged — so parity is what the
 * web puts around the box: the operator list with an example each, a form
 * that writes the query for you, and the one thing people trip on (deleted
 * and junk mail stay out unless asked).
 *
 * The operator list is copied from apps/web/lib/mailSearchTokens.ts and is
 * kept in step with MailSearch.cs. Gmail operators this product cannot answer
 * (has:drive, category:, is:important, header:) are absent on purpose:
 * offering one in a menu and then treating it as a word is how a search box
 * loses trust.
 */

export const SEARCH_OPERATORS = [
  { op: 'from:', example: 'from:priya', hint: 'sender — name or address, part of it is enough' },
  { op: 'to:', example: 'to:me', hint: 'a recipient, whole address (or me)' },
  { op: 'cc:', example: 'cc:accounts@x.com', hint: 'copied in' },
  { op: 'subject:', example: 'subject:(q3 report)', hint: 'words in the subject' },
  { op: 'has:attachment', example: 'has:attachment', hint: 'carries a file' },
  { op: 'filename:', example: 'filename:pdf', hint: 'an attached file name or type' },
  { op: 'is:unread', example: 'is:unread', hint: 'not opened yet' },
  { op: 'is:read', example: 'is:read', hint: 'already opened' },
  { op: 'is:starred', example: 'is:starred', hint: 'flagged' },
  { op: 'in:', example: 'in:trash', hint: 'inbox, sent, trash, spam, drafts — or anywhere' },
  { op: 'label:', example: 'label:accounts', hint: 'a colour category' },
  { op: 'after:', example: 'after:2026/04/01', hint: 'on or after a day' },
  { op: 'before:', example: 'before:2026/09/01', hint: 'before a day' },
  { op: 'newer_than:', example: 'newer_than:7d', hint: 'last N days, weeks, months, years' },
  { op: 'older_than:', example: 'older_than:1y', hint: 'older than that' },
  { op: 'larger:', example: 'larger:10M', hint: 'bigger than a size' },
  { op: 'smaller:', example: 'smaller:1M', hint: 'smaller than a size' },
];

/** The operator names the server knows, from the list above so they cannot drift. */
export const KNOWN_FIELDS = new Set(
  SEARCH_OPERATORS.map((o) => o.op.replace(/:.*$/, '')).concat(['rfc822msgid', 'since', 'until', 'size']),
);

/**
 * A value with a space would otherwise mean AND. The web quotes it —
 * subject:"q3 report" — but the SERVER does not parse a quoted operator
 * value (MailSearch.cs marks the whole token quoted and treats it as free
 * text, 24 Sept 2026), so that search finds nothing. The grouped form,
 * subject:(q3 report), is parsed correctly: the field applies to each word.
 * This is a deliberate difference from the web until the server is fixed.
 */
export function groupValue(v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  return /\s/.test(t) ? `(${t})` : t;
}

/**
 * The advanced form, written as one query string the way the web writes it.
 *   { from, to, subject, words, without, where, within, sizeOp, sizeVal, sizeUnit,
 *     hasAttachment, unreadOnly }
 * Free words go last so the query reads the way somebody would say it; each
 * excluded word gets its own "-", because "-a b" would only exclude a.
 */
export function buildSearchQuery(f = {}) {
  const parts = [];
  if (f.from?.trim()) parts.push(`from:${groupValue(f.from)}`);
  if (f.to?.trim()) parts.push(`to:${groupValue(f.to)}`);
  if (f.subject?.trim()) parts.push(`subject:${groupValue(f.subject)}`);
  if (f.where) parts.push(`in:${f.where}`);
  if (f.within) parts.push(`newer_than:${f.within}`);
  const size = String(f.sizeVal ?? '').trim();
  if (size && /^\d+$/.test(size)) parts.push(`${f.sizeOp === 'smaller' ? 'smaller' : 'larger'}:${size}${f.sizeUnit || 'M'}`);
  if (f.hasAttachment) parts.push('has:attachment');
  if (f.unreadOnly) parts.push('is:unread');
  if (f.words?.trim()) parts.push(f.words.trim());
  String(f.without ?? '').trim().split(/\s+/).filter(Boolean).forEach((w) => parts.push(`-${w}`));
  return parts.join(' ');
}

/**
 * Whether the query asks for Trash or Junk, which the server otherwise hides
 * from a cross-folder search. Same words the server checks (MentionsBin).
 */
export function mentionsBin(q) {
  return /(^|\s)-?in:(trash|bin|spam|junk|anywhere|all)(\s|$)/i.test(String(q ?? ''));
}

/**
 * The query split into chips, the way the web shows it: one chip per known
 * operator, a run of plain words as one chip. The client does not re-implement
 * the grammar; unknown operators are plain text, as the server treats them.
 */
export function chipsFor(query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const tokens = q.match(/-?[a-z_]+:\([^)]*\)|-?[a-z_]+:"[^"]*"|-?"[^"]*"|\S+/gi) ?? [];
  const chips = [];
  for (const raw of tokens) {
    const negated = raw.startsWith('-');
    const body = negated ? raw.slice(1) : raw;
    const m = body.match(/^([a-z_]+):(.*)$/i);
    if (m && KNOWN_FIELDS.has(m[1].toLowerCase())) {
      chips.push({ field: m[1].toLowerCase(), value: m[2].replace(/^\(|\)$/g, '').replace(/^"|"$/g, ''), negated });
      continue;
    }
    const bare = body.replace(/^"|"$/g, '');
    const last = chips[chips.length - 1];
    if (last && last.field === null && !last.negated && !negated) last.value = `${last.value} ${bare}`;
    else chips.push({ field: null, value: bare, negated });
  }
  return chips;
}

/** True when the query uses at least one operator — the chips row is drawn only then. */
export const hasOperators = (query) => chipsFor(query).some((c) => c.field !== null || c.negated);
