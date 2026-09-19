/**
 * Turning somebody else's email into something safe to show on a phone.
 *
 * ── THE THREAT, PLAINLY. ─────────────────────────────────────────────────
 *  bodyHtml is HTML a stranger wrote, and the API returns it untouched (the
 *  web app sanitises in the browser with DOMPurify — apps/web/components/mail/
 *  SafeHtml.tsx). On the phone there is no DOM to sanitise in before it is
 *  rendered, so this file builds a document whose CAPABILITIES are removed
 *  rather than trusting a list of tags:
 *
 *   1. The WebView runs with javaScriptEnabled={false} (screens/MailMessage.js).
 *      Nothing in the message can execute, so an onclick= or a <script> that
 *      slipped past any filter is inert.
 *   2. A Content-Security-Policy meta blocks EVERYTHING by default:
 *      default-src 'none'. Images are data: only until the person taps Show
 *      images, which adds https:. No frames, no fonts, no fetch, no forms.
 *   3. <script>, <iframe>, <object>, <embed>, <form> and on*= attributes are
 *      stripped anyway. Belt and braces: two independent things must fail
 *      before a message can act.
 *   4. Links do not navigate here. The screen intercepts every navigation and
 *      opens http/https in the system browser — an address bar the person can
 *      see, which is the whole reason this app does not host web views of our
 *      own products.
 *
 *  What this deliberately does NOT do: pretend to be a sanitiser. It is a
 *  wrapper plus a few removals. The security is the CSP and the disabled
 *  JavaScript engine; the regexes are there so a broken CSP is not the only
 *  thing standing between a person and a script tag.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Tags whose contents are removed whole, not just unwrapped. */
