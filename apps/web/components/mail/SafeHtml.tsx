'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { InlineImage } from '@tatvaos/types';

/**
 * Renders untrusted HTML email.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THIS IS THE HIGHEST-SEVERITY COMPONENT IN THE PRODUCT.
 *
 *  Every message displayed here is attacker-controlled HTML, sent to our
 *  users by strangers, for free. Gmail and Outlook have each shipped
 *  high-severity CVEs in exactly this code path. Assume we will too, and
 *  build so that a bypass is contained rather than fatal.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Four independent layers, so no single failure is enough:
 *
 *   1. Sanitise with DOMPurify before the HTML goes anywhere.
 *   2. Render inside an iframe with `sandbox` and NEVER `allow-scripts`.
 *      Even if a script survives layer 1, the sandbox refuses to run it —
 *      which is a stronger guarantee than the CSP below, because it does not
 *      depend on a header being parsed correctly.
 *   3. A strict CSP inside the frame, denying scripts outright.
 *   4. Remote content blocked until the user asks for it — an XSS control
 *      and the tracking-pixel protection users expect.
 *
 * Layer 2 is the one that matters most. Sanitisers are bypassed periodically;
 * a frame that cannot execute anything is unharmed when they are.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THE PAIR RULE — read this before touching the sandbox attribute
 *
 *  `allow-scripts` and `allow-same-origin` are each survivable alone and
 *  catastrophic together. Together, hostile markup that survives DOMPurify
 *  runs as code WITH OUR ORIGIN: our cookies, our tokens, our storage. That
 *  is a stored cross-site-scripting machine sitting in every inbox, fed by
 *  anyone on the internet who knows a customer's address.
 *
 *  We grant `allow-same-origin` and never `allow-scripts`. Email HTML has no
 *  legitimate need to execute anything, ever, so the flag we give up costs
 *  the product nothing — and same-origin is what lets the parent read the
 *  rendered height, which is the entire reason this came up.
 *
 *  An earlier proposal had it the other way round: `allow-scripts` with an
 *  opaque origin and a CSP nonce. Tame on paper, and worse — it permits code
 *  execution inside a document built from a stranger's HTML, and rests the
 *  whole defence on a nonce and a correctly parsed header. This way nothing
 *  runs at all.
 *
 *  A rule in a comment is worth less than a check that refuses, so
 *  `scripts/check-sandbox.mjs` fails the web build if any sandbox attribute
 *  in this app ever contains both.
 *
 *  THE TWO POPUP FLAGS ARE RATIFIED SEPARATELY and are not part of the pair
 *  rule. `allow-popups` is what lets a link in a message open at all;
 *  `allow-popups-to-escape-sandbox` stops the opened site inheriting these
 *  restrictions and breaking. Neither executes a byte of the sender's HTML —
 *  a popup is user-initiated navigation, not script. Recorded here so the
 *  attribute reads as decided rather than drifted.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * How tall this message probably is, estimated from the markup.
 *
 * WHY AN ESTIMATE AND NOT A MEASUREMENT. Sizing an iframe to its content
 * normally means reading `contentDocument` — which a sandbox without
 * `allow-same-origin` denies, permanently and by design. That denial is layer
 * 2 working, not a bug to route around, so the frame gets a considered guess
 * instead of a number.
 *
 * IT ERRS TALL ON PURPOSE. Too tall is trailing whitespace. Too short is a
 * porthole with its own scrollbar inside a pane that already scrolls, which
 * is the state this replaces — every HTML message was 240px regardless of
 * content.
 */
function estimateHeight(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Roughly 55 characters to a line in this pane, 22px to a line.
  const wrapped = Math.ceil(text.length / 55);

  // Anything that ends a block starts a new line even when the text is short.
  const blocks = (html.match(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b/gi) ?? []).length;

  // Images are the big unknown; assume a banner rather than an icon, because
  // guessing small is the failure that hurts.
  const images = (html.match(/<img\b/gi) ?? []).length;

  return Math.min(4000, Math.max(180, (wrapped + blocks) * 22 + images * 180 + 48));
}

