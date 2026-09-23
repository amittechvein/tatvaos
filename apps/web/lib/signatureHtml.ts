import DOMPurify from 'dompurify';

/**
 * The signature's HTML, on its way to the server and on its way back out.
 *
 * ── WHY A SIGNATURE NEEDS ITS OWN CLEANER ──────────────────────────────
 *
 *  cleanPastedHtml (lib/pasteHtml.ts) exists for the composer and is
 *  deliberately strict about layout: it drops width, alignment and table
 *  geometry because pasted page markup was arriving upside down.
 *
 *  A signature is the one place where that geometry is the POINT. The
 *  layout a company asks for — logo on the right of the text, a rule under
 *  it, the address in small grey type — is a two-column table with widths
 *  and alignment, and stripping those turns it into a stack of lines.
 *
 *  So this allows the presentational attributes that mail clients have
 *  understood for twenty years (width, height, align, valign, cellpadding,
 *  cellspacing, border, bgcolor) and keeps the whole of the CSS blocklist
 *  that pasteHtml applies, because `transform` and `position` are no more
 *  welcome here than in a pasted message.
 *
 * ── AND WHY IT RUNS ON THE WAY OUT, NOT ONLY ON THE WAY IN ─────────────
 *
 *  A signature belongs to a MAILBOX, not to a person (mail/settings says
 *  so on screen). A shared mailbox is edited by one colleague and then
 *  seeded into ANOTHER colleague's composer. That makes signature HTML the
 *  one piece of "your own content" in this app that is written by one user
 *  and rendered in a different user's session — which is the definition of
 *  stored XSS if it is trusted on render.
 *
 *  The API stores what it is given (MailEndpoints.SaveSignatureAsync caps
 *  the length and does not sanitise), so a cleaner that only ran in the
 *  editor would be a cleaner a crafted PUT walks straight past. Both ends,
 *  therefore: the editor cleans before saving, and the composer cleans
 *  before seeding.
 */

/**
 * CSS that can make a signature lie about where it is.
 *
 * Same list as lib/pasteHtml.ts, and deliberately a copy rather than an
 * import: that one is tuned to the composer's paste path and is free to
 * grow or shrink for reasons that have nothing to do with signatures.
 * Two short lists that each say why beat one shared list that has to serve
 * both — but if you add to one, read the other.
 */
const BANNED_CSS = [
  'transform', 'rotate', 'scale', 'translate', 'perspective',
  'writing-mode', 'text-orientation', 'direction', 'unicode-bidi',
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'clip', 'clip-path', 'zoom', 'filter', 'mix-blend-mode',
  'animation', 'transition', 'content', 'visibility', 'opacity',
];

/** Carries someone else's stylesheet into our page. */
const BANNED_ATTRS = ['class', 'id', 'srcset', 'sizes'];

/**
 * The presentational attributes, declared as NOT-A-URI.
 *
 * ── A TRAP THAT COST AN HOUR, 23 September 2026 ────────────────────────
 *
 *  Listing these in ALLOWED_ATTR is not enough. DOMPurify tests the VALUE
 *  of every attribute that is not known to be URI-safe against
 *  ALLOWED_URI_REGEXP — and its default regexp is loose enough that a
 *  value like "90" passes it by accident. Ours is anchored to https:,
 *  mailto: and tel:, so "90" does not match, and `width="90"` was dropped
 *  from every signature while the list above said it was allowed.
 *
 *  The symptom was a two-column signature collapsing into a stack, with a
 *  sanitiser whose configuration read as though it should not. Naming them
 *  here says what is actually true: these are numbers and keywords, not
 *  addresses, so the URI test has no business being applied to them.
 */
const NOT_URIS = [
  'width', 'height', 'align', 'valign', 'colspan', 'rowspan',
  'cellpadding', 'cellspacing', 'border', 'bgcolor', 'color', 'size', 'face',
];

let hooked = false;

/**
 * Registers the CSS scrub once. DOMPurify keeps hooks globally, so adding
 * this on every call would stack handlers.
 *
 * The hook is named in the node check below so it cannot fight the one
 * pasteHtml installs: both read the same `style` attribute and both only
 * ever remove from it, so running both is harmless and running either
 * alone is still correct.
 */
