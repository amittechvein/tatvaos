'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';
import { ContactPicker } from '@/components/family/ContactPicker';
import { useAuth } from '@/lib/auth';

/** Comma- or semicolon-separated addresses → a clean list. */
function splitAddresses(raw: string): string[] {
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

const MAX_TOTAL = 26_214_400; // 25 MB, matches the server gate
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

function quotedHtml(m: Message): string {
  const when = new Date(m.sentAt).toLocaleString();
  const inner = m.bodyHtml ?? (m.bodyText ?? m.snippet).replace(/\n/g, '<br>');
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;color:#666">`
    + `On ${when}, ${m.from.name ?? m.from.email} &lt;${m.from.email}&gt; wrote:<br>${inner}</div>`;
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
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);

  const [to, setTo] = useState(mode === 'forward' ? '' : replyTo ? replyTo.from.email : '');
  const initialCc = mode === 'replyAll' ? replyAllCc(replyTo, selfAddress) : '';
  const [cc, setCc] = useState(initialCc);
  const [showCc, setShowCc] = useState(initialCc.length > 0);
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
  const { authedFetch } = useAuth();
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
  const [subject, setSubject] = useState(() => {
    if (!replyTo) return '';
    const base = replyTo.subject;
    if (mode === 'forward') return base.match(/^fwd:/i) ? base : `Fwd: ${base}`;
    return base.match(/^re:/i) ? base : `Re: ${base}`;
  });
  const [files, setFiles] = useState<File[]>([]);
  const [pane, setPane] = useState<PaneState>('docked');
  const [plain, setPlain] = useState(false);
  const [spell, setSpell] = useState(true);
  const [more, setMore] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plainBody, setPlainBody] = useState('');

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
  function cmd(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
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

  function onPickFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    const total = next.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL) {
      setError('Attachments would push the message over the 25 MB limit.');
      return;
    }
    setError(null);
    setFiles(next);
  }

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      const bodyText = plain ? plainBody : (editorRef.current?.innerText ?? '');
      const bodyHtml = plain ? undefined : (editorRef.current?.innerHTML || undefined);
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
    if (seeded.current) return;

    // Whether the signature applies at all. `enabled` is the master switch;
    // `includeOnReply` is asked separately because most people want a signature
    // on a new message and not on the fourth reply in a thread.
    const withSig = Boolean(signature?.enabled && (mode === 'new' || signature.includeOnReply));

    if (plain) {
      if (!withSig || !signature) return;
      // Functional update so an already-typed body is never overwritten — this
      // effect re-runs on a mode change, and the body may not be empty by then.
      setPlainBody((b) => (b.trim() === '' ? `\n\n${signature.bodyText}` : b));
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
    const sig = withSig && signature ? `<br><br>${signature.bodyHtml}` : '';
    const quote = mode === 'forward' && replyTo ? quotedHtml(replyTo) : '';
    if (!sig && !quote) return;

    el.innerHTML = sig + quote;
    seeded.current = true;
  }, [mode, replyTo, plain, signature]);

  /** Current contents, in the shape autosave and send both want. */
  function draftFields(): DraftFields {
    const el = editorRef.current;
    return {
      to, cc, bcc, subject,
      bodyText: plain ? plainBody : (el?.innerText ?? ''),
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

  const minimised = pane === 'min';

  return (
    <>
      {/* Only full screen dims the mailbox. A docked composer that greyed out
          everything behind it would be a modal wearing a corner panel's clothes. */}
      {pane === 'full' && <div className="fixed inset-0 z-[1190] bg-black/40" aria-hidden="true" />}

      <div
        className={
          pane === 'full'
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
        style={pane === 'full' ? undefined : { right: 20 + offset * 580 }}
      >
        <div
          className={`flex w-full flex-col overflow-hidden bg-surface shadow-raised ${
            pane === 'full'
              ? 'h-full max-w-5xl rounded-card'
              : minimised
                ? 'rounded-t-card sm:w-[360px]'
                : 'h-[78vh] rounded-t-card sm:h-[560px] sm:w-[560px]'
          }`}
        >
          {/* Title bar. While minimised the whole bar restores the draft — the
              collapsed strip is the only target left, so all of it should work. */}
          <header
            className={`flex items-center justify-between bg-rail px-4 py-2.5 text-white ${minimised ? 'cursor-pointer' : ''}`}
            onClick={minimised ? () => setPane('docked') : undefined}
          >
            <span className="truncate text-sm font-medium">
              {replyTo ? 'Reply' : 'New message'}
              {minimised && subject.trim() ? ` — ${subject.trim()}` : ''}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Minimising is the clearest "I am coming back to this" there
                  // is, so the draft is flushed rather than left to the timer.
                  if (!minimised) saveDraftNow();
                  setPane(minimised ? 'docked' : 'min');
                }}
                aria-label={minimised ? 'Restore' : 'Minimise'}
                title={minimised ? 'Restore' : 'Minimise'}
                className="rounded p-1 text-rail-text hover:text-white"
              >
                <Icon name={minimised ? 'expand' : 'minimise'} className="h-4 w-4" />
              </button>
              {/* Hidden while minimised: restore is the only sensible action
                  there, and next to it this button showed the SAME expand
                  icon — two identical icons doing different things. */}
              {!minimised && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setPane(pane === 'full' ? 'docked' : 'full'); }}
                  aria-label={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                  title={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                  className="rounded p-1 text-rail-text hover:text-white"
                >
                  <Icon name={pane === 'full' ? 'collapse' : 'expand'} className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                aria-label="Close"
                className="rounded p-1 text-rail-text hover:text-white"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            </div>
          </header>

          {!minimised && (
            <>

        {/* Recipients */}
        <div className="px-4">
          <div className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
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
          <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full border-0 bg-transparent p-0 text-sm font-medium text-ink outline-none placeholder:text-ink-faint"
            />
          </label>
        </div>

        {/* Body */}
        {plain ? (
          <textarea
            value={plainBody}
            onChange={(e) => setPlainBody(e.target.value)}
            spellCheck={spell}
            placeholder="Write your message"
            className="scroll-thin min-h-[220px] flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        ) : (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={spell}
            data-placeholder="Write your message"
            onInput={() => { setBodyEdits((n) => n + 1); detectMention(); }}
            onKeyDown={onEditorKeyDown}
            // The popup is positioned at the caret; a scrolled editor moves
            // the caret out from under it, so close rather than drift.
            onScroll={() => setMention(null)}
            onBlur={() => setMention(null)}
            className="composer-body scroll-thin min-h-[220px] flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-ink outline-none"
          />
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

        {/* Attachment chips */}
        {files.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-2">
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

            {/* Said where the attachments are, not in a help page. Someone who
                minimises believing the file was kept has lost work, and they
                will not find out until they reopen the draft. */}
            {onSaveDraft && files.length > 0 && (
              <p className="px-4 pb-1 text-[11px] text-warn">
                Attachments are not saved with a draft — they stay in this window
                and are only included if you send now.
              </p>
            )}

        {error && (
          <div className="border-t border-line bg-danger/5 px-4 py-2 text-sm text-danger">{error}</div>
        )}

        {/* Toolbar */}
        <div className="relative flex items-center gap-0.5 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !to.trim()}
            className="mr-1 flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
            {!sending && <Icon name="send" className="h-4 w-4" />}
          </button>

          <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" />

          {!plain && (
            <>
              <ToolBtn label="Bold" onClick={() => cmd('bold')}><span className="text-[15px] font-bold">B</span></ToolBtn>
              <ToolBtn label="Italic" onClick={() => cmd('italic')}><span className="text-[15px] italic">I</span></ToolBtn>
              <ToolBtn label="Underline" onClick={() => cmd('underline')}><span className="text-[15px] underline">U</span></ToolBtn>
              <ToolBtn label="Bullet list" onClick={() => cmd('insertUnorderedList')}><Icon name="list-ul" className="h-4 w-4" /></ToolBtn>
              <ToolBtn label="Numbered list" onClick={() => cmd('insertOrderedList')}><Icon name="list-ol" className="h-4 w-4" /></ToolBtn>
              <ToolBtn label="Insert link" onClick={addLink}><Icon name="link" className="h-4 w-4" /></ToolBtn>
            </>
          )}
          <ToolBtn label="Attach files" onClick={() => fileRef.current?.click()}><Icon name="attach" className="h-4 w-4" /></ToolBtn>
          <span ref={emojiBtnRef} className="inline-flex">
            <ToolBtn label="Emoji" onClick={() => setEmoji((v) => !v)}><Icon name="emoji" className="h-4 w-4" /></ToolBtn>
          </span>

          {/* Not yet backed by a product — disabled, with the reason on hover. */}
          <ToolBtn label="Insert from Drive — needs the Drive product" disabled><Icon name="drive" className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Schedule send — needs a server-side queue" disabled><Icon name="clock" className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Confidential mode — needs expiry/passcode support" disabled><Icon name="lock" className="h-4 w-4" /></ToolBtn>

          <div className="relative ml-auto" ref={moreRef}>
            <ToolBtn label="More options" onClick={() => setMore((v) => !v)}><Icon name="more" className="h-4.5 w-4.5" /></ToolBtn>
            {more && (
              <div className="absolute bottom-11 right-0 z-10 w-64 rounded-xl border border-line bg-surface py-2 text-sm shadow-raised">
                <MenuItem icon="expand" label={pane === 'full' ? 'Exit full screen' : 'Full screen'} onClick={() => { setPane(pane === 'full' ? 'docked' : 'full'); setMore(false); }} />
                <MenuItem icon="draft" label="Plain text mode" trailing={plain ? 'on' : undefined} onClick={() => { setPlain((v) => !v); setMore(false); }} />
                <MenuItem icon="print" label="Print" onClick={() => { window.print(); setMore(false); }} />
                <MenuItem icon="spellcheck" label="Spell check" trailing={spell ? 'on' : 'off'} onClick={() => { setSpell((v) => !v); setMore(false); }} />
                <div className="my-1 border-t border-line" />
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
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = '';
              }}
            />
            </>
          )}
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
