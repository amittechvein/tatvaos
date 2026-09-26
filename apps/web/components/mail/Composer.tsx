'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';
import { ContactPicker } from '@/components/family/ContactPicker';
import { useAuth } from '@/lib/auth';
import { mailApi } from '@/lib/mail';
import { linkApi } from '@/lib/space';
import { fetchMyStorage } from '@/lib/myStorage';
import { cleanPastedHtml } from '@/lib/pasteHtml';
import { cleanSignatureHtml } from '@/lib/signatureHtml';
import { splitPlainDraft, textToHtml, typedRange, typedText } from '@/lib/mailAi';
import { HelpMeWriteButton, HelpMeWritePanel, useMailAiAvailable } from './HelpMeWrite';
import { cleanComposeHtml, formatHtmlSource } from '@/lib/composeHtml';
import { PictureRefused, pictureTag, pictureToDataUrl } from '@/lib/composeImage';
import { FormatBar } from './FormatBar';
import { HtmlSourceEditor } from './HtmlSourceEditor';

/** Comma- or semicolon-separated addresses → a clean list. */
function splitAddresses(raw: string): string[] {
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

const MAX_TOTAL = 26_214_400; // 25 MB, matches the server gate

/**
 * How long a mailed link lives.
 *
 * Stated EXPLICITLY rather than letting Space apply its own default, because
 * the message body tells the recipient a date. If Space changed its default
 * tomorrow, every promise already sitting in somebody's inbox would quietly
 * become wrong, and nobody would find out until a link died early.
 *
 * Thirty days is chosen for mail specifically: people open attachments late,
 * and a link that expires before the recipient gets to it is the same failure
 * as never sending one.
 */
const LINK_EXPIRY_DAYS = 30;

/** A file parked in Space, and the link that will go in the message. */
interface SpaceLink {
  fileId: string;
  /** What SPACE stored, not the local filename. They differ often enough. */
  name: string;
  sizeBytes: number;
  url: string;
  expiresAt: string;
}

/** An oversize file waiting on "send it as a link instead?". */
interface ParkOffer {
  file: File;
  /** Their free storage, or null when it could not be read. */
  free: number | null;
}

/**
 * Escaped for the HTML half. The names come from a server; escape anyway.
 * Also the escape for everything quoteHtml takes from a received message,
 * which is where the single quote was added (24 Sept): an attribute is one
 * careless edit away, and ' is the character that closes one.
 */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The date the FIRST of these links dies.
 *
 * The earliest, not the latest: one sentence covering several links has to be
 * true of all of them, and "expires on the 30th" beside a link that died on
 * the 12th is worse than no sentence at all.
 */
function expiryLine(links: SpaceLink[]): string {
  const first = links
    .map((l) => new Date(l.expiresAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  if (first === undefined) return '';
  const when = new Date(first).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return links.length === 1
    ? `This link stops working on ${when}.`
    : `These links stop working on ${when}.`;
}

/**
 * The links, as the plain-text half of the message.
 *
 * BOTH HALVES GET THEM, and that is not tidiness. Outgoing mail is
 * multipart/alternative; a link present in only one part means whichever
 * recipients read the other part see a message that mentions an attachment
 * and does not have one - which is exactly the bug the signature had.
 */
function linkBlockText(links: SpaceLink[]): string {
  if (links.length === 0) return '';
  const head = links.length === 1
    ? 'Attached file, shared as a link:'
    : 'Attached files, shared as links:';
  const rows = links
    .map((l) => `${l.name} (${formatBytes(l.sizeBytes)})\n${l.url}`)
    .join('\n\n');
  return `\n\n${head}\n\n${rows}\n\n${expiryLine(links)}`;
}

/** The same block, as the HTML half. */
function linkBlockHtml(links: SpaceLink[]): string {
  if (links.length === 0) return '';
  const head = links.length === 1
    ? 'Attached file, shared as a link:'
    : 'Attached files, shared as links:';
  const rows = links
    .map((l) =>
      `<li><a href="${esc(l.url)}">${esc(l.name)}</a> ` +
      `<span style="color:#6b7280">(${esc(formatBytes(l.sizeBytes))})</span></li>`)
    .join('');
  return `<br><p>${esc(head)}</p><ul>${rows}</ul><p>${esc(expiryLine(links))}</p>`;
}

/**
 * Chrome, moving text into a new block (alignment, lists, indent), copies the
 * EDITOR'S OWN size onto every run it moves: `font-size: 0.875rem`, the
 * Tailwind text-sm the editor is styled with. Measured 25 Sept 2026 — centring
 * one line wrapped both of its words that way. It is not a size anybody
 * chose, and Outlook desktop ignores rem, so in Outlook those runs fell back
 * to a different size from the text around them. Sizes equal to the editor's
 * base are removed. Small, Large and Huge (12, 18, 28px) never equal it; the
 * size menu's Normal does, and removing it is right — Normal means the default.
 * Spans are left in place, emptied — unwrapping them would move the text nodes
 * the selection is anchored in, and the next command would apply to nothing.
 */
function tidyEditorFontSizes(el: HTMLElement | null) {
  if (!el) return;
  const base = new Set(['0.875rem', getComputedStyle(el).fontSize]);
  el.querySelectorAll<HTMLElement>('[style]').forEach((n) => {
    if (base.has(n.style.fontSize)) n.style.removeProperty('font-size');
    if (!n.getAttribute('style')?.trim()) n.removeAttribute('style');
  });
}

/** Commands applied as inline styles (styleWithCSS on). See cmd(). */
const CSS_COMMANDS = new Set([
  'foreColor', 'hiliteColor', 'backColor', 'fontName',
  'indent', 'outdent', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull',
]);

const EMOJI = ['😀', '😊', '👍', '🙏', '🎉', '✅', '❤️', '🔥', '😅', '🤝', '📎', '📅', '💡', '⚠️', '🚀', '👀'];

/**
 * The composer.
 *
 * A contenteditable surface produces the HTML body; a plain-text toggle sends
 * innerText instead. Formatting is applied with document.execCommand — long
 * deprecated on paper, still the only thing every current browser implements
 * for rich-text editing, and correct for a mail body where the output is HTML
 * a receiver renders rather than a document model we persist.
 *
 * The action buttons that have no backend yet (Drive, schedule, confidential,
 * read receipt, label, templates) are shown DISABLED with a reason in the
 * tooltip rather than omitted — so the surface reads as "these are coming"
 * instead of "this client is missing things", and nothing pretends to work.
 */
export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

/**
 * Where the composer sits.
 *
 * `docked` is the resting state: a panel in the bottom-right corner with no
 * backdrop, so the mailbox behind stays readable and clickable while you write
 * — which is the whole point of composing in place rather than on a page of its
 * own. `full` centres it as a large modal, dimming the background, for when the
 * message is the task. `min` collapses it to its own title bar so a half-written
 * draft can be parked; the component stays mounted, so nothing typed is lost.
 */
type PaneState = 'docked' | 'full' | 'min';

/** Marks the seeded signature block so a mailbox switch can replace it. */
const SIG_ATTR = 'data-tatva-signature';

/**
 * The signature, as the mail bootstrap returns it.
 *
 * Declared here rather than imported from lib/mail so the composer keeps no
 * dependency on the mail client module — anything with these four fields
 * satisfies it, which is all this component needs to know.
 */
/** What autosave hands back to the page, which owns the draft id. */
export interface DraftFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export interface ComposerSignature {
  bodyHtml: string;
  bodyText: string;
  enabled: boolean;
  /** Separate from `enabled` — most people don't want it on every reply. */
  includeOnReply: boolean;
}

/** Recipients of the original, minus the current mailbox, for reply-all. */
function replyAllCc(original: Message | null | undefined, self: string): string {
  if (!original) return '';
  const others = [...(original.to ?? []), ...(original.cc ?? [])]
    .map((a) => a.email)
    .filter((e) => e && e.toLowerCase() !== self.toLowerCase() && e.toLowerCase() !== original.from.email.toLowerCase());
  return [...new Set(others)].join(', ');
}

// ── THE QUOTED ORIGINAL ──────────────────────────────────────────────────
//
//  Two faults, found together on 24 September 2026.
//
//  1. REPLIES CARRIED NO QUOTE AT ALL. Only a forward did. Amit's reply to a
//     courier went out as the single word "ok" and a signature: to a human
//     it said nothing about what it answered, and Gmail filed it as spam —
//     "similar to messages that were identified as spam in the past" — a
//     bare one-word reply from a young domain being exactly the shape of a
//     bot. The phone app always quoted replies; only the web did not.
//
//  2. THE QUOTE THAT DID EXIST WAS A SCRIPT HOLE. It put the original's
//     bodyHtml into the editor raw, and the sender's display name unescaped,
//     through innerHTML. bodyHtml is the one field the shared type says in
//     so many words must never be rendered raw. Measured on a local stack: a
//     message whose HTML set a flag on window left it unset while being READ
//     (SafeHtml's sandbox holds) and set it the moment Forward was pressed —
//     the body's script and the name's script both. Forward was live on
//     production. Widening the quote to every reply without this fix would
//     have put that behind the most-pressed button in the app.
//
//  So everything below that came from the message is either cleaned by the
//  same sanitiser paste uses, or escaped as text. Nothing is interpolated raw.
//
//  The markup is Gmail's own: class="gmail_quote" around the history and
//  "gmail_attr" on the "On … wrote:" line. Gmail — and several others that
//  copied it — recognise that and fold it behind "…" on the RECIPIENT's
//  side, so a TatvaOS reply reads there exactly like a native one.
//  data-tv-quote marks the block as ours, so switching reply ↔ forward can
//  find it and swap it without touching anything the person typed.
// ─────────────────────────────────────────────────────────────────────────

/** "Name <email>", escaped. Both halves are chosen by whoever sent the mail. */
function who(a: { name?: string | null; email: string }): string {
  return a.name ? `${esc(a.name)} &lt;${esc(a.email)}&gt;` : esc(a.email);
}

/** The original's body, safe to put into our own editor. */
function quotedBody(m: Message): string {
  if (m.bodyHtml) {
    const clean = cleanPastedHtml(m.bodyHtml);
    if (clean) return clean;
  }
  return esc(m.bodyText ?? m.snippet ?? '').replace(/\r?\n/g, '<br>');
}

type QuoteKind = 'reply' | 'forward';
const quoteKind = (mode: ComposeMode): QuoteKind => (mode === 'forward' ? 'forward' : 'reply');

/** The quoted original as HTML — a reply's "On … wrote:" or a forward's header. */
function quoteHtml(m: Message, mode: ComposeMode): string {
  const when = esc(new Date(m.sentAt).toLocaleString());
  if (quoteKind(mode) === 'forward') {
    const head = [
      '---------- Forwarded message ---------',
      `From: ${who(m.from)}`,
      `Date: ${when}`,
      `Subject: ${esc(m.subject || '(no subject)')}`,
      `To: ${(m.to ?? []).map(who).join(', ')}`,
      ...(m.cc && m.cc.length > 0 ? [`Cc: ${m.cc.map(who).join(', ')}`] : []),
    ].join('<br>');
    return `<div class="gmail_quote" data-tv-quote="forward">`
      + `<div class="gmail_attr">${head}<br></div><br>${quotedBody(m)}</div>`;
  }
  return `<div class="gmail_quote" data-tv-quote="reply">`
    + `<div class="gmail_attr">On ${when}, ${who(m.from)} wrote:<br></div>`
    + `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">`
    + `${quotedBody(m)}</blockquote></div>`;
}

/** The same, for the plain-text editor. Plain text cannot run anything. */
function quoteText(m: Message, mode: ComposeMode): string {
  const when = new Date(m.sentAt).toLocaleString();
  const name = (a: { name?: string | null; email: string }) =>
    (a.name ? `${a.name} <${a.email}>` : a.email);
  const body = (m.bodyText ?? m.snippet ?? '').replace(/\r\n/g, '\n');
  if (quoteKind(mode) === 'forward') {
    return [
      '---------- Forwarded message ---------',
      `From: ${name(m.from)}`,
      `Date: ${when}`,
      `Subject: ${m.subject || '(no subject)'}`,
      `To: ${(m.to ?? []).map(name).join(', ')}`,
      '',
      body,
    ].join('\n');
  }
  return `On ${when}, ${name(m.from)} wrote:\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

/**
 * The editor's text, WITH a folded quote in it.
 *
 * innerText follows CSS, and a folded reply quote is display:none — so
 * reading the editor while the quote was folded left it out of the
 * text/plain half of the message. Found on the wire, not in the browser
 * (24 Sept): the HTML part carried the quote and the plain part did not,
 * so any helpdesk that reads plain text — many do — got the bare one-word
 * reply this change exists to stop sending. Unfolded for the length of one
 * synchronous read and put back; nothing repaints in between.
 */
function editorText(el: HTMLElement | null): string {
  if (!el) return '';
  const folded = !el.hasAttribute('data-quote-open');
  if (folded) el.setAttribute('data-quote-open', '');
  try {
    return el.innerText;
  } finally {
    if (folded) el.removeAttribute('data-quote-open');
  }
}

/** The subject a reply or forward starts with, before anyone edits it. */
function autoSubject(m: Message | null | undefined, mode: ComposeMode): string {
  if (!m) return '';
  const base = m.subject;
  if (mode === 'forward') return /^fwd:/i.test(base) ? base : `Fwd: ${base}`;
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

export function Composer({
  replyTo,
  mode = 'new',
  selfAddress = '',
  fromAddress,
  signature,
  onSaveDraft,
  onClose,
  onSend,
  offset = 0,
  right,
  minimised: minimisedProp,
  onMinimisedChange,
  placement = 'docked',
  initialText,
}: {
  replyTo?: Message | null;
  mode?: ComposeMode;
  /** The current mailbox address, so reply-all does not Cc yourself. */
  selfAddress?: string;
  fromAddress: string;
  /** Seeded into an empty body when the composer opens. */
  signature?: ComposerSignature | null;
  /**
   * Autosave. Debounced while typing and flushed on minimise. The page owns the
   * draft id this produces and threads it through later saves, so a long
   * message updates one row instead of filling Drafts with one per keystroke.
   */
  onSaveDraft?: (fields: DraftFields) => void;
  onClose: () => void;
  onSend: (draft: {
    to: string[];
    cc?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    files?: File[];
  }) => Promise<unknown>;
  /**
   * Which docked slot this window occupies, 0 = rightmost. Several composers
   * can be open at once; each sits one slot further left, Gmail-style. Full
   * screen ignores it — only one thing can be the task.
   */
  offset?: number;
  /**
   * Distance from the right edge in px, worked out by the page from the real
   * widths of the windows beside this one. Without it the old fixed 580px
   * slot applies — which is what pushed a third window off the left edge of
   * a 1536px screen (Amit, 24 September 2026).
   */
  right?: number;
  /**
   * Minimised, when the page is deciding — it minimises older windows to make
   * room for a new one. Left undefined, the composer keeps its own state.
   */
  minimised?: boolean;
  onMinimisedChange?: (minimised: boolean) => void;
  /**
   * 'inline' puts the composer IN the conversation, under the message being
   * answered, instead of in a floating window at the corner.
   *
   * Amit, 23 September 2026: "REPLY OPENING LIKE NEW MSG, IT'S A BIT
   * CONFUSING, REPLIES SHOULD OPEN A REPLY BOX WITHIN IN MAIL." A reply that
   * arrives as the same panel a brand-new message uses loses the one fact
   * that matters — that it is attached to the thing on screen. Every mail
   * client people already use answers in place.
   *
   * Everything else is identical: the same autosave, attachments, signature,
   * formatting and send path. Only where it sits changes, which is why this
   * is a placement prop and not a second component to keep in step.
   */
  placement?: 'docked' | 'inline';
  /**
   * Text to start the body with — a suggested reply the person clicked
   * (TatvaOS AI, step 2). Seeded ONCE, above the signature and the quote, as
   * escaped text, with the caret after it. Theirs to edit; never sent as is.
   */
  initialText?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pictureRef = useRef<HTMLInputElement>(null);
  // Where the caret was when the picture chooser opened: the file dialog
  // takes focus, and without this the picture lands at the top of the message.
  const pictureRange = useRef<Range | null>(null);
  const htmlSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seeded = useRef(false);
  /** The plain-text signature last put into the body, to swap on a mailbox switch. */
  const seededPlainSig = useRef('');

  const [to, setTo] = useState(mode === 'forward' ? '' : replyTo ? replyTo.from.email : '');
  const initialCc = mode === 'replyAll' ? replyAllCc(replyTo, selfAddress) : '';
  const [cc, setCc] = useState(initialCc);
  const [showCc, setShowCc] = useState(initialCc.length > 0);

  // ── BRING THE REPLY INTO VIEW WHEN IT OPENS. ──────────────────────────
  //
  //  Amit's recording, 23 September 2026: on a long thread, pressing Reply
  //  put the composer below the fold and left the view where it was, so the
  //  button looked like it had done nothing — he scrolled down by hand to
  //  find it. The reply lives at the end of the message now (which is right),
  //  and that is exactly what makes it invisible on a long one.
  //
  //  So: scroll it into view and put the caret in the body, once, when it
  //  opens. `block: end` so the Send button lands on screen with it rather
  //  than the header alone.
  //
  //  Inline only. A docked composer is already in the corner, and scrolling
  //  the page underneath it would move the mail somebody was reading.
  //
  //  Two traps, both measured on a 900x420 window rather than guessed, and
  //  either one alone leaves the Send button off screen - the same complaint,
  //  with the fix apparently already in:
  //
  //  1. `focus()` scrolls the caret into view by itself, and the editor
  //     starts well above the bottom of the composer, so focusing AFTER the
  //     scroll undoes most of it - the pane went to 285px and straight back
  //     to 132px. `preventScroll` is what stops the two fighting.
  //  2. `behavior: 'smooth'` did not scroll this pane AT ALL - 0px, every
  //     time, with no reduced-motion preference set. The instant form lands
  //     at 283px. A smooth call here is a call that silently does nothing,
  //     which is this codebase's favourite kind of bug, so it is gone.
  //
  //  Do not restore either one without re-measuring where the pane ends up.
  useEffect(() => {
    if (placement !== 'inline') return;
    const id = window.setTimeout(() => {
      shell.current?.scrollIntoView({ block: 'end' });
      editorRef.current?.focus({ preventScroll: true });
      // A suggested reply is already in the body: the caret goes after it,
      // where the person will carry on typing, not before it.
      if (initialText && editorRef.current) {
        const r = typedRange(editorRef.current);
        r.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    }, 60);   // after the first paint, or there is nothing to scroll to
    return () => window.clearTimeout(id);
    // Mount only: switching reply → reply all must not yank the page again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── SWITCHING REPLY → REPLY ALL WITHOUT LOSING WHAT WAS TYPED. ─────────
  //
  //  The page now switches an open reply's mode in place instead of opening
  //  a second box beside it (Amit, 23 Sept: pressing both buttons left two
  //  stacked replies). Switching mode has to move the recipients, and only
  //  the recipients — the initialisers above run once, so without this the
  //  header would still say "Reply all" over a To line holding one address.
  //
  //  Not on the first render: the initialisers already did it, and running
  //  again there would overwrite a draft restored into the same fields.
  const seenMode = useRef(mode);
  useEffect(() => {
    if (seenMode.current === mode) return;
    seenMode.current = mode;

    setTo(mode === 'forward' ? '' : replyTo ? replyTo.from.email : '');
    const nextCc = mode === 'replyAll' ? replyAllCc(replyTo, selfAddress) : '';
    setCc(nextCc);
    // Opened when there is something to show; left open otherwise, because
    // collapsing a row somebody has just been typing in is its own surprise.
    if (nextCc.length > 0) setShowCc(true);
  }, [mode, replyTo, selfAddress]);
  /** Unfolds the real From/To/Cc/Subject rows — see the note where they render. */
  const [expandFields, setExpandFields] = useState(false);
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  // The contenteditable does not drive React state, so typing in the body would
  // otherwise never re-run the autosave timer. This counter is the signal.
  const [bodyEdits, setBodyEdits] = useState(0);

  // ---- @-mention -------------------------------------------------------
  //
  //  Type @ and a name in the body; pick a colleague; their name lands in
  //  the text as a mailto link AND they land in To — a mention that does not
  //  put the person on the message is a trap that reads like it worked.
  //  Rich editor only: the plain-text mode is a deliberate no-frills surface.
  //
  //  The person shape is declared inline rather than imported from lib/mail,
  //  for the same reason as the signature type above: the composer keeps no
  //  dependency on the mail client module.
  const { authedFetch, authedUpload } = useAuth();
  const [mention, setMention] = useState<{ query: string; x: number; y: number } | null>(null);
  const [mentionHits, setMentionHits] = useState<{ email: string; name: string }[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);

  /** Is the caret right after "@something"? Then that something is the query. */
  function detectMention() {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!sel || !sel.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE
        || !editorRef.current?.contains(node)) {
      setMention(null);
      return;
    }
    // Start-of-text or whitespace before the @, so typed email addresses in
    // the middle of a sentence do not open the picker on their own @.
    const upto = (node.textContent ?? '').slice(0, sel.anchorOffset);
    const m = /(?:^|\s)@([\w.-]{1,64})$/.exec(upto);
    const query = m?.[1];
    if (query === undefined) {
      setMention(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setMention({ query, x: rect.left, y: rect.bottom });
  }

  useEffect(() => {
    if (!mention) {
      setMentionHits([]);
      return;
    }
    let cancelled = false;
    // Debounced: a keystroke should not be a query.
    const t = setTimeout(() => {
      authedFetch(`/mail/directory?q=${encodeURIComponent(mention.query)}`)
        .then((r) => (r.ok ? r.json() : { people: [] }))
        .then((b: { people: { email: string; name: string }[] }) => {
          if (cancelled) return;
          setMentionHits((b.people ?? []).slice(0, 6));
          setMentionIdx(0);
        })
        .catch(() => { if (!cancelled) setMentionHits([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mention, authedFetch]);

  function pickMention(p: { email: string; name: string }) {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (sel && node && node.nodeType === Node.TEXT_NODE && editorRef.current?.contains(node)) {
      const upto = (node.textContent ?? '').slice(0, sel.anchorOffset);
      const m = /(?:^|\s)@([\w.-]{0,64})$/.exec(upto);
      const typed = m?.[1];
      if (typed !== undefined) {
        // Replace "@quer" with a mailto link — HTML mail renders it as a
        // name anyone can click, and receivers that strip HTML still see
        // the name as text.
        const range = document.createRange();
        range.setStart(node, upto.length - typed.length - 1);
        range.setEnd(node, sel.anchorOffset);
        range.deleteContents();
        const a = document.createElement('a');
        a.href = `mailto:${p.email}`;
        a.textContent = p.name || p.email;
        range.insertNode(a);
        const space = document.createTextNode(' ');
        a.after(space);
        sel.collapse(space, 1);
        setBodyEdits((n) => n + 1);
      }
    }
    setTo((prev) => {
      const have = splitAddresses(prev).some((x) => x.toLowerCase() === p.email.toLowerCase());
      return have ? prev : prev.trim() ? `${prev.trim()}, ${p.email}` : p.email;
    });
    setMention(null);
  }

  /** Arrow keys walk the suggestions; Enter/Tab picks; Escape dismisses. */
  /**
   * Paste, cleaned.
   *
   * The browser's own contenteditable paste inserts the clipboard's HTML
   * verbatim — which is how a Google search result arrived UPSIDE DOWN in a
   * new message (Amit, 23 Sept 2026): the copied markup carried a transform,
   * and the composer applied it faithfully. Whatever lands here is what gets
   * SENT, so this is the last point at which somebody else's CSS can be
   * stopped from deciding what a message looks like in the recipient's inbox.
   *
   * Formatting survives; layout control does not. See lib/pasteHtml.
   */
  function onEditorPaste(e: React.ClipboardEvent) {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    // A screenshot tool puts a picture FILE on the clipboard and no HTML. The
    // browser's own paste would insert it at full size -- several MB from a
    // phone or a high-DPI screen. Through the picture path it is resized.
    const pictures = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!html && pictures.length > 0) {
      e.preventDefault();
      void insertPictures(pictures);
      return;
    }
    if (!html && !text) return;

    e.preventDefault();
    const clean = html ? cleanPastedHtml(html) : '';

    // insertHTML/insertText rather than setting innerHTML: both go through
    // the browser's own undo stack, so ctrl+Z after a paste behaves the way
    // it does everywhere else.
    if (clean) document.execCommand('insertHTML', false, clean);
    else document.execCommand('insertText', false, text);

    setBodyEdits((n) => n + 1);
  }

  function onEditorKeyDown(e: React.KeyboardEvent) {
    if (!mention || mentionHits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionIdx((i) => (i + 1) % mentionHits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIdx((i) => (i - 1 + mentionHits.length) % mentionHits.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const hit = mentionHits[mentionIdx];
      if (hit) pickMention(hit);
    } else if (e.key === 'Escape') {
      setMention(null);
    }
  }
  const [subject, setSubject] = useState(() => autoSubject(replyTo, mode));
  const [files, setFiles] = useState<File[]>([]);
  /** Parked in Space, going out as links when this message is sent. */
  const [links, setLinks] = useState<SpaceLink[]>([]);
  /** Oversize files picked but not yet decided on, oldest first. */
  const [queue, setQueue] = useState<File[]>([]);
  /** The one being asked about. Null when nothing is. */
  const [offer, setOffer] = useState<ParkOffer | null>(null);
  const [parking, setParking] = useState(false);
  /** 0..1 while a file is going up, null when nothing is. */
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pane, setPane] = useState<PaneState>('docked');
  const [plain, setPlain] = useState(false);
  // The HTML editor: null while editing normally; the source text while open.
  // The rich editor stays MOUNTED (hidden) underneath, kept in step with the
  // cleaned source, because autosave and send both read its innerHTML.
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [removedCode, setRemovedCode] = useState<string[]>([]);
  // The formatting bar, shown unless the person hid it. Remembered per browser.
  const [showFormat, setShowFormat] = useState(() => {
    try { return localStorage.getItem('tatvaos.compose.formatBar') !== 'off'; } catch { return true; }
  });
  const [spell, setSpell] = useState(true);
  const [more, setMore] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plainBody, setPlainBody] = useState('');
  /**
   * Whether a reply's quoted history is unfolded in the editor. Folded by
   * default, the way Gmail does it: the new inline reply box sits INSIDE the
   * message being answered, and a full copy of that message under the caret
   * turns a two-line reply into a scroll. It is still sent either way — this
   * only changes what the editor draws.
   */
  const [showQuote, setShowQuote] = useState(false);
  /** The plain-text quote as last seeded, so a mode switch can swap it. */
  const plainQuote = useRef('');

  // ── REPLY ↔ FORWARD IN ONE BOX. ─────────────────────────────────────────
  //
  //  Amit, 24 September 2026: "fix reply and forward both open in diff
  //  window". Pressing Reply and then Forward left two boxes in the same
  //  message, each with its own Send. The page now switches the one box's
  //  mode instead (see startCompose), and the recipient effect above moves
  //  To/Cc. This moves the two other things a forward changes:
  //
  //   · THE SUBJECT, only while it is still the automatic one. If somebody
  //     has rewritten it, it is theirs and a mode switch must not undo it.
  //   · THE QUOTE's heading — "On … wrote:" becomes a forwarded-message
  //     header and back. Found by its data-tv-quote marker and replaced in
  //     place, so every word typed above it survives the switch.
  //
  //  Tracked on its own ref, not seenMode: that one is consumed by the
  //  recipient effect, and two effects sharing one "previous" value is how
  //  the second one ends up always seeing no change.
  const seenModeForBody = useRef(mode);
  useEffect(() => {
    const prev = seenModeForBody.current;
    if (prev === mode) return;
    seenModeForBody.current = mode;
    if (!replyTo) return;

    setSubject((s) => (s === autoSubject(replyTo, prev) ? autoSubject(replyTo, mode) : s));

    if (quoteKind(prev) === quoteKind(mode)) return;   // reply ↔ reply all: same quote

    if (plain) {
      const next = quoteText(replyTo, mode);
      setPlainBody((b) => (plainQuote.current && b.includes(plainQuote.current)
        ? b.replace(plainQuote.current, next)
        : b));
      plainQuote.current = next;
      return;
    }

    const block = editorRef.current?.querySelector('[data-tv-quote]');
    // Our own escaped and sanitised output — see quoteHtml. Never message HTML.
    if (block) block.outerHTML = quoteHtml(replyTo, mode);
  }, [mode, replyTo, plain]);

  // ── HELP ME WRITE (TatvaOS AI, 25 Sept 2026). ───────────────────────────
  //
  //  Only the person's own words go: typedRange / splitPlainDraft stop at the
  //  signature and the quote. The rewrite goes in through execCommand, like
  //  paste, so ctrl+Z undoes it — and execCommand fires this editor's input
  //  event synchronously, which is why `aiReplacing` exists: without it the
  //  replace itself would count as "typed since", and Undo would vanish the
  //  instant it appeared.
  const aiAvailable = useMailAiAvailable('rewrite');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiEdited, setAiEdited] = useState(true);
  const aiReplacing = useRef(false);
  const aiPlainBefore = useRef<string | null>(null);

  function aiReadDraft(): string {
    if (plain) return splitPlainDraft(plainBody, [seededPlainSig.current, plainQuote.current]).typed;
    return editorRef.current ? typedText(editorRef.current) : '';
  }

  /** Pictures in the typed part would be lost to a plain-text rewrite. */
  function aiRefuseReason(): string | null {
    if (plain || !editorRef.current) return null;
    return typedRange(editorRef.current).cloneContents().querySelector('img')
      ? 'Help me write cannot rewrite a draft with a picture in it yet — the picture would be lost. Move the picture below your signature, or rewrite the text first and add the picture after.'
      : null;
  }

  function aiReplace(text: string) {
    if (plain) {
      const { tail } = splitPlainDraft(plainBody, [seededPlainSig.current, plainQuote.current]);
      aiPlainBefore.current = plainBody;
      setPlainBody(text + tail);
      setAiEdited(false);
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    const range = typedRange(el);
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    aiReplacing.current = true;
    try {
      // Escaped text with <br>s — see textToHtml. Never the model's markup.
      document.execCommand('insertHTML', false, textToHtml(text));
    } finally {
      aiReplacing.current = false;
    }
    setBodyEdits((n) => n + 1);
    setAiEdited(false);
  }

  function aiUndo() {
    if (plain) {
      if (aiPlainBefore.current !== null) setPlainBody(aiPlainBefore.current);
      aiPlainBefore.current = null;
    } else {
      editorRef.current?.focus({ preventScroll: true });
      aiReplacing.current = true;
      try { document.execCommand('undo'); } finally { aiReplacing.current = false; }
      setBodyEdits((n) => n + 1);
    }
    setAiEdited(true);
  }

  const moreRef = useRef<HTMLDivElement>(null);
  const emojiBtnRef = useRef<HTMLSpanElement>(null);
  const emojiPopRef = useRef<HTMLDivElement>(null);

  /**
   * Dismiss the popovers on an outside click or Escape.
   *
   * The listener is mousedown, not click, so a popover closes as the press
   * lands rather than after release. Each trigger is inside the region checked
   * for containment — otherwise pressing the trigger to close would dismiss on
   * mousedown and then re-open on the click that followed, and the menu would
   * appear stuck open.
   */
  useEffect(() => {
    if (!more && !emoji) return undefined;

    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (more && moreRef.current && !moreRef.current.contains(t)) setMore(false);
      if (
        emoji
        && !emojiPopRef.current?.contains(t)
        && !emojiBtnRef.current?.contains(t)
      ) setEmoji(false);
    }
    function onKey(e: KeyboardEvent) {
      // Only the popovers — Escape must never discard a half-written message.
      if (e.key === 'Escape') { setMore(false); setEmoji(false); }
    }

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [more, emoji]);

  // Rich formatting command on the editor.
  //
  // styleWithCSS is per-document state, so it is set on every call. ON for
  // colour, font, indent and alignment: inline styles, which every mail client
  // reads -- with it off, highlight does nothing in Firefox and indent writes a
  // <blockquote>, which this composer draws as a QUOTE. OFF for the rest, so
  // bold stays <b> rather than a styled span.
  function cmd(command: string, value?: string) {
    editorRef.current?.focus();
    try { document.execCommand('styleWithCSS', false, CSS_COMMANDS.has(command) ? 'true' : 'false'); } catch { /* not fatal */ }
    document.execCommand(command, false, value);
    tidyEditorFontSizes(editorRef.current);
  }

  /**
   * Size in px. execCommand only knows a 1-7 scale whose keyword sizes
   * (x-large...) differ between mail clients, so it is asked for size 7 as a
   * marker, and each <font size="7"> it writes is swapped for a span with the
   * real size. Sizes set earlier inside the selection are cleared, or the
   * inner one would win and the change would appear to do nothing.
   */
  function applyFontSize(px: number) {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* not fatal */ }
    document.execCommand('fontSize', false, '7');
    let last: HTMLElement | null = null;
    el.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      while (f.firstChild) span.appendChild(f.firstChild);
      span.querySelectorAll<HTMLElement>('[style*="font-size"]').forEach((n) => { n.style.fontSize = ''; });
      f.replaceWith(span);
      last = span;
    });
    // Keep the text selected, so a second size or a colour applies to it too.
    if (last) {
      const r = document.createRange();
      r.selectNodeContents(last);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    setBodyEdits((n) => n + 1);
  }

  function openPicturePicker() {
    const sel = window.getSelection();
    pictureRange.current = sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)
      ? sel.getRangeAt(0).cloneRange()
      : null;
    pictureRef.current?.click();
  }

  /** Inserts pictures at the caret (or where it was when the chooser opened). */
  async function insertPictures(files: File[]) {
    const el = editorRef.current;
    if (!el || files.length === 0) return;
    setError(null);
    for (const file of files) {
      try {
        const pic = await pictureToDataUrl(file);
        el.focus();
        if (pictureRange.current) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(pictureRange.current);
          pictureRange.current = null;
        }
        document.execCommand('insertHTML', false, pictureTag(pic.dataUrl, pic.width ?? undefined));
        // Chrome's insertHTML drops inline styles that match what the PAGE
        // already applies — and Tailwind's base styles give every img
        // max-width:100%;height:auto. Measured 25 Sept 2026: the style was
        // gone from the inserted picture, so it looked right here and would
        // have overflowed a phone in the recipient's mail app. Put it back
        // after the insert, where nothing compares it to our stylesheet.
        el.querySelectorAll('img').forEach((img) => {
          if (img.getAttribute('src') === pic.dataUrl && !img.style.maxWidth) {
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
          }
        });
      } catch (err) {
        setError(err instanceof PictureRefused ? err.message : 'The picture could not be added.');
      }
    }
    setBodyEdits((n) => n + 1);
  }

  function toggleFormatBar() {
    setShowFormat((v) => {
      try { localStorage.setItem('tatvaos.compose.formatBar', v ? 'off' : 'on'); } catch { /* per-browser nicety only */ }
      return !v;
    });
  }

  /**
   * Into and out of the HTML editor.
   *
   * Out is where the source is CLEANED (lib/composeHtml) -- the editor's HTML
   * is sent as it stands, so nothing reaches it uncleaned. If the clean took
   * anything out, the view stays on the source, now showing what is left and
   * a notice naming what went, and a second press goes back. Nobody finds
   * out afterwards that part of what they wrote was silently dropped.
   */
  function toggleHtml() {
    const el = editorRef.current;
    if (!el) return;
    if (htmlSource === null) {
      setRemovedCode([]);
      setHtmlSource(formatHtmlSource(el.innerHTML));
      return;
    }
    if (htmlSyncTimer.current) clearTimeout(htmlSyncTimer.current);
    const r = cleanComposeHtml(htmlSource);
    el.innerHTML = r.html;
    setBodyEdits((n) => n + 1);
    if (r.removed.length > 0) {
      setRemovedCode(r.removed);
      setHtmlSource(formatHtmlSource(r.html));
      return;
    }
    setRemovedCode([]);
    setHtmlSource(null);
  }

  function onHtmlSourceChange(next: string) {
    setHtmlSource(next);
    // Keep the hidden editor in step, for autosave. Cleaned, and quietly:
    // the notice belongs to the moment someone leaves the view or sends.
    if (htmlSyncTimer.current) clearTimeout(htmlSyncTimer.current);
    htmlSyncTimer.current = setTimeout(() => {
      const el = editorRef.current;
      if (el) { el.innerHTML = cleanComposeHtml(next).html; setBodyEdits((n) => n + 1); }
    }, 400);
  }

  /** Before send: apply the source. False means "stop -- something was removed". */
  function commitHtmlSourceForSend(): boolean {
    const el = editorRef.current;
    if (htmlSource === null || !el) return true;
    if (htmlSyncTimer.current) clearTimeout(htmlSyncTimer.current);
    const r = cleanComposeHtml(htmlSource);
    el.innerHTML = r.html;
    if (r.removed.length === 0) return true;
    setRemovedCode(r.removed);
    setHtmlSource(formatHtmlSource(r.html));
    setError('Some code was taken out of the HTML. Check the message, then press Send again.');
    return false;
  }

  /** Leaving the HTML view without asking -- switching to plain text. */
  function leaveHtmlQuietly() {
    const el = editorRef.current;
    if (htmlSource === null || !el) return;
    if (htmlSyncTimer.current) clearTimeout(htmlSyncTimer.current);
    el.innerHTML = cleanComposeHtml(htmlSource).html;
    setHtmlSource(null);
    setRemovedCode([]);
  }

  function insertEmoji(e: string) {
    if (plain) {
      setPlainBody((b) => b + e);
    } else {
      editorRef.current?.focus();
      document.execCommand('insertText', false, e);
    }
    setEmoji(false);
  }

  function addLink() {
    const url = window.prompt('Link URL', 'https://');
    if (url) cmd('createLink', url);
  }

  /**
   * Picking files.
   *
   * THE 25 MB CEILING IS NO LONGER A DEAD END. It used to refuse the whole
   * selection and say so, which left somebody holding a 40 MB video with
   * nothing to do about it but find another way to send it. Now anything that
   * fits is attached, and anything that does not is offered as a Space link -
   * the file goes to their own storage and the message carries a link to it.
   *
   * Files are taken in order and each is measured against what is left, so
   * picking a 30 MB file and a 1 MB file attaches the small one rather than
   * refusing both because the first was too big.
   */
  function onPickFiles(list: FileList | null) {
    if (!list) return;

    const fits: File[] = [];
    const oversize: File[] = [];
    let total = files.reduce((n, f) => n + f.size, 0);

    for (const f of Array.from(list)) {
      if (total + f.size <= MAX_TOTAL) {
        fits.push(f);
        total += f.size;
      } else {
        oversize.push(f);
      }
    }

    setError(null);
    if (fits.length > 0) setFiles((prev) => [...prev, ...fits]);
    if (oversize.length > 0) setQueue((prev) => [...prev, ...oversize]);
  }

  /**
   * THE PRE-CHECK, and the reason it happens here rather than at send.
   *
   * Since Core's storage change one allowance covers a person's mail AND
   * their files, so somebody nowhere near full on email can still have no
   * room for a 2 GB video. Finding that out after writing the message - or
   * worse, after waiting through the upload - is the bad version. This reads
   * the allowance the moment the file is picked, before a byte moves.
   *
   * A storage read that FAILS is not a refusal. The offer is made anyway with
   * `free` null, and the server gets to be the judge: it refuses correctly,
   * and guessing "no" here would block somebody who has plenty of room
   * because one unrelated call had a bad moment.
   */
  useEffect(() => {
    if (offer !== null || parking) return;
    // Indexed, not a length check: noUncheckedIndexedAccess types queue[0] as
    // File | undefined, and narrowing it here is what proves the queue is
    // non-empty rather than asserting it.
    const file = queue[0];
    if (!file) return;
    let alive = true;
    void fetchMyStorage(authedFetch)
      .then((s) => { if (alive) setOffer({ file, free: s.availableBytes }); })
      .catch(() => { if (alive) setOffer({ file, free: null }); });
    return () => { alive = false; };
  }, [queue, offer, parking, authedFetch]);

  /** Done with the file at the head of the queue, whatever we decided. */
  function dismissOffer() {
    setQueue((q) => q.slice(1));
    setOffer(null);
  }

  /**
   * Park the offered file in Space and put a link on the message.
   *
   * TWO CALLS, AND THE GAP BETWEEN THEM MATTERS. Once the upload returns, the
   * file EXISTS in their Space whether or not the link succeeds. A failure
   * after that point must say where the file went, or somebody has a 40 MB
   * upload sitting somewhere they were never told about and will not think to
   * look. It is not lost - it is in "Email attachments" - but only if we say
   * so.
   */
  async function parkOffered() {
    if (!offer) return;
    const { file } = offer;
    const controller = new AbortController();
    abortRef.current = controller;
    setParking(true);
    setProgress(0);
    setError(null);
    try {
      const parked = await mailApi.attachToSpace(
        authedUpload, file, (fraction) => setProgress(fraction), controller.signal);

      if (!parked.ok) {
        let sentence = parked.error;
        if (parked.reason === 'full') {
          // The upload transport keeps Core's reason and Core's sentence but
          // not the figures. Fetching them is worth one extra call on a path
          // nobody hits twice: "you have 1.2 GB free" is the half that tells
          // somebody what to do next.
          const room = await fetchMyStorage(authedFetch).catch(() => null);
          if (room)
            sentence = `${parked.error} (${formatBytes(room.availableBytes)} free of ` +
                       `${formatBytes(room.quotaBytes)}.)`;
        }
        setError(sentence);
        dismissOffer();
        return;
      }

      // FROM HERE THE FILE EXISTS IN THEIR SPACE whether or not the link
      // succeeds. Any failure after this point has to say where it went, or
      // somebody has a half-gigabyte upload sitting somewhere they were never
      // told about and would not think to look. It is not lost - it is in
      // "Email attachments" - but only if we say so.
      try {
        const link = await linkApi.create(authedFetch, parked.fileId, LINK_EXPIRY_DAYS);
        setLinks((prev) => [...prev, {
          fileId: parked.fileId,
          name: parked.name,
          sizeBytes: parked.sizeBytes,
          url: link.url,
          expiresAt: link.expiresAt,
        }]);
      } catch (e) {
        // The likeliest reason by far is an administrator having turned public
        // links off for the organisation, and Space says so in the message.
        // Swallowing it would leave somebody retrying a thing that is not
        // going to start working.
        const why = e instanceof Error && e.message ? ` ${e.message}` : '';
        setError(
          `${parked.name} was saved to your Space, in the “Email attachments” folder, ` +
          `but a link could not be created, so it is not on this message.${why} ` +
          'You can share it from Space.');
      }
      dismissOffer();
    } catch (e) {
      // Stopping your own upload is not a failure and must not be reported as
      // one. Everything else leaves the offer UP, so "Send as a link" is one
      // click away rather than a re-pick from the file dialog.
      if ((e as Error).name === 'AbortError') dismissOffer();
      else setError('The file could not be sent to Space. Check your connection and try again.');
    } finally {
      abortRef.current = null;
      setParking(false);
      setProgress(null);
    }
  }

  async function handleSend() {
    setSending(true);
    setError(null);
    if (!commitHtmlSourceForSend()) { setSending(false); return; }
    try {
      // The link block is appended AT SEND, not inserted as you attach, so it
      // cannot be half-deleted by an editing cursor and cannot drift out of
      // step with the chips above. What the chips show is what goes out.
      const linkText = linkBlockText(links);
      const linkHtml = linkBlockHtml(links);

      const bodyText = (plain ? plainBody : editorText(editorRef.current)) + linkText;
      const rawHtml = plain ? undefined : (editorRef.current?.innerHTML || undefined);
      // In plain mode there is no HTML half at all and the text block carries
      // the links alone. Otherwise an empty body plus links still needs one.
      const bodyHtml = plain
        ? undefined
        : (linkHtml ? `${rawHtml ?? ''}${linkHtml}` : rawHtml);
      await onSend({
        to: splitAddresses(to),
        cc: showCc ? splitAddresses(cc) : undefined,
        subject,
        bodyText,
        bodyHtml,
        files,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The message could not be sent.');
      setSending(false);
    }
  }

  // Close the popovers on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMore(false);
        setEmoji(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // A forward starts with the original quoted into the body. Seed the editor
  // once, after it mounts, and only when there is something to quote.
  useEffect(() => {
    // Whether the signature applies at all. `enabled` is the master switch;
    // `includeOnReply` is asked separately because most people want a signature
    // on a new message and not on the fourth reply in a thread.
    const withSig = Boolean(signature?.enabled && (mode === 'new' || signature.includeOnReply));

    // ── THE SIGNATURE FOLLOWS THE MAILBOX. ────────────────────────────────
    //
    //  Amit, 24 September 2026: three windows, all "From support@", one with
    //  no signature and one with his own. From is a live prop — switch
    //  mailbox and every open window re-labels itself — but the signature
    //  was seeded ONCE, so a window opened in your own mailbox kept your
    //  personal signature on mail that now goes out as the shared address.
    //
    //  So once seeded, a later signature (the page re-boots on a switch and
    //  hands a new one down) REPLACES the old one in place — found by the
    //  marker it was seeded with, never by matching text. If the marker is
    //  gone the person deleted the signature, and it stays deleted.
    if (seeded.current) {
      if (plain) {
        const next = withSig && signature ? signature.bodyText : '';
        const prevText = seededPlainSig.current;
        if (prevText === next) return;
        // Plain text has no marker to find, so this one does match text —
        // and only swaps it while it is still there, untouched.
        setPlainBody((b) => (prevText && b.includes(prevText) ? b.replace(prevText, next) : b));
        seededPlainSig.current = next;
        return;
      }
      const box = editorRef.current?.querySelector<HTMLElement>(`[${SIG_ATTR}]`);
      if (!box) return;
      box.innerHTML = withSig && signature ? cleanSignatureHtml(signature.bodyHtml) : '';
      return;
    }

    if (plain) {
      const sigText = withSig && signature ? `\n\n${signature.bodyText}` : '';
      // Plain text gets the quote too. Before this a plain-text FORWARD
      // carried only the signature — the message being forwarded was simply
      // not in it.
      const q = replyTo && mode !== 'new' ? quoteText(replyTo, mode) : '';
      const lead = initialText ?? '';
      if (!sigText && !q && !lead) return;
      plainQuote.current = q;
      // Functional update so an already-typed body is never overwritten — this
      // effect re-runs on a mode change, and the body may not be empty by then.
      setPlainBody((b) => (b.trim() === '' ? `${lead}${sigText}${q ? `\n\n${q}` : ''}` : b));
      seededPlainSig.current = withSig && signature ? signature.bodyText : '';
      seeded.current = true;
      return;
    }

    const el = editorRef.current;
    if (!el) return;

    // "Empty" has to ignore the <br> browsers drop into a contenteditable the
    // moment it is focused, or the body never looks empty and nothing seeds.
    if (el.innerHTML.replace(/<br\s*\/?>/gi, '').trim() !== '') return;

    // Signature ABOVE the quote: a reply then reads reply → signature → quote,
    // which keeps the quoted history last where it can be collapsed and read
    // as history rather than as part of the new message.
    //
    // CLEANED ON THE WAY IN, even though it is "our own" content. From 23
    // September a signature is rich HTML written in a real editor, and a
    // signature belongs to a MAILBOX: a shared one is written by one
    // colleague and seeded here into another's composer. The API stores what
    // it is handed (SaveSignatureAsync caps the length and does not
    // sanitise), so the editor's cleaner alone would be one a crafted PUT
    // walks past. This is the same function the editor uses.
    // Wrapped in a marked block so a mailbox switch can find and swap it
    // (above). The block stays even when the new mailbox has no signature —
    // empty — so switching back puts that mailbox's one in again.
    const sig = withSig && signature
      ? `<br><br><div ${SIG_ATTR}="">${cleanSignatureHtml(signature.bodyHtml)}</div>`
      : '';
    // EVERY reply and forward, not only a forward — see quoteHtml for the
    // spam verdict and the script hole this used to be.
    const quote = replyTo && mode !== 'new' ? `<br><br>${quoteHtml(replyTo, mode)}` : '';
    // A clicked suggestion goes first, ESCAPED (textToHtml) — it is model
    // output, and a model can be talked into writing markup.
    const lead = initialText ? textToHtml(initialText) : '';
    if (!sig && !quote && !lead) return;

    // Only our own output reaches innerHTML: the signature through
    // cleanSignatureHtml, the quote through quoteHtml's sanitiser and escapes,
    // a suggestion through textToHtml.
    el.innerHTML = lead + sig + quote;
    seeded.current = true;
  }, [mode, replyTo, plain, signature, initialText]);

  /** Current contents, in the shape autosave and send both want. */
  function draftFields(): DraftFields {
    const el = editorRef.current;
    return {
      to, cc, bcc, subject,
      bodyText: plain ? plainBody : editorText(el ?? null),
      bodyHtml: plain ? '' : (el?.innerHTML ?? ''),
    };
  }

  /**
   * Never throws. A failed autosave must not interrupt someone mid-sentence —
   * the send path reports its own failures, and that is the one that matters.
   */
  function saveDraftNow() {
    if (!onSaveDraft) return;
    // An opened-and-abandoned window should not leave a junk row in Drafts.
    if (!to.trim() && !cc.trim() && !bcc.trim() && !subject.trim()) return;
    try {
      onSaveDraft(draftFields());
    } catch {
      /* silent by design */
    }
  }

  useEffect(() => {
    if (!onSaveDraft) return undefined;
    if (!to.trim() && !cc.trim() && !bcc.trim() && !subject.trim()) return undefined;
    const t = setTimeout(saveDraftNow, 2000);
    return () => clearTimeout(t);
    // saveDraftNow is re-created each render and deliberately not a dependency;
    // the fields below are what should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, plainBody, bodyEdits, onSaveDraft]);

  const totalSize = files.reduce((n, f) => n + f.size, 0);

  // Full screen wins over a minimise the page asked for: only one thing can be
  // the task, and it is the one the person just made full screen.
  const minimised = pane === 'full' ? false : (minimisedProp ?? pane === 'min');
  function setMinimised(next: boolean) {
    if (onMinimisedChange) onMinimisedChange(next);
    else setPane(next ? 'min' : 'docked');
  }
  // One-line recipients: a REPLY sitting in the conversation, until somebody
  // asks for the fields. A new message always gets the form — it has nobody
  // to summarise.
  const compact = placement === 'inline' && replyTo != null && !expandFields;

  return (
    <>
      {/* Only full screen dims the mailbox. A docked composer that greyed out
          everything behind it would be a modal wearing a corner panel's clothes. */}
      {pane === 'full' && <div className="fixed inset-0 z-[1190] bg-black/40" aria-hidden="true" />}

      <div
        ref={shell}
        className={
          // In the conversation: no fixed position, no slot arithmetic, no
          // corner. It is part of the page and scrolls with the message it
          // answers. Full screen still works from here.
          placement === 'inline' && pane !== 'full'
            ? 'w-full'
            : pane === 'full'
            // Above YZEN's chrome: it puts .app-header at z-index 100 and
            // .app-sidebar at 103, so at Tailwind's z-50 the header covered the
            // composer's own title bar — and with it the close button.
            ? 'fixed inset-0 z-[1200] flex items-center justify-center p-4 sm:p-6'
            // Slots beyond the first are hidden on phones — there is no room
            // for two panels, and the hidden draft stays mounted, so nothing
            // typed is lost; rotate a tablet or close the front one to reach it.
            : `fixed inset-x-0 bottom-0 z-[1200] justify-center sm:inset-x-auto sm:justify-end ${
                offset > 0 ? 'hidden sm:flex' : 'flex'
              }`
        }
        // Each open composer sits one 580px slot further left, Gmail-style.
        // An inline style because slot arithmetic is not a class; harmless on
        // phones, where inset-x-0 pins both edges for offset 0 and the rest
        // are hidden above.
        style={pane === 'full' || placement === 'inline'
          ? undefined
          : { right: right ?? 20 + offset * 580 }}
      >
        <div
          className={`flex w-full flex-col overflow-hidden bg-surface ${
            placement === 'inline' && pane !== 'full'
              // A card in the flow, not a panel over the page: a border
              // instead of the floating shadow, and a height that suits a
              // reply rather than filling the corner.
              ? 'rounded-card border border-line min-h-[320px]'
              : pane === 'full'
                ? 'h-full max-w-5xl rounded-card shadow-raised'
                : minimised
                  ? 'rounded-t-card shadow-raised sm:w-[360px]'
                  : 'h-[78vh] rounded-t-card shadow-raised sm:h-[560px] sm:w-[560px]'
          }`}
        >
          {/* Title bar. While minimised the whole bar restores the draft — the
              collapsed strip is the only target left, so all of it should work. */}
          <header
            className={`flex items-center justify-between bg-rail px-4 py-3 text-ink ${minimised ? 'cursor-pointer' : ''}`}
            onClick={minimised ? () => setMinimised(false) : undefined}
          >
            <span className="truncate text-sm font-semibold tracking-tight">
              {mode === 'replyAll' ? 'Reply all'
                : mode === 'forward' ? 'Forward'
                  : replyTo ? 'Reply' : 'New message'}
              {minimised && subject.trim() ? ` — ${subject.trim()}` : ''}
            </span>
            <div className="flex items-center gap-1">
              {/* Nothing to minimise INTO when the composer sits in the
                  conversation — the strip would collapse to a bar in the
                  middle of the message and read as broken. */}
              {placement !== 'inline' && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Minimising is the clearest "I am coming back to this" there
                  // is, so the draft is flushed rather than left to the timer.
                  if (!minimised) saveDraftNow();
                  setMinimised(!minimised);
                }}
                aria-label={minimised ? 'Restore' : 'Minimise'}
                title={minimised ? 'Restore' : 'Minimise'}
                className="rounded p-1 text-ink-muted hover:bg-line/60 hover:text-ink"
              >
                <Icon name={minimised ? 'expand' : 'minimise'} className="h-4 w-4" />
              </button>
              )}
              {/* Hidden while minimised: restore is the only sensible action
                  there, and next to it this button showed the SAME expand
                  icon — two identical icons doing different things. */}
              {!minimised && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setPane(pane === 'full' ? 'docked' : 'full'); }}
                  aria-label={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                  title={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                  className="rounded p-1 text-ink-muted hover:bg-line/60 hover:text-ink"
                >
                  <Icon name={pane === 'full' ? 'collapse' : 'expand'} className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                aria-label="Close"
                className="rounded p-1 text-ink-muted hover:bg-line/60 hover:text-ink"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            </div>
          </header>

          {/* HIDDEN, NOT UNMOUNTED, while minimised. This block used to be
              `{!minimised && ...}`, which threw the editor away on minimise:
              the body lives in the contenteditable's DOM, not in React state,
              so Restore brought back an EMPTY message — typed text and
              signature both gone (measured 24 Sept 2026: 'HELLO-TYPED …'
              before, '' after). `contents` when shown keeps every child a
              direct flex item of the panel, exactly as the fragment did. */}
          <div className={minimised ? 'hidden' : 'contents'}>

        {/* ── A REPLY OPENS AS ONE LINE, NOT A FORM. ────────────────────────
            Gmail shows a reply's recipients as a single quiet line and keeps
            the fields folded away, because a reply already knows who it is
            going to — the form is for the rare occasion you want to change
            that. Four stacked rows (From, To, Cc, Subject) over a message
            that had just been squeezed to a sliver is what Amit was looking
            at on 23 September.

            Click the line to unfold the real fields; they are the same
            inputs, so nothing about sending changes. */}
        {compact ? (
          <div className="px-4">
            <button
              type="button"
              onClick={() => setExpandFields(true)}
              className="flex w-full items-center gap-2 border-b border-line py-2.5 text-left text-sm text-ink-muted transition hover:text-ink"
            >
              <span className="shrink-0">to</span>
              <span className="min-w-0 flex-1 truncate text-ink">
                {[to, cc].filter(Boolean).join(', ') || 'nobody yet'}
              </span>
              <span aria-hidden="true" className="shrink-0 text-ink-faint">▾</span>
            </button>
          </div>
        ) : (
        <div className="px-4">
          {/* No focus-within here: this row holds no input, and a border
              that promises focus it can never show is furniture. */}
          <div className="flex items-center gap-2 border-b border-line py-2.5 text-sm">
            <span className="w-12 shrink-0 text-ink-muted">From</span>
            <span className="truncate text-ink">{fromAddress}</span>
          </div>
          <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
            <span className="w-12 shrink-0 text-ink-muted">To</span>
            {/* Family supplies suggestions; this input still owns the value,
                the parsing and the validation, so mail sends normally when
                Family is unavailable. */}
            <ContactPicker value={to} onPick={setTo}>
              {(pickerRef, onPickerKeyDown) => (
                <input
                  ref={pickerRef}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onKeyDown={onPickerKeyDown}
                  placeholder="Recipients — commas for several"
                  className="w-full border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
                />
              )}
            </ContactPicker>
            {/* Merge note: Family's contact picker and Mail's Bcc toggle landed
                independently — the Family branch predates Bcc. Both are kept;
                dropping either would silently remove a shipped feature. */}
            <span className="flex shrink-0 items-center gap-2">
              {!showCc && (
                <button type="button" onClick={() => setShowCc(true)}
                        className="text-xs font-medium text-ink-muted hover:text-ink">
                  Cc
                </button>
              )}
              {!showBcc && (
                <button type="button" onClick={() => setShowBcc(true)}
                        className="text-xs font-medium text-ink-muted hover:text-ink">
                  Bcc
                </button>
              )}
            </span>
          </label>
          {showCc && (
            <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
              <span className="w-12 shrink-0 text-ink-muted">Cc</span>
              {/* Same picker as To. Cc and Bcc were the only recipient fields
                  without suggestions, which read as the feature randomly not
                  working depending on which line you typed in. */}
              <ContactPicker value={cc} onPick={setCc}>
                {(pickerRef, onPickerKeyDown) => (
                  <input
                    ref={pickerRef}
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    onKeyDown={onPickerKeyDown}
                    placeholder="name@example.com"
                    className="w-full border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
                  />
                )}
              </ContactPicker>
            </label>
          )}
          {showBcc && (
            <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
              <span className="w-12 shrink-0 text-ink-muted">Bcc</span>
              <ContactPicker value={bcc} onPick={setBcc}>
                {(pickerRef, onPickerKeyDown) => (
                  <input
                    ref={pickerRef}
                    value={bcc}
                    onChange={(e) => setBcc(e.target.value)}
                    onKeyDown={onPickerKeyDown}
                    placeholder="Hidden from everyone else on the message"
                    className="w-full border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
                  />
                )}
              </ContactPicker>
            </label>
          )}
          {/* Labelled like From and To, so the four rows read as one aligned
              form instead of three labelled rows and a stray. The placeholder
              goes with the label's arrival - saying "Subject" twice is noise. */}
          <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
            <span className="w-12 shrink-0 text-ink-muted">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full border-0 bg-transparent p-0 text-sm font-medium text-ink outline-none placeholder:text-ink-faint"
            />
          </label>
        </div>
        )}

        {/* ------------------------------------------------------------------
            The body AND everything attached to it, in ONE scrolling region.

            The composer is a fixed-height panel (78vh, or 560px from the sm
            breakpoint up) with overflow-hidden. Anything stacked below the
            editor that made the column taller than that was simply CLIPPED —
            which is how the over-size offer card ended up rendering past the
            bottom edge with its button behind the taskbar, on a laptop, where
            the feature is most likely to be needed.

            Everything that grows now lives in here and scrolls. The toolbar
            and the error line stay outside it, pinned, because a Send button
            you have to scroll to find is the same bug wearing a different hat.
            ------------------------------------------------------------------ */}
        <div
          className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto"
          // The mention popup is positioned at the caret, so a scroll moves
          // the caret out from under it. This moved up from the editor with
          // the scrollbar itself.
          onScroll={() => setMention(null)}
        >
        {/* Body */}
        {plain ? (
          <textarea
            value={plainBody}
            onChange={(e) => { setPlainBody(e.target.value); setAiEdited(true); }}
            spellCheck={spell}
            placeholder="Write your message"
            // grow shrink-0 for the same spill bug as the rich editor below —
            // a textarea clips rather than spills, but flex-1's zero basis
            // still caps it at leftover space and forces a scrollbar INSIDE a
            // scrolling region, which is the nested-scrollbar bug elsewhere.
            className="min-h-[220px] grow shrink-0 resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        ) : (
          <>
          {htmlSource !== null && (
            <HtmlSourceEditor
              value={htmlSource}
              onChange={onHtmlSourceChange}
              removed={removedCode}
              onDismissRemoved={() => setRemovedCode([])}
              hint={'Scripts, forms and <style> blocks are not kept, and most mail apps ignore them anyway. Style with style="…" on each element.'}
            />
          )}
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spell}
            data-placeholder="Write your message"
            onInput={() => {
              setBodyEdits((n) => n + 1);
              if (!aiReplacing.current) { setAiEdited(true); detectMention(); }
            }}
            onKeyDown={onEditorKeyDown}
            onPaste={onEditorPaste}
            // The popup is positioned at the caret; a scrolled editor moves
            // the caret out from under it, so close rather than drift.
            onScroll={() => setMention(null)}
            onBlur={() => setMention(null)}
            // No overflow of its own: the region above scrolls, and an
            // editor scrolling inside a scrolling pane is the nested
            // scrollbar we are also fixing in the reading pane.
            //
            // `grow shrink-0`, NOT `flex-1` — and the difference put lines of
            // text on top of the attachment chips. flex-1 is flex:1 1 0%: the
            // ZERO BASIS caps the editor's box at the space the column hands
            // it, so once the message grew past that, the text OVERFLOWED THE
            // BOX (contentEditable defaults to overflow visible) and painted
            // straight across everything below — while the DOM, and every
            // measurement of it, said the layout was perfectly stacked.
            // Amit typed "chips really are floating on top" INTO the spill to
            // prove it. grow with the default auto basis sizes the box to its
            // content, so the region scrolls instead of the text escaping;
            // shrink-0 stops the scroll container squashing it back.
            className={`composer-body min-h-[220px] grow shrink-0 px-4 py-3 text-sm leading-relaxed text-ink outline-none ${htmlSource !== null ? 'hidden' : ''}`}
            data-quote-open={showQuote ? '' : undefined}
          />
          </>
        )}

        {/* Gmail's "…": the quoted history is folded under a reply, not left
            out of it. Shown only while there is a folded quote to reveal. */}
        {!plain && replyTo && (mode === 'reply' || mode === 'replyAll') && (
          <div className="px-4 pb-2">
            <button
              type="button"
              onClick={() => setShowQuote((v) => !v)}
              title={showQuote ? 'Hide the quoted message' : 'Show the quoted message'}
              aria-expanded={showQuote}
              className="rounded-md bg-canvas px-2 py-0.5 text-xs font-bold leading-none tracking-widest text-ink-muted hover:bg-line hover:text-ink"
            >
              •••
            </button>
          </div>
        )}

        {/* The @-mention suggestions, at the caret. */}
        {mention && mentionHits.length > 0 && (
          <div
            className="fixed z-[1400] w-72 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-raised"
            style={{
              left: Math.min(mention.x, typeof window !== 'undefined' ? window.innerWidth - 300 : mention.x),
              top: mention.y + 4,
            }}
          >
            {mentionHits.map((p, i) => (
              <button
                key={p.email}
                type="button"
                // mousedown, not click: click fires after blur, and the blur
                // handler above would have closed the popup first.
                onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}
                onMouseEnter={() => setMentionIdx(i)}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                  i === mentionIdx ? 'bg-canvas text-ink' : 'text-ink-muted'
                }`}
              >
                <span className="shrink-0 font-medium text-ink">{p.name}</span>
                <span className="min-w-0 truncate text-xs">{p.email}</span>
              </button>
            ))}
          </div>
        )}

        {/* Attachment chips. shrink-0 so a long message cannot squash this
            row while the region scrolls — same reason as the editor above. */}
        {files.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-1 pt-2">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs"
              >
                <Icon name="attach" className="h-3.5 w-3.5 text-ink-faint" />
                <span className="max-w-[12rem] truncate">{f.name}</span>
                <span className="text-ink-muted">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="text-ink-faint hover:text-danger"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            <span className="text-[11px] text-ink-faint">{formatBytes(totalSize)} total</span>
          </div>
        )}

        {/* Space links. A separate row from the attachment chips on purpose:
            these are NOT on the message as files, they are links to the
            sender's own storage, and one row of identical chips would say
            they were the same thing. */}
        {links.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-1 pt-2">
            {links.map((l) => (
              <span
                key={l.fileId}
                className="flex items-center gap-2 rounded-lg border border-brand-400 px-2.5 py-1.5 text-xs"
              >
                <Icon name="link" className="h-3.5 w-3.5 text-brand-600" />
                <span className="max-w-[12rem] truncate">{l.name}</span>
                <span className="text-ink-muted">{formatBytes(l.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => setLinks((prev) => prev.filter((x) => x.fileId !== l.fileId))}
                  /* Takes it off THIS MESSAGE only. The file stays in their
                     Space, because deleting somebody's upload to undo a
                     compose-window decision is not a trade we get to make. */
                  aria-label={`Remove the link to ${l.name} from this message`}
                  title="Remove from this message. The file stays in your Space."
                  className="text-ink-faint hover:text-danger"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            <span className="text-[11px] text-ink-faint">
              sent as {links.length === 1 ? 'a link' : 'links'}, added when you send
            </span>
          </div>
        )}

        {/* The oversize offer. */}
        {offer !== null && (
          <div className="mx-4 my-2 rounded-lg border border-line bg-canvas p-3">
            {offer.free !== null && offer.file.size > offer.free ? (
              <>
                {/* The pre-check refusing BEFORE the upload. The whole point
                    of reading the allowance at attach time is that this
                    sentence arrives now and not after a long wait. */}
                <p className="mb-2 text-sm text-ink">
                  <span className="font-medium">{offer.file.name}</span> is{' '}
                  {formatBytes(offer.file.size)}, and you have {formatBytes(offer.free)} of
                  storage free — so it cannot be sent as a link either.
                </p>
                <p className="mb-3 text-xs text-ink-muted">
                  Your storage covers your mail and your files together. Empty your trash in
                  Space, or ask an administrator for more room.
                </p>
                <button
                  type="button"
                  onClick={dismissOffer}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-brand-400"
                >
                  Leave it out
                </button>
              </>
            ) : (
              <>
                {/* Two different problems wear the same offer, and saying the
                    wrong one is how you get "40 MB is over the limit" printed
                    beside a 1 KB file that simply had no room left. */}
                <p className="mb-2 text-sm text-ink">
                  {offer.file.size > MAX_TOTAL ? (
                    <>
                      <span className="font-medium">{offer.file.name}</span> is{' '}
                      {formatBytes(offer.file.size)} — over the {formatBytes(MAX_TOTAL)} limit
                      for files sent with a message.
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{offer.file.name}</span> will not fit —
                      this message is already carrying {formatBytes(totalSize)} of its{' '}
                      {formatBytes(MAX_TOTAL)}.
                    </>
                  )}
                </p>
                <p className="mb-3 text-xs text-ink-muted">
                  It can go to your Space instead, in the “Email attachments” folder, and the
                  message will carry a link anyone you send it to can open. The link stops
                  working after {LINK_EXPIRY_DAYS} days.
                </p>
                {parking ? (
                  /* A file this size takes minutes. A button that looks
                     pressed and nothing else is indistinguishable from broken,
                     and the second click is the one that makes it worse. */
                  <div className="flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all"
                        style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {Math.round((progress ?? 0) * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-danger hover:text-danger"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void parkOffered()}
                      className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-600"
                    >
                      Send as a link
                    </button>
                    <button
                      type="button"
                      onClick={dismissOffer}
                      className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-brand-400"
                    >
                      Leave it out
                    </button>
                  </div>
                )}
              </>
            )}
            {queue.length > 1 && (
              <p className="mt-2 text-[11px] text-ink-faint">
                {queue.length - 1} more {queue.length - 1 === 1 ? 'file' : 'files'} after this one.
              </p>
            )}
          </div>
        )}

            {/* Said where the attachments are, not in a help page. Someone who
                minimises believing the file was kept has lost work, and they
                will not find out until they reopen the draft. */}
            {onSaveDraft && files.length > 0 && (
              <p className="px-4 pb-1 text-[11px] text-warn">
                Attachments are not saved with a draft — they stay in this window
                and are only included if you send now.
                {links.length > 0 && ' Files sent as links are already in your Space and do survive.'}
              </p>
            )}
        </div>
        {/* ---- end of the scrolling region; what follows is pinned ---- */}

        {error && (
          <div className="border-t border-line bg-danger/5 px-4 py-2 text-sm text-danger">{error}</div>
        )}

        {aiAvailable && htmlSource === null && (
          <HelpMeWritePanel
            open={aiOpen}
            onClose={() => setAiOpen(false)}
            readDraft={aiReadDraft}
            replace={aiReplace}
            undo={aiUndo}
            editedSinceReplace={aiEdited}
            refuseReason={aiRefuseReason}
          />
        )}

        {/* Formatting options (FormatBar explains why a row of its own). Kept
            on screen while the HTML view is open, because its </> button is
            the way back out of it. */}
        {!plain && (showFormat || htmlSource !== null) && (
          <FormatBar
            onCommand={cmd}
            onSize={applyFontSize}
            onPicture={openPicturePicker}
            htmlMode={htmlSource !== null}
            onToggleHtml={toggleHtml}
          />
        )}

        {/* Toolbar
            WRAPS, and it has to. Fourteen controls in a nowrap row measure
            385px; the composer on a 375px phone is 355px wide. Measured 8 Sept
            2026: the row overflowed by 30px and the button pushed off the edge
            was DISCARD — the destructive one, half-visible, at the exact spot a
            thumb reaches for. Wrapping puts it on a second line where it can be
            seen before it is pressed.

            flex-wrap only; no horizontal scroll. A toolbar you have to scroll
            hides controls behind a gesture nobody is told about, which is how
            "the app has no reply button" support tickets happen. */}
        <div className="relative flex flex-wrap items-center gap-0.5 gap-y-1.5 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={handleSend}
            /* Sending while a file is still uploading would post the message
               without the link that was about to be added to it. */
            disabled={sending || parking || !to.trim()}
            className="mr-1 flex items-center gap-2 rounded-full bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
            {!sending && <Icon name="send" className="h-4 w-4" />}
          </button>

          <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" />

          {!plain && (
            <>
              <ToolBtn label={showFormat ? 'Hide formatting options' : 'Formatting options'} onClick={toggleFormatBar}>
                <span className="text-[13px] font-semibold underline decoration-2 underline-offset-2">Aa</span>
              </ToolBtn>
              <ToolBtn label="Insert link" onClick={addLink}><Icon name="link" className="h-4 w-4" /></ToolBtn>
            </>
          )}
          <ToolBtn label="Attach files" onClick={() => fileRef.current?.click()}><Icon name="attach" className="h-4 w-4" /></ToolBtn>
          <span ref={emojiBtnRef} className="inline-flex">
            <ToolBtn label="Emoji" onClick={() => setEmoji((v) => !v)}><Icon name="emoji" className="h-4 w-4" /></ToolBtn>
          </span>
          {/* Not in the HTML view: there the rich editor is hidden and stale,
              and Help me write reads the editor, not the source being edited. */}
          {aiAvailable && htmlSource === null && <HelpMeWriteButton open={aiOpen} onToggle={() => setAiOpen((v) => !v)} />}

          {/* Drive, Schedule send and Confidential are not backed by a product
              yet. They sat here as three greyed icons until 21 Sept 2026, when
              they pushed Discard onto a second line at the composer's normal
              560px width (Amit: "fix the ui"). They are in More, marked soon. */}

          <div className="relative ml-auto" ref={moreRef}>
            <ToolBtn label="More options" onClick={() => setMore((v) => !v)}><Icon name="more" className="h-4.5 w-4.5" /></ToolBtn>
            {more && (
              <div className="absolute bottom-11 right-0 z-10 w-64 rounded-xl border border-line bg-surface py-2 text-sm shadow-raised">
                <MenuItem icon="expand" label={pane === 'full' ? 'Exit full screen' : 'Full screen'} onClick={() => { setPane(pane === 'full' ? 'docked' : 'full'); setMore(false); }} />
                <MenuItem icon="draft" label="Plain text mode" trailing={plain ? 'on' : undefined} onClick={() => { leaveHtmlQuietly(); setPlain((v) => !v); setMore(false); }} />
                <MenuItem icon="print" label="Print" onClick={() => { window.print(); setMore(false); }} />
                <MenuItem icon="spellcheck" label="Spell check" trailing={spell ? 'on' : 'off'} onClick={() => { setSpell((v) => !v); setMore(false); }} />
                <div className="my-1 border-t border-line" />
                <MenuItem icon="drive" label="Insert from Drive" soon />
                <MenuItem icon="clock" label="Schedule send" soon />
                <MenuItem icon="lock" label="Confidential mode" soon />
                <MenuItem icon="envelope" label="Request read receipt" soon />
                <MenuItem icon="bookmark" label="Label" soon />
                <MenuItem icon="draft" label="Templates" soon />
              </div>
            )}
          </div>

          <ToolBtn label="Discard" onClick={onClose}><Icon name="trash" className="h-4 w-4" /></ToolBtn>

          {emoji && (
            <div ref={emojiPopRef} className="absolute bottom-12 left-3 z-10 flex w-64 flex-wrap gap-1 rounded-xl border border-line bg-surface p-2 text-xl shadow-raised">
              {EMOJI.map((e) => (
                <button key={e} type="button" onClick={() => insertEmoji(e)} className="rounded p-1 hover:bg-canvas">
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

            <input
              ref={pictureRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void insertPictures(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function ToolBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition ${
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-canvas hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon,
  label,
  trailing,
  soon,
  onClick,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  trailing?: string;
  soon?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={soon}
      title={soon ? 'Coming with a later update' : undefined}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
        soon ? 'cursor-not-allowed text-ink-faint' : 'text-ink hover:bg-canvas'
      }`}
    >
      <Icon name={icon} className="h-4 w-4 text-ink-muted" />
      <span className="flex-1">{label}</span>
      {trailing && <span className="text-[11px] font-medium text-brand-600">{trailing}</span>}
      {soon && <span className="text-[10px] uppercase tracking-wide">soon</span>}
    </button>
  );
}
