// ============================================================================
//  TatvaOS AI in Mail — the client half of Help me write.
//
//  Kept apart from lib/mail.ts because what is sent matters more here than
//  anywhere else in the mail client: the ONLY text that leaves is what these
//  helpers extract — the words the person typed, never the quoted message
//  under a reply and never the signature. The server takes nothing else
//  (MailAiEndpoints), so this file is where "it only sees the text you
//  typed" is either true or not.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type RewriteStyle =
  | 'polish' | 'formal' | 'friendly' | 'soft' | 'confident' | 'apologetic'
  | 'shorter' | 'longer'
  | 'grammar' | 'simple' | 'bullets';

/**
 * The words the menu shows, in the rows it shows them. The API holds what each
 * one means (MailAiEndpoints.Styles) — the browser only ever sends the key.
 * Grouped because eleven chips in one wrap read as a wall (Amit, 25 Sept:
 * "add some more button like soft tone").
 */
export const REWRITE_GROUPS: { title: string; styles: { style: RewriteStyle; label: string }[] }[] = [
  {
    title: 'Tone',
    styles: [
      { style: 'polish', label: 'Polish' },
      { style: 'formal', label: 'More formal' },
      { style: 'friendly', label: 'Friendlier' },
      { style: 'soft', label: 'Softer tone' },
      { style: 'confident', label: 'More confident' },
      { style: 'apologetic', label: 'Apologetic' },
    ],
  },
  {
    title: 'Length',
    styles: [
      { style: 'shorter', label: 'Shorter' },
      { style: 'longer', label: 'More detailed' },
    ],
  },
  {
    title: 'Clarity',
    styles: [
      { style: 'grammar', label: 'Fix spelling and grammar' },
      { style: 'simple', label: 'Simpler words' },
      { style: 'bullets', label: 'As bullet points' },
    ],
  },
];

export const REWRITE_STYLES = REWRITE_GROUPS.flatMap((g) => g.styles);

export interface MailAiStatus {
  available: boolean;
  /** Why not: 'platform' (no AI key), 'organisation' (no consent), 'mail' (Mail AI off). */
  reason?: 'platform' | 'organisation' | 'mail';
  maxCharacters?: number;
}

/**
 * Asked once per page, not once per composer: several composers can be open,
 * and the answer only changes when an administrator flips a switch. A failed
 * check is not cached, so the next composer asks again.
 */
let statusOnce: Promise<MailAiStatus> | null = null;

export function mailAiStatus(f: AuthedFetch): Promise<MailAiStatus> {
  if (!statusOnce) {
    statusOnce = f('/mail/ai/status')
      .then((r) => (r.ok ? (r.json() as Promise<MailAiStatus>) : { available: false }))
      .catch(() => ({ available: false }));
    void statusOnce.then((s) => { if (!s.available && !s.reason) statusOnce = null; });
  }
  return statusOnce;
}

/** One rewrite. Resolves to the new text, or rejects with a sentence to show. */
export async function mailAiRewrite(f: AuthedFetch, text: string, style: RewriteStyle): Promise<string> {
  const r = await f('/mail/ai/rewrite', { method: 'POST', body: JSON.stringify({ text, style }) });
  const body = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!r.ok || body.error || typeof body.text !== 'string') {
    throw new Error(body.error ?? 'TatvaOS AI could not rewrite this draft just now.');
  }
  return body.text;
}

// ── Suggested replies (step 2) ──────────────────────────────────────────────

export interface MailSuggestions {
  suggestions: string[];
  /** The message was longer than what was sent; the chips say "from the start of a long message". */
  partial?: boolean;
  /** Not eligible, or Mail AI off — nothing was sent. */
  skipped?: string;
  error?: string;
}

/**
 * Three short replies to one message. The SERVER reads the message (from the
 * mailbox this person may read) — the browser sends only its id, so it cannot
 * be used to push other text to the provider. Never throws: a failure is no
 * chips, because suggestions are an offer, not something anyone asked for.
 */
