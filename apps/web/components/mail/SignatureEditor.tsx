'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cleanPastedHtml } from '@/lib/pasteHtml';
import { cleanSignatureHtml } from '@/lib/signatureHtml';

/**
 * The signature editor.
 *
 * ── WHY THIS REPLACED A TEXTAREA (Amit, 23 September 2026) ─────────────
 *
 *  A customer sent a picture of the signature they wanted: their name and
 *  title in the company green, a mobile and an email row, the website, the
 *  company logo to the right of it all, and the registered address in small
 *  type underneath.
 *
 *  None of that could be typed into what was here — a plain <textarea>
 *  escaped through toHtml() on save, which turned every < into &lt; and
 *  every newline into <br>. The STORAGE was never the limitation: the API
 *  keeps whatever HTML it is handed and the composer renders it (that is
 *  how the picture above was reproduced for testing, by PUTting the HTML
 *  directly). The editor was the whole of the gap.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────
 *
 *  UPLOAD A LOGO. An image has to be reachable by the RECIPIENT'S mail
 *  client, from their machine, days later — so it needs a public https URL,
 *  and the rows that would hold an uploaded one are behind tenant RLS that
 *  a public unauthenticated endpoint cannot read. Making that work is a
 *  tenancy decision, not a UI one, so this version takes an address for an
 *  image the company already publishes (every company logo in a signature
 *  is one) and the upload is a separate, named piece of work.
 *
 *  A data: URI would let someone paste an image straight in and would look
 *  perfect in our own preview — and Gmail strips it, Outlook blocks it. The
 *  sender would see their logo and the recipient a gap. cleanSignatureHtml
 *  refuses data: for that reason, not by oversight.
 *
 * ── execCommand ───────────────────────────────────────────────────────
 *
 *  Deprecated, and still the only thing every browser implements for rich
 *  editing of a contenteditable. Composer.tsx made the same call for the
 *  same reason; when that changes, both change together.
 *
 *  styleWithCSS is turned ON so colour and size come out as inline style
 *  rather than <font> tags. Inline style is what mail clients keep — a
 *  <style> block is stripped by most of them, and <font> is fine but says
 *  nothing about which colours it is safe to override.
 */

/** Colours offered as swatches. Anything else is the picker beside them. */
const SWATCHES: { value: string; label: string }[] = [
  { value: '#111827', label: 'Near-black' },
  { value: '#6b7280', label: 'Grey' },
  { value: '#0a6b3d', label: 'Green' },
  { value: '#1a73e8', label: 'Blue' },
  { value: '#b91c1c', label: 'Red' },
  { value: '#7c3aed', label: 'Purple' },
];

/**
 * Sizes, as execCommand's 1-7 scale.
 *
 * Named for what they are FOR rather than in points, because the person
 * choosing is writing a signature, not setting type.
 */
const SIZES: { value: string; label: string }[] = [
  { value: '1', label: 'Very small' },
  { value: '2', label: 'Small' },
  { value: '3', label: 'Normal' },
  { value: '4', label: 'Large' },
  { value: '5', label: 'Heading' },
];

/**
 * The editor's own CSS. One template literal — NO BACKTICKS below, including
 * in comments, or the string closes and the build dies on the next line.
 */
const EDITOR_CSS = `
.sig-editor:empty::before {
  content: "Your name, role, phone — anything you want at the bottom of your messages.";
  color: var(--ink-faint, #9ca3af);
  pointer-events: none;
}
.sig-editor a { color: #1a73e8; }
.sig-editor img { max-width: 100%; }
`;

