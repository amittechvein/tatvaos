'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@tatvaos/core';
import type { Message } from '@tatvaos/types';
import { Icon } from '../ui/Icon';

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
  onClose,
  onSend,
}: {
  replyTo?: Message | null;
  mode?: ComposeMode;
  /** The current mailbox address, so reply-all does not Cc yourself. */
  selfAddress?: string;
  fromAddress: string;
  onClose: () => void;
  onSend: (draft: {
    to: string[];
    cc?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    files?: File[];
  }) => Promise<unknown>;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);

  const [to, setTo] = useState(mode === 'forward' ? '' : replyTo ? replyTo.from.email : '');
  const initialCc = mode === 'replyAll' ? replyAllCc(replyTo, selfAddress) : '';
  const [cc, setCc] = useState(initialCc);
  const [showCc, setShowCc] = useState(initialCc.length > 0);
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
    if (seeded.current || plain) return;
    if (mode === 'forward' && replyTo && editorRef.current) {
      editorRef.current.innerHTML = quotedHtml(replyTo);
      seeded.current = true;
    }
  }, [mode, replyTo, plain]);

  const totalSize = files.reduce((n, f) => n + f.size, 0);

  const minimised = pane === 'min';

  return (
    <>
      {/* Only full screen dims the mailbox. A docked composer that greyed out
          everything behind it would be a modal wearing a corner panel's clothes. */}
      {pane === 'full' && <div className="fixed inset-0 z-40 bg-black/40" aria-hidden="true" />}

      <div
        className={
          pane === 'full'
            ? 'fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6'
            : 'fixed inset-x-0 bottom-0 z-50 flex justify-center sm:inset-x-auto sm:right-5 sm:justify-end'
        }
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
                onClick={(e) => { e.stopPropagation(); setPane(minimised ? 'docked' : 'min'); }}
                aria-label={minimised ? 'Restore' : 'Minimise'}
                title={minimised ? 'Restore' : 'Minimise'}
                className="rounded p-1 text-rail-text hover:text-white"
              >
                <Icon name={minimised ? 'expand' : 'minimise'} className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPane(pane === 'full' ? 'docked' : 'full'); }}
                aria-label={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                title={pane === 'full' ? 'Exit full screen' : 'Full screen'}
                className="rounded p-1 text-rail-text hover:text-white"
              >
                <Icon name={pane === 'full' ? 'collapse' : 'expand'} className="h-4 w-4" />
              </button>
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
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Recipients — commas for several"
              className="w-full border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
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
            <label className="flex items-center gap-2 border-b border-line py-2.5 text-sm transition-colors focus-within:border-brand-500">
              <span className="w-12 shrink-0 text-ink-muted">Cc</span>
              <input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="name@example.com"
                className="w-full border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-faint"
              />
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
            className="composer-body scroll-thin min-h-[220px] flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-ink outline-none"
          />
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
          <ToolBtn label="Emoji" onClick={() => setEmoji((v) => !v)}><Icon name="emoji" className="h-4 w-4" /></ToolBtn>

          {/* Not yet backed by a product — disabled, with the reason on hover. */}
          <ToolBtn label="Insert from Drive — needs the Drive product" disabled><Icon name="drive" className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Schedule send — needs a server-side queue" disabled><Icon name="clock" className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Confidential mode — needs expiry/passcode support" disabled><Icon name="lock" className="h-4 w-4" /></ToolBtn>

          <div className="relative ml-auto">
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
            <div className="absolute bottom-12 left-3 z-10 flex w-64 flex-wrap gap-1 rounded-xl border border-line bg-surface p-2 text-xl shadow-raised">
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