export async function mailAiSuggest(f: AuthedFetch, messageId: string, mailboxId?: string): Promise<MailSuggestions> {
  const q = mailboxId ? `?mailboxId=${encodeURIComponent(mailboxId)}` : '';
  try {
    const r = await f(`/mail/ai/messages/${messageId}/suggestions${q}`, { method: 'POST' });
    if (!r.ok) return { suggestions: [] };
    const b = (await r.json()) as MailSuggestions;
    return { ...b, suggestions: Array.isArray(b.suggestions) ? b.suggestions.filter((x) => typeof x === 'string') : [] };
  } catch {
    return { suggestions: [] };
  }
}

// ── What the person typed ───────────────────────────────────────────────────

/** The composer's markers for the blocks that are not the person's own words. */
const NOT_TYPED = '[data-tatva-signature],[data-tv-quote]';

/**
 * The stretch of the rich editor the person typed, as a Range: from the start
 * of the editor to just before the signature or the quoted message —
 * whichever comes first in the document, AT ANY DEPTH — pulled back over the
 * blank lines that separate the two, so a rewrite lands where the words were
 * and the gap above the signature survives.
 *
 * AT ANY DEPTH, and that is the whole point. The composer seeds the
 * signature and the quote as direct children of the editor, but the first
 * version of this assumed they STAYED there, and they do not: press Enter
 * after the first line and Chrome wraps the second line AND everything after
 * it in a new <div> — measured 25 Sept 2026 with real key presses:
 * `line one<div>line two<br><br><div data-tatva-signature>…`. A walk over
 * top-level nodes stopped at that <div>, so "line two" was silently left out
 * of the rewrite. querySelector finds the first marker in document order
 * wherever the browser has moved it.
 */
export function typedRange(editor: HTMLElement): Range {
  const range = document.createRange();
  range.setStart(editor, 0);
  const marker = editor.querySelector(NOT_TYPED);
  if (marker) range.setEndBefore(marker);
  else range.setEnd(editor, editor.childNodes.length);

  // Pull the end back over blank lines. Stops at the first node with words
  // in it; climbs out of a wrapper it has emptied from the end.
  for (;;) {
    const c = range.endContainer;
    const before = range.endOffset > 0 ? c.childNodes[range.endOffset - 1] : undefined;
    if (before && isBlank(before)) { range.setEndBefore(before); continue; }
    if (!before && c !== editor && editor.contains(c)) { range.setEndBefore(c); continue; }
    break;
  }
  return range;
}

/** The typed stretch as plain text, with the line breaks a reader would see. */
export function typedText(editor: HTMLElement): string {
  return nodesToText(Array.from(typedRange(editor).cloneContents().childNodes));
}

function isBlank(n: Node): boolean {
  if (n.nodeName === 'BR') return true;
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').trim() === '';
  if (n.nodeType === Node.ELEMENT_NODE) {
    const el = n as Element;
    return (el.textContent ?? '').trim() === '' && !el.querySelector('img');
  }
  return true;
}

const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR']);

/**
 * Those nodes as plain text with the line breaks a reader would see.
 * Not innerText: that needs the nodes laid out, and these are read in place
 * where a folded quote or hidden element would change the answer.
 */
export function nodesToText(nodes: Node[]): string {
  let out = '';
  const nl = () => { if (out.length > 0 && !out.endsWith('\n')) out += '\n'; };
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += (n.textContent ?? '').replace(/ /g, ' '); return; }
    if (n.nodeName === 'BR') { out += '\n'; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const block = BLOCK.has(n.nodeName);
    if (block) nl();
    if (n.nodeName === 'LI') out += n.parentElement?.nodeName === 'OL'
      ? `${Array.from(n.parentElement.children).indexOf(n as Element) + 1}. ` : '- ';
    n.childNodes.forEach(walk);
    if (block) nl();
  };
  nodes.forEach(walk);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The model's answer as editor HTML. ESCAPED, always: the answer is text the
 * model wrote, and a model can be talked into writing markup. Line breaks are
 * the only structure kept.
 */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * The plain-text editor's version: the typed part is everything before the
 * signature or the quote, whichever starts first. Returns where it ends so
 * the rewrite can be spliced back in front of the same tail.
 */
export function splitPlainDraft(body: string, markers: string[]): { typed: string; tail: string } {
  let cut = body.length;
  for (const m of markers) {
    if (!m) continue;
    const at = body.indexOf(m);
    if (at >= 0 && at < cut) cut = at;
  }
  const head = body.slice(0, cut);
  const typed = head.trimEnd();
  return { typed, tail: body.slice(typed.length) };
}