/** The one shape a picture may have on its way into the frame. */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Put the email's own pictures where its HTML points at them with cid:.
 *
 * No browser can fetch "cid:", so until 19 Sept 2026 every such picture drew
 * as a broken icon with its alt text, here and on the phone. The API now sends
 * them beside the message (MailInlineImages.cs); this swaps them in.
 *
 * AFTER DOMPurify, on purpose. The sanitiser's URI rule refuses data: outright
 * ("data: and javascript: URLs are how sanitiser bypasses usually land") and
 * that rule stays exactly as strict as it was: nothing the SENDER wrote can be
 * a data: URI. The only data: URIs in the frame are the ones put here, and
 * only when they are raster images in the exact shape above. Same character
 * class as the server's and the phone's, so the three agree where a cid ends.
 */
export function inlineCidImages(html: string, images?: InlineImage[] | null): string {
  if (!html || !images || images.length === 0) return html;
  const byCid = new Map<string, string>();
  for (const im of images) {
    if (im && typeof im.cid === 'string' && typeof im.dataUri === 'string' && SAFE_DATA_IMAGE.test(im.dataUri)) {
      byCid.set(im.cid, im.dataUri);
    }
  }
  if (byCid.size === 0) return html;
  return html.replace(/cid:([^"'\s<>)]+)/gi, (whole: string, raw: string) => {
    let cid = raw;
    try { cid = decodeURIComponent(raw); } catch { /* not encoded; use as written */ }
    return byCid.get(cid) ?? whole;
  });
}

interface SafeHtmlProps {
  html: string;
  /** Pictures the HTML points at with cid:, from the message's `inlineImages`. */
  inlineImages?: InlineImage[] | null;
  /** Show remote images immediately. Defaults to false, deliberately. */
  allowRemoteInitially?: boolean;
}

/**
 * Neutralise remote resources by moving the URL to a data attribute.
 * Restoring them is then a matter of putting it back — no re-parse needed.
 */
function blockRemoteContent(html: string): { html: string; blockedCount: number } {
  let count = 0;
  const out = html.replace(
    /(<(?:img|source)\b[^>]*?)\ssrc\s*=\s*(["'])(https?:\/\/[^"']*)\2/gi,
    (_m, tagStart: string, quote: string, url: string) => {
      count += 1;
      return `${tagStart} data-blocked-src=${quote}${url}${quote}`;
    },
  );
  return { html: out, blockedCount: count };
}

function restoreRemoteContent(html: string): string {
  return html.replace(/\sdata-blocked-src\s*=/gi, ' src=');
}

export function SafeHtml({ html, inlineImages = null, allowRemoteInitially = false }: SafeHtmlProps) {
  const [allowRemote, setAllowRemote] = useState(allowRemoteInitially);
  const [height, setHeight] = useState(240);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const { sanitized, blockedCount } = useMemo(() => {
    // Layer 1 — sanitise. Explicit allow-list; anything not named is dropped.
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'a', 'b', 'blockquote', 'br', 'caption', 'code', 'div', 'em', 'h1', 'h2',
        'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's',
        'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
        'th', 'thead', 'tr', 'u', 'ul',
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'style', 'colspan', 'rowspan'],
      // Never allowed, regardless of anything else
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction', 'srcset', 'ping'],
      ALLOW_DATA_ATTR: false,
      // data: and javascript: URLs are how sanitiser bypasses usually land
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|cid):/i,
    });

    // Remote content is blocked BEFORE the email's own pictures go in, so the
    // blocker never has to read a megabyte of base64 and its count stays a
    // count of remote things.
    const blocked = blockRemoteContent(clean);
    return { sanitized: inlineCidImages(blocked.html, inlineImages), blockedCount: blocked.blockedCount };
  }, [html, inlineImages]);

  const body = allowRemote ? restoreRemoteContent(sanitized) : sanitized;

  // Layer 3 — CSP inside the frame. scripts denied outright; images only when asked.
  const csp = [
    "default-src 'none'",
    allowRemote ? "img-src https: data: cid:" : "img-src data: cid:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  const srcDoc = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html,body{margin:0;padding:0}
  body{font:14px/1.6 ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;padding:4px 2px;word-break:break-word}
  img{max-width:100%!important;height:auto}
  a{color:#2145d6}
  /* !important because bulk-mail tables carry inline width:600px, which beats
     an ordinary rule and pushes a horizontal scrollbar into a 420px pane.
     Author styles marked important outrank inline styles that are not. */
  table{max-width:100%!important;border-collapse:collapse}
  td,th{max-width:100%}
  blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #e5e7eb;color:#6b7280}
  pre{white-space:pre-wrap}
  img[data-blocked-src]{
    display:inline-block;min-width:24px;min-height:24px;
    background:#f3f4f6;border:1px dashed #d1d5db;border-radius:4px
  }
</style>
</head><body>${body}</body></html>`;

  // The estimate is the REAL mechanism, not a fallback. Recomputed when the
  // body changes — which includes "Show images", since restoring remote
  // content changes what there is to lay out.
  useEffect(() => { setHeight(estimateHeight(body)); }, [body]);

  // The real measurement, which works now that the frame is same-origin.
  //
  // The estimate above still runs FIRST and stays as the first-paint value.
  // Deleting it and waiting for this would bring back the flash of a wrongly
  // sized frame — the 240px bug wearing a new hat — because the measurement
  // cannot happen until the frame has laid out.
  //
  // It is still wrapped in try/catch. A browser that declines the access for
  // reasons of its own must cost us a slightly wrong height, never a blank
  // message.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let observer: ResizeObserver | null = null;

    const measure = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc?.body) return;

        // BODY ONLY. Not Math.max with documentElement.
        //
        // <html> fills the frame's viewport, so documentElement.scrollHeight
        // reports THE FRAME'S CURRENT HEIGHT, not the content's. Taking the
        // larger of the two meant the frame could grow and never shrink: it
        // locked to whatever the first-paint estimate guessed and stayed
        // there. Measured live on a real message — content 1607px, frame
        // 2548px, and 941px of white space under the footer that no amount of
        // re-measuring would ever reclaim.
        const h = doc.body.scrollHeight;
        if (h > 0) setHeight(Math.min(h + 16, 4000));

        // Images decode after load, and a banner arriving late changes the
        // height after every measurement we have taken. Watching the body is
        // cheap now that the frame is same-origin, and it is the difference
        // between "right at load" and "right".
        if (!observer && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            const next = doc.body.scrollHeight;
            if (next > 0) setHeight(Math.min(next + 16, 4000));
          });
          observer.observe(doc.body);
        }
      } catch {
        // The estimate stands. A browser that declines the access for reasons
        // of its own costs us a slightly wrong height, never a blank message —
        // and never a reason to weaken the sandbox.
      }
    };

    frame.addEventListener('load', measure);
    const t = setTimeout(measure, 60);
    return () => {
      frame.removeEventListener('load', measure);
      clearTimeout(t);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div className="space-y-2">
      {blockedCount > 0 && !allowRemote && (
        <div className="flex items-center gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
          <span className="text-warn">
            {blockedCount} remote {blockedCount === 1 ? 'image' : 'images'} blocked.
            <span className="ml-1 text-warn">
              Loading them tells the sender you opened this message.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setAllowRemote(true)}
            className="ml-auto shrink-0 rounded border border-warn/40 bg-surface px-2.5 py-1 text-xs font-medium text-warn hover:bg-warn/10"
          >
            Show images
          </button>
        </div>
      )}

      <iframe
        ref={frameRef}
        title="Message content"
        srcDoc={srcDoc}
        /*
         * Layer 2. Note what is ABSENT:
         *   no allow-scripts      — scripts cannot run
         *   no allow-same-origin  — no access to our origin, cookies or storage
         * allow-popups only exists so a clicked link can open a new tab.
         * Do not add to this list without understanding what it gives away.
         */
        /*
         * THE PAIR RULE, in the two lines that enforce it. See the header.
         * allow-same-origin WITHOUT allow-scripts: the parent can read the
         * rendered height, and nothing in the document can run.
         *
         * NEVER add allow-scripts to this string. The build refuses it.
         */
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="w-full border-0 bg-white"
        style={{ height }}
      />
    </div>
  );
}