export default function SignatureEditor({
  html,
  onChange,
  disabled,
}: {
  html: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('https://');
  const [imageWidth, setImageWidth] = useState('120');
  const [imageAlt, setImageAlt] = useState('');
  const [imageError, setImageError] = useState<string | null>(null);

  /**
   * Seeding, once.
   *
   * A contenteditable whose innerHTML is driven by React state fights the
   * caret: every keystroke re-renders, the DOM is replaced, and the cursor
   * jumps to the start. So the editor owns its own DOM after mount and only
   * reports upwards. `html` is read here for the initial value and when it
   * changes from OUTSIDE (loading the saved signature, or applying a
   * sample) — never on our own edits, which is what the ref guard is for.
   */
  const lastPushed = useRef<string | null>(null);
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (html === lastPushed.current) return;
    lastPushed.current = html;
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [html]);

  function report() {
    const el = editorRef.current;
    if (!el) return;
    lastPushed.current = el.innerHTML;
    onChange(el.innerHTML);
  }

  function cmd(command: string, value?: string) {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // Colour and size as inline style rather than <font>. Set every time:
    // it is per-document state and a different editor on the page can have
    // turned it off.
    try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* not fatal */ }
    document.execCommand(command, false, value);
    report();
  }

  function addLink() {
    const url = window.prompt('Link address', 'https://');
    if (!url) return;
    // A bare address with no scheme becomes a relative link inside the
    // webmail, which is broken in a way nobody notices until a recipient
    // clicks it.
    const href = /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`;
    cmd('createLink', href);
  }

  function insertImage() {
    setImageError(null);

    const url = imageUrl.trim();
    if (!/^https:\/\/\S+$/i.test(url)) {
      setImageError('The address has to start with https:// — a plain http image is blocked by most mail clients.');
      return;
    }

    const width = Number(imageWidth);
    const w = Number.isFinite(width) && width > 0 && width <= 600 ? Math.round(width) : 120;

    // width as an ATTRIBUTE as well as a style: Outlook ignores the style on
    // an img often enough that the attribute is the one that holds.
    const alt = imageAlt.trim().replace(/"/g, '&quot;');
    const tag = `<img src="${url.replace(/"/g, '&quot;')}" alt="${alt}" width="${w}" style="width:${w}px;height:auto;display:inline-block;border:0" />`;

    const el = editorRef.current;
    if (el) {
      el.focus();
      document.execCommand('insertHTML', false, tag);
      report();
    }

    setImageOpen(false);
    setImageUrl('https://');
    setImageAlt('');
  }

  /**
   * Paste.
   *
   * The same cleaner the composer uses (that one allows data: images, which
   * cleanSignatureHtml then drops on save — so a pasted screenshot appears
   * while editing and is gone when saved). That is the one rough edge here,
   * and it is better than the alternative: silently sending a logo that
   * half the world cannot see.
   */
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const raw = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const clean = raw ? cleanPastedHtml(raw) : '';
    if (clean) document.execCommand('insertHTML', false, clean);
    else document.execCommand('insertText', false, text);
    report();
  }

  return (
    <div className="rounded-md border border-line bg-surface">
      {/* ---- Toolbar ------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
        <Tool label="Bold" onClick={() => cmd('bold')} disabled={disabled}>
          <span className="text-[15px] font-bold">B</span>
        </Tool>
        <Tool label="Italic" onClick={() => cmd('italic')} disabled={disabled}>
          <span className="text-[15px] italic">I</span>
        </Tool>
        <Tool label="Underline" onClick={() => cmd('underline')} disabled={disabled}>
          <span className="text-[15px] underline">U</span>
        </Tool>

        <Divider />

        <select
          aria-label="Text size"
          title="Text size"
          disabled={disabled}
          defaultValue="3"
          onChange={(e) => cmd('fontSize', e.target.value)}
          className="h-8 rounded-lg bg-transparent px-1.5 text-sm text-ink-muted outline-none transition hover:bg-canvas hover:text-ink disabled:opacity-40"
        >
          {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        <Divider />

        {SWATCHES.map((s) => (
          <button
            key={s.value}
            type="button"
            disabled={disabled}
            title={`Colour: ${s.label}`}
            aria-label={`Colour: ${s.label}`}
            onClick={() => cmd('foreColor', s.value)}
            className="h-5 w-5 rounded-full border border-line transition hover:scale-110 disabled:opacity-40"
            style={{ backgroundColor: s.value }}
          />
        ))}
        <label className="ml-0.5 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition hover:bg-canvas hover:text-ink">
          <span className="sr-only">Any other colour</span>
          <span aria-hidden className="text-[15px]">＋</span>
          <input
            type="color"
            disabled={disabled}
            title="Any other colour"
            onChange={(e) => cmd('foreColor', e.target.value)}
            className="sr-only"
          />
        </label>

        <Divider />

        <Tool label="Bullet list" onClick={() => cmd('insertUnorderedList')} disabled={disabled}>
          <Icon name="list-ul" className="h-4 w-4" />
        </Tool>
        <Tool label="Numbered list" onClick={() => cmd('insertOrderedList')} disabled={disabled}>
          <Icon name="list-ol" className="h-4 w-4" />
        </Tool>
        <Tool label="Insert link" onClick={addLink} disabled={disabled}>
          <Icon name="link" className="h-4 w-4" />
        </Tool>
        <Tool label="Insert image" onClick={() => setImageOpen((v) => !v)} disabled={disabled}>
          <Icon name="image" className="h-4 w-4" />
        </Tool>

        <Divider />

        <Tool label="Align left" onClick={() => cmd('justifyLeft')} disabled={disabled}>
          <Bars widths={['w-4', 'w-2.5', 'w-4', 'w-2.5']} />
        </Tool>
        <Tool label="Centre" onClick={() => cmd('justifyCenter')} disabled={disabled}>
          <Bars widths={['w-4', 'w-2.5', 'w-4', 'w-2.5']} centre />
        </Tool>

        <Tool label="Clear formatting" onClick={() => cmd('removeFormat')} disabled={disabled}>
          <span className="text-[13px] font-medium">Tx</span>
        </Tool>
      </div>

      {/* ---- Insert-image form --------------------------------------- */}
      {imageOpen && (
        <div className="border-b border-line bg-canvas px-3 py-3">
          <p className="mb-2 text-xs text-ink-muted">
            The address of an image that is already on the web — your company logo on your
            own website is the usual one. It has to be reachable by whoever receives the
            mail, so a file on your computer will not work here.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[16rem] flex-1">
              <span className="mb-1 block text-xs font-medium text-ink">Image address</span>
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://www.example.com/logo.png"
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-brand-400"
              />
            </label>
            <label className="w-40">
              <span className="mb-1 block text-xs font-medium text-ink">Describe it</span>
              <input
                value={imageAlt}
                onChange={(e) => setImageAlt(e.target.value)}
                placeholder="Techvein"
                title="Shown in place of the image if it cannot load, and read aloud by screen readers."
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-brand-400"
              />
            </label>
            <label className="w-24">
              <span className="mb-1 block text-xs font-medium text-ink">Width</span>
              <input
                value={imageWidth}
                onChange={(e) => setImageWidth(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-brand-400"
              />
            </label>
            <button
              type="button"
              onClick={insertImage}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-600"
            >
              Insert
            </button>
            <button
              type="button"
              onClick={() => { setImageOpen(false); setImageError(null); }}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-brand-400"
            >
              Cancel
            </button>
          </div>
          {imageError && <p className="mt-2 text-xs text-danger">{imageError}</p>}
        </div>
      )}

      {/* ---- The editor ---------------------------------------------- */}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Your signature"
        data-testid="signature-editor"
        onInput={report}
        onBlur={report}
        onPaste={onPaste}
        className="sig-editor scroll-thin min-h-[10rem] w-full resize-y overflow-auto px-3 py-2.5 text-sm text-ink outline-none"
      />

      {/* The placeholder is CSS rather than state: a contenteditable that
          React fills and empties fights the caret (see the seeding note).
          A plain <style> element with a string child, the same way
          RoomChrome does it — dangerouslySetInnerHTML is an eslint error
          here, and styled-jsx is used nowhere else in this app. */}
      <style>{EDITOR_CSS}</style>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-line" />;
}

/** Four short bars, as an alignment glyph. No icon library for two icons. */
function Bars({ widths, centre }: { widths: string[]; centre?: boolean }) {
  return (
    <span className={`flex w-4 flex-col gap-[3px] ${centre ? 'items-center' : 'items-start'}`}>
      {widths.map((w, i) => <span key={i} className={`h-[2px] ${w} rounded-full bg-current`} />)}
    </span>
  );
}

function Tool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // The editor loses its selection the moment a button takes focus, and
      // with it the words the person meant to make bold.
      onMouseDown={(e) => e.preventDefault()}
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

/** Exported for the settings page's preview, so both render it identically. */
export function signaturePreviewHtml(html: string): string {
  return cleanSignatureHtml(html);
}
