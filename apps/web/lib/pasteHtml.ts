import DOMPurify from 'dompurify';

/**
 * Cleaning HTML on its way INTO the composer.
 *
 * ── THE BUG THIS EXISTS FOR (Amit, 23 September 2026) ───────────────────
 *
 *  He copied a Google search result and pasted it into a new message. The
 *  text arrived UPSIDE DOWN — mirrored, unreadable, and it would have been
 *  sent that way.
 *
 *  The composer had no paste handler at all, so the browser did what a
 *  contenteditable does by default: inserted the clipboard's text/html
 *  verbatim, inline styles and all. Google's result markup carries CSS the
 *  page uses for its own layout (and, on some surfaces, deliberately to
 *  frustrate scraping) — a transform is enough to flip the lot.
 *
 *  ── WHY NOT JUST PASTE PLAIN TEXT ──────────────────────────────────────
 *
 *  Because people paste tables, links and formatted quotes on purpose, and
 *  a composer that flattens everything is its own complaint. So the
 *  formatting survives and the LAYOUT CONTROL does not: bold, italic,
 *  links, lists and colour come through; anything that can move, rotate,
 *  reflow or position content is dropped.
 *
 *  ── AND WHY IT IS A SAFETY FIX, NOT ONLY A COSMETIC ONE ────────────────
 *
 *  Whatever is pasted is what gets SENT. Unsanitised clipboard HTML in an
 *  outgoing message means a sender can be made to mail markup they never
 *  saw — script tags, iframes, or a block of text positioned over another.
 *  DOMPurify does the first half; the CSS blocklist below does the second,
 *  because a <span> is harmless and `position:fixed` on it is not.
 */

/**
 * CSS properties dropped from pasted content.
 *
 * Every one of these can make text unreadable or make it lie about where it
 * is. `transform` is the one that produced the upside-down paste; the rest
 * are the same class of thing and are removed for the same reason rather
 * than waiting to be reported one at a time.
 */
const BANNED_CSS = [
  'transform', 'rotate', 'scale', 'translate', 'perspective',
  'writing-mode', 'text-orientation', 'direction', 'unicode-bidi',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'float', 'clip', 'clip-path', 'zoom', 'filter', 'mix-blend-mode',
  'animation', 'transition', 'content', 'visibility', 'opacity',
];

/** Attributes that carry someone else's stylesheet into our page. */
const BANNED_ATTRS = ['class', 'id', 'srcset', 'sizes'];

let hooked = false;

/**
 * Registers the CSS scrub once. DOMPurify keeps hooks globally, so adding
 * this on every paste would stack handlers and slow each one down.
 */
function ensureHook(): void {
  if (hooked) return;
  hooked = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;

    BANNED_ATTRS.forEach((a) => el.removeAttribute(a));

    const style = el.getAttribute('style');
    if (!style) return;

    // Rebuilt rather than regex-replaced: a declaration can carry quotes,
    // urls and semicolons of its own, and a regex over the whole string
    // gets those wrong in ways that leave half a rule behind.
    const kept = style
      .split(';')
      .map((d) => d.trim())
      .filter((d) => {
        const name = d.split(':')[0]?.trim().toLowerCase();
        if (!name) return false;
        return !BANNED_CSS.some((banned) => name === banned || name.startsWith(`${banned}-`));
      });

    if (kept.length === 0) el.removeAttribute('style');
    else el.setAttribute('style', kept.join('; '));
  });
}

/**
 * Pasted HTML, safe to insert into the composer.
 *
 * Returns an empty string when nothing survives, so the caller can fall
 * back to the plain-text flavour of the clipboard rather than inserting a
 * blank.
 */
export function cleanPastedHtml(html: string): string {
  ensureHook();

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr',
    ],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'style', 'colspan', 'rowspan', 'target', 'rel'],
    // A data: image is how most clients paste a screenshot; anything else
    // with a scheme we do not know has no business in a message body.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
  }).trim();
}
