import DOMPurify from 'dompurify';
import { BANNED_CSS } from './pasteHtml';

/**
 * HTML someone TYPED into the composer's HTML editor, made safe to put back
 * into the editor — and so, safe to send.
 *
 * ── WHY NOT cleanPastedHtml ─────────────────────────────────────────────
 *  The composer sends the editor's innerHTML as it stands; it is safe only
 *  because everything that enters the editor is cleaned on the way in (paste,
 *  signature, quote). The HTML editor is a new way in, so it must be cleaned
 *  too — but the paste cleaner is the wrong allowlist for it. It has no
 *  <font>, and the browser's own size and colour commands write <font>
 *  (Chrome, 25 Sept 2026): round-tripping a message through the HTML view
 *  would have erased the formatting just applied with the toolbar. And
 *  hand-written email HTML is table layout — width, align, bgcolor,
 *  cellpadding — which the paste cleaner strips.
 *
 *  So: the paste cleaner's security rules (no script, no frames, no event
 *  handlers, no layout-hijacking CSS — the SAME BANNED_CSS list, imported),
 *  with email's presentational vocabulary allowed on top.
 *
 * ── IT SAYS WHAT IT REMOVED ─────────────────────────────────────────────
 *  Somebody who types <style> or onclick into an HTML editor and sees it
 *  vanish without a word will assume the editor is broken. `removed` names
 *  each kind of thing that was taken out, so the editor can say so.
 *
 * ── ITS OWN DOMPurify INSTANCE ──────────────────────────────────────────
 *  Hooks are global to an instance; a shared instance let the signature
 *  cleaner delete images from composer pastes until 25 Sept 2026. See the
 *  note in lib/pasteHtml.ts.
 */

/** Raster types only. An SVG can carry script; it has no business in mail. */
const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

/** Email's presentational attributes. VALUES, not addresses — see below. */
const PRESENTATIONAL = [
  'width', 'height', 'align', 'valign', 'bgcolor', 'border',
  'cellpadding', 'cellspacing', 'color', 'face', 'size',
  'colspan', 'rowspan', 'target', 'rel',
];

let purify: ReturnType<typeof DOMPurify> | null = null;
/** Filled by the hook during one clean() call; null between calls. */
let collecting: Set<string> | null = null;

function instance(): ReturnType<typeof DOMPurify> {
  if (purify) return purify;
  purify = DOMPurify(window);

  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;

    for (const a of ['class', 'id', 'srcset', 'sizes']) {
      if (el.hasAttribute(a)) { el.removeAttribute(a); collecting?.add(`${a}="…"`); }
    }

    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      // A picture whose address was refused (src="x", javascript:…) is left
      // as an <img> with no src — a broken-image box in the recipient's mail.
      // Measured 25 Sept 2026. The whole element goes, and the notice says so.
      if (!src.trim()) {
        el.remove(); collecting?.add('a picture with no usable address');
        return;
      }
      // DOMPurify lets ANY data: through on <img> (its DATA_URI_TAGS skip the
      // URI regexp), so the raster-only rule has to be enforced here.
      if (/^\s*data:/i.test(src) && !RASTER_DATA.test(src.trim())) {
        el.remove(); collecting?.add('an embedded image that is not PNG, JPEG, GIF or WebP');
        return;
      }
    }

    const style = el.getAttribute('style');
    if (!style) return;
    const kept = style.split(';').map((d) => d.trim()).filter((d) => {
      const name = d.split(':')[0]?.trim().toLowerCase();
      if (!name) return false;
      const banned = BANNED_CSS.some((b) => name === b || name.startsWith(`${b}-`));
      if (banned) collecting?.add(`style: ${name}`);
      return !banned;
    });
    if (kept.length === 0) el.removeAttribute('style');
    else el.setAttribute('style', kept.join('; '));
  });

  return purify;
}

/**
 * DOMPurify lists its OWN document wrapper in `removed` — measured 25 Sept
 * 2026: every clean reported "<body>", so the HTML view, which stays open
 * while anything was removed, could never be left. Their contents are always
 * kept; only the wrapper goes, and nobody typed it.
 */
const WRAPPERS = new Set(['HTML', 'HEAD', 'BODY']);

export interface CleanResult {
  html: string;
  /** Human-readable kinds of thing removed, e.g. "<script>", "onclick". Empty if nothing. */
  removed: string[];
}

export function cleanComposeHtml(html: string): CleanResult {
  const p = instance();
  collecting = new Set<string>();
  try {
    const out = p.sanitize(html, {
      ALLOWED_TAGS: [
        'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark',
        'sub', 'sup', 'small', 'big', 'br', 'p', 'div', 'span', 'font', 'center',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr',
      ],
      ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'style', ...PRESENTATIONAL],
      // DOMPurify tests EVERY attribute value not on its URI-safe list
      // against ALLOWED_URI_REGEXP — so without this, width="600" fails the
      // scheme test and is silently dropped. (lib/signatureHtml.ts hit the
      // same thing; its NOT_URIS is this list's twin.)
      ADD_URI_SAFE_ATTR: PRESENTATIONAL,
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i,
    }).trim();

    for (const r of p.removed as Array<{ element?: Node; attribute?: Attr | null }>) {
      if (r.attribute) collecting.add(r.attribute.name);
      else if (r.element && r.element.nodeType === 1 && !WRAPPERS.has(r.element.nodeName)) {
        collecting.add(`<${r.element.nodeName.toLowerCase()}>`);
      }
    }
    return { html: out, removed: [...collecting] };
  } finally {
    collecting = null;
  }
}

/**
 * innerHTML on more than one line, for reading in an HTML editor. A newline
 * goes only BEFORE A BLOCK TAG that directly follows another tag: whitespace
 * there is not rendered, so the message looks exactly the same afterwards.
 * Between inline tags a newline would render as a space, so they are left.
 */
const BLOCK = 'p|div|br|table|caption|colgroup|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|blockquote|hr|pre|center';
const BEFORE_BLOCK = new RegExp(`>\\s*<(/?(?:${BLOCK})\\b)`, 'gi');

export function formatHtmlSource(html: string): string {
  return html.replace(BEFORE_BLOCK, '>\n<$1').trim();
}