function ensureHook(): void {
  if (hooked) return;
  hooked = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLElement)) return;

    for (const attr of BANNED_ATTRS) node.removeAttribute(attr);

    // ── data: images, removed HERE rather than by ALLOWED_URI_REGEXP ────
    //
    //  DOMPurify exempts img, video, audio, track and source from the URI
    //  regexp entirely (its DATA_URI_TAGS), so a data: src walks past a
    //  configuration that names only https:, mailto: and tel:. Measured on
    //  23 September 2026: the regexp alone let a base64 PNG through into
    //  the stored signature.
    //
    //  The whole element goes, not just the attribute. An <img> with no src
    //  is a broken-image box in most mail clients, which is a worse answer
    //  than a signature that simply has no picture in it.
    for (const attr of ['src', 'href'] as const) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      if (/^\s*data:/i.test(value)) {
        if (node.tagName === 'IMG') node.remove();
        else node.removeAttribute(attr);
      }
    }

    const style = node.getAttribute('style');
    if (!style) return;

    const kept = style
      .split(';')
      .map((d) => d.trim())
      .filter((d) => {
        const prop = d.split(':')[0]?.trim().toLowerCase();
        if (!prop) return false;
        return !BANNED_CSS.some((b) => prop === b || prop.startsWith(`${b}-`));
      });

    if (kept.length) node.setAttribute('style', `${kept.join('; ')};`);
    else node.removeAttribute('style');
  });
}

/**
 * A signature, safe to store and safe to render.
 *
 * Returns an empty string when nothing survives, which the caller should
 * treat as "no signature" rather than as a save of blank HTML.
 */
export function cleanSignatureHtml(html: string): string {
  ensureHook();

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr',
      // execCommand still emits these in every browser we support. Dropping
      // them would silently discard the colour and size the person chose.
      'font',
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'alt', 'src', 'style', 'target', 'rel',
      // The presentational set — see the note at the top. These are what
      // make a two-column signature hold its shape in Outlook.
      ...NOT_URIS,
    ],
    // ...and declared as values rather than addresses, or the URI regexp
    // below silently eats them. See the note on NOT_URIS.
    ADD_URI_SAFE_ATTR: NOT_URIS,
    // NO data: images here, unlike the composer's paste.
    //
    // A data: URI survives our own preview perfectly and is then stripped by
    // Gmail and blocked by Outlook, so the sender sees their logo and the
    // recipient sees a gap — the failure this codebase calls silent. A
    // signature logo has to be a real https URL to work in real mail.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
  }).trim();
}

/**
 * The plain-text half of a signature, derived from the HTML.
 *
 * Every message carries both; the text half is what a plain-text client
 * shows, and until now it was whatever the person typed into a textarea.
 * With a rich editor there is nothing to type, so it is derived here.
 *
 * Deliberately not `innerText`: that needs the element to be laid out in
 * the document, which is not true of the string we are about to save, and
 * an unattached element's innerText is its textContent — every line run
 * together. So block boundaries are turned into newlines first, by hand.
 */
export function signatureText(html: string): string {
  const doc = new DOMParser().parseFromString(cleanSignatureHtml(html), 'text/html');

  // A link's text is usually the address already ("www.techvein.com"); where
  // it is not, the address is worth keeping, because a plain-text reader
  // cannot click anything.
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = (a.getAttribute('href') ?? '').replace(/^mailto:/i, '');
    const text = (a.textContent ?? '').trim();
    if (href && text && !href.toLowerCase().includes(text.toLowerCase())
        && !text.toLowerCase().includes(href.toLowerCase())) {
      a.textContent = `${text} (${href})`;
    }
  });

  // An image has no plain-text form. Its alt text is the closest thing, and
  // a logo with no alt simply disappears rather than leaving "[image]".
  doc.querySelectorAll('img').forEach((img) => {
    // Padded with spaces: an <img> sits inline between other inline content,
    // and without them "Techvein" and the link after it ran together into
    // one word in the plain-text half. The space collapse at the end tidies
    // any that were not needed.
    const alt = img.getAttribute('alt')?.trim();
    img.replaceWith(doc.createTextNode(alt ? ` ${alt} ` : ''));
  });

  doc.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
  doc.querySelectorAll('p, div, table, tr, li, h1, h2, h3, h4, h5, h6')
    .forEach((el) => el.append(doc.createTextNode('\n')));
  // A table cell is a column, not a line: "Amit Dadhich" and the logo beside
  // it should not become two paragraphs.
  doc.querySelectorAll('td, th').forEach((el) => el.append(doc.createTextNode(' ')));

  return (doc.body.textContent ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
