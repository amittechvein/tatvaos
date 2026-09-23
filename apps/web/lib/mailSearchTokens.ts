/**
 * The search box's view of a query: its tokens.
 *
 * ── WHY THE GRAMMAR IS *NOT* DUPLICATED HERE ────────────────────────────
 *
 *  The server parses the query properly — precedence, grouping, negation,
 *  the lot (MailSearch.cs). Re-implementing that in TypeScript would create
 *  two parsers that must agree forever, and the day they disagree the chips
 *  would describe a search the server did not run. That is a worse bug than
 *  having no chips, because the screen would be lying with confidence.
 *
 *  So this does the one job the UI actually needs: split what was typed into
 *  the pieces a person can see and remove. Nothing here decides what a query
 *  MEANS.
 */

export interface SearchToken {
  /** The exact text, as typed — removing a chip removes this. */
  raw: string;
  /** Operator name, lower-cased, or null for free text. */
  field: string | null;
  value: string;
  /** Leading '-' — shown as "not". */
  negated: boolean;
}

/** Splits on whitespace but keeps "quoted phrases" whole. */
export function tokenise(query: string): SearchToken[] {
  const out: SearchToken[] = [];
  let current = '';
  let inQuotes = false;

  const flush = () => {
    const raw = current.trim();
    current = '';
    if (!raw) return;

    let rest = raw;
    const negated = rest.startsWith('-') && rest.length > 1;
    if (negated) rest = rest.slice(1);

    // A colon only makes an operator when something sits on both sides, so
    // "12:30" stays free text — the same rule the server applies.
    const colon = rest.indexOf(':');
    const quoted = rest.startsWith('"');
    if (colon > 0 && !quoted) {
      out.push({ raw, field: rest.slice(0, colon).toLowerCase(), value: rest.slice(colon + 1), negated });
    } else {
      out.push({ raw, field: null, value: rest.replace(/^"|"$/g, ''), negated });
    }
  };

  for (const ch of query) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; continue; }
    if (!inQuotes && /\s/.test(ch)) { flush(); continue; }
    current += ch;
  }
  flush();
  return out;
}

/** Everything except the token at `index`, joined back into a query. */
export function withoutToken(query: string, index: number): string {
  return tokenise(query)
    .filter((_, i) => i !== index)
    .map((t) => t.raw)
    .join(' ');
}

/**
 * The operators the SERVER understands, with an example each.
 *
 * Kept deliberately in step with MailSearch.cs. Gmail operators this product
 * cannot answer are absent on purpose — offering `has:drive` in a menu and
 * then treating it as a word is how a search box loses trust.
 */
export const SEARCH_OPERATORS: { op: string; example: string; hint: string }[] = [
  { op: 'from:', example: 'from:priya', hint: 'sender — name or address, part of it is enough' },
  { op: 'to:', example: 'to:me', hint: 'a recipient, whole address (or me)' },
  { op: 'cc:', example: 'cc:accounts@x.com', hint: 'copied in' },
  { op: 'subject:', example: 'subject:"q3 report"', hint: 'words in the subject' },
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
  { op: 'rfc822msgid:', example: 'rfc822msgid:<id@host>', hint: 'the message id, for support' },
];

/**
 * The operator names the server actually knows, taken from the list above so
 * the two cannot drift apart.
 */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set(
  SEARCH_OPERATORS.map((o) => o.op.slice(0, o.op.indexOf(':'))),
);

/** One thing the person can see and remove. May cover several tokens. */
export interface SearchChip {
  /** Operator name, or null when this is plain text. */
  field: string | null;
  value: string;
  negated: boolean;
  /** Which tokens of the query this chip stands for. */
  indices: number[];
}

/**
 * The chips for a query — which is NOT one per token.
 *
 * ── WHY RUNS OF PLAIN WORDS COLLAPSE INTO ONE CHIP ──────────────────────
 *
 *  Amit, 23 September 2026, searching for a subject line: typing
 *  "New sign-in to your account" produced FIVE chips — "contains New",
 *  "contains sign-in", "contains to", "contains your", "contains account" —
 *  three rows of them. Five chips say nothing that the words in the box did
 *  not already say, and they cost more room than the search box itself.
 *
 *  A chip exists to show that something was UNDERSTOOD AS A CONDITION.
 *  `from:priya` earns one because the box is claiming to have read an
 *  operator and could be wrong. A word is just a word: the server searches
 *  for it, the person can already see it, and there is nothing to confirm.
 *  So consecutive plain words become a single "contains ..." chip, and
 *  removing it removes all of them.
 *
 *  AN UNKNOWN OPERATOR IS PLAIN TEXT, and must look like it. `form:priya`
 *  (the typo for `from:`) used to draw a chip reading "form priya", which
 *  is the box claiming to have understood an operator that does not exist
 *  while the server searched for the literal word. The screen must not
 *  disagree with the server, so anything outside KNOWN_FIELDS is shown as
 *  text, exactly as the server treats it.
 */
export function chipsFor(query: string): SearchChip[] {
  const chips: SearchChip[] = [];

  tokenise(query).forEach((t, i) => {
    if (t.field !== null && KNOWN_FIELDS.has(t.field)) {
      chips.push({ field: t.field, value: t.value, negated: t.negated, indices: [i] });
      return;
    }

    // Plain text, or an operator the server does not know — same thing.
    const bare = (t.negated ? t.raw.slice(1) : t.raw).replace(/^"|"$/g, '');
    const last = chips[chips.length - 1];
    // A run only continues while nothing about it changes; "-holiday party"
    // is a removal and a word, not one phrase.
    if (last && last.field === null && !last.negated && !t.negated) {
      last.value = `${last.value} ${bare}`;
      last.indices.push(i);
    } else {
      chips.push({ field: null, value: bare, negated: t.negated, indices: [i] });
    }
  });

  return chips;
}

/** Everything except the tokens listed, joined back into a query. */
export function withoutTokens(query: string, indices: number[]): string {
  const drop = new Set(indices);
  return tokenise(query)
    .filter((_, i) => !drop.has(i))
    .map((t) => t.raw)
    .join(' ');
}

/** What the person is typing right now, for the suggestion list. */
export function currentFragment(query: string): string {
  const afterSpace = query.split(/\s+/).pop() ?? '';
  return afterSpace;
}

/** Replaces the fragment being typed with a chosen operator. */
export function completeWith(query: string, operator: string): string {
  const parts = query.split(/(\s+)/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/^\s*$/.test(parts[i]!)) { parts[i] = operator; break; }
  }
  const joined = parts.join('');
  // A bare operator wants a value typed next; one that is complete in itself
  // (has:attachment) wants a space so the next word is a new condition.
  return operator.endsWith(':') ? joined : `${joined} `;
}