const DANGEROUS_BLOCKS = /<(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_SELF = /<(script|iframe|object|embed|form|link|meta|base)\b[^>]*\/?>/gi;
const ON_ATTRS = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /((?:href|src|action)\s*=\s*)("|')\s*javascript:[^"']*\2/gi;

/** How many remote images were blocked, and the body with them defused. */
export function blockRemoteImages(html) {
  let blocked = 0;
  const out = html.replace(/(<img\b[^>]*?)\ssrc\s*=\s*("|')(.*?)\2/gi, (whole, head, q, url) => {
    if (/^(data|cid):/i.test(url.trim())) return whole;
    blocked += 1;
    return `${head} data-blocked-src=${q}${url}${q}`;
  });
  return { html: out, blocked };
}

/** Strip what must never run, whatever the CSP does. */
export function strip(html) {
  return (html ?? '')
    .replace(DANGEROUS_BLOCKS, '')
    .replace(DANGEROUS_SELF, '')
    .replace(ON_ATTRS, '')
    .replace(JS_URLS, '$1$2#$2');
}

/** Plain text as HTML: escaped, with line breaks kept and links made tappable. */
export function textToHtml(textBody) {
  const escaped = (textBody ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
}

/**
 * HTML as readable plain text.
 *
 * Amit, 18 Sept 2026: "reply on html designed mail did not pick the content".
 * A reply quotes message.bodyText — and a message built in a design tool often
 * carries NO text part at all, so the quote was the "On ... wrote:" line
 * followed by nothing. The person could not see what they were answering.
 *
 * Not a renderer and not trying to be. Blocks become line breaks, everything
 * else is dropped, entities are undone, and runs of blank lines collapse — the
 * shape a quote needs. Layout tables become long lines rather than columns,
 * which is the right trade in a quote nobody reads closely.
 */
export function htmlToText(html) {
  if (!html) return '';
  return strip(html)
    // <br> and the end of a block are where a line ends.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\u2022 ')
    .replace(/<[^>]+>/g, '')
    // Entities last: doing this first would invent tags out of &lt;script&gt;.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The document handed to the WebView.
 *
 * `showImages` widens the image policy to https: — and ONLY images. Nothing
 * else in the policy moves, because "show pictures" must not also mean "let
 * this message talk to a server about who read it" any more than it has to.
 * (A remote image IS a read receipt; that is why it is off until asked.)
 */
export function buildDocument({ html, text, showImages, dark = false, header = null }) {
  const source = html && html.trim().length > 0 ? strip(html) : textToHtml(text);
  const { html: body, blocked } = showImages
    ? { html: source, blocked: 0 }
    : blockRemoteImages(source);

  const esc = (v) => (v ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const img = showImages ? "img-src data: cid: https:" : "img-src data: cid:";
  const ink = dark ? '#EDEAF6' : '#1F1B2E';
  const paper = dark ? '#15131D' : '#FFFFFF';
  const muted = dark ? '#A9A4BC' : '#6B6780';

  // ── THE HEADER IS IN THE DOCUMENT, NOT ABOVE IT. ───────────────────────
  //  18 Sept 2026, Amit: "check screen for scrolling issue". The body used to
  //  sit in a fixed 320-point box with its own scrolling switched off, inside
  //  a native ScrollView — so a long email was simply cut off, with blank
  //  space underneath, and a wide one could not be scrolled sideways at all.
  //
  //  Height cannot be measured from outside: reporting it needs JavaScript in
  //  the page, and JavaScript is exactly what this screen refuses to run. So
  //  the WebView becomes the ONE scrolling area and the subject, sender and
  //  date go inside it, which also removes the nested-scroll problem rather
  //  than trading it for a different one.
  // ───────────────────────────────────────────────────────────────────────
  const head = header ? `<div class="tv-head">
      <h1>${esc(header.subject) || '(no subject)'}</h1>
      <div class="tv-from">${esc(header.from)}</div>
      <div class="tv-meta">${esc(header.to)}</div>
      <div class="tv-meta">${esc(header.date)}</div>
    </div>` : '';

  return {
    blocked,
    document: `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img}; style-src 'unsafe-inline'; font-src data:;">
<style>
  html,body{margin:0;padding:0;background:${paper};color:${ink};
    font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    word-break:break-word;overflow-wrap:anywhere;-webkit-text-size-adjust:100%;}
  .tv-wrap{padding:16px;}
  .tv-head{padding:16px 16px 0 16px;}
  .tv-head h1{margin:0 0 8px 0;font-size:20px;line-height:1.3;}
  .tv-from{font-size:15px;font-weight:600;}
  .tv-meta{font-size:12px;color:${muted};margin-top:2px;}
  .tv-rule{height:1px;background:${dark ? '#2A2536' : '#EFEBFA'};margin:14px 16px 0 16px;}
  /* ── A DESIGNED EMAIL IS BUILT FOR A 600px DESKTOP COLUMN. ────────────
     Amit, 18 Sept 2026: "html designed mail scroll in right and not looking
     good". Newsletters are nested tables with width="600" and inline pixel
     widths, so the page was wider than the phone and slid sideways — the
     text ran off the edge and had to be dragged back.

     max-width alone did not fix it, because a fixed width beats it: the
     element stays 600px and simply overflows. So width is forced back to
     auto, which lets the table shrink and its text wrap. The HTML width
     attribute is only a presentational hint and any rule here outranks it;
     (no backticks in this comment — it lives inside a template literal, and
     one would end the string.)
     the inline style="width:600px" is what needs !important.

     There is no measuring involved — measuring needs JavaScript in the
     page, and JavaScript is what this document refuses to run.
     ─────────────────────────────────────────────────────────────────── */
  table{width:auto !important;max-width:100% !important;table-layout:auto !important;}
  td,th{max-width:100% !important;min-width:0 !important;
    white-space:normal !important;word-break:break-word;overflow-wrap:anywhere;}
  div,p,span,section,article,center{max-width:100% !important;}
  /* NOT width:auto — an icon sent as width="20" would spring to full size. */
  img{max-width:100% !important;height:auto !important;}
  /* Last resort. Something with a hard min-width still gets to be wide, but
     it scrolls inside the message instead of dragging the page with it. */
  .tv-wrap{overflow-x:auto;}
  html,body{overflow-x:hidden;}
  a{color:#6C3CE9;}
  blockquote{margin:8px 0;padding-left:10px;border-left:3px solid ${muted};color:${muted};}
  pre{white-space:pre-wrap;}
  img[data-blocked-src]{display:none;}
</style></head><body>${head}${header ? '<div class="tv-rule"></div>' : ''}<div class="tv-wrap">${body}</div></body></html>`,
  };
}
