'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

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
 *   2. Render inside an iframe with `sandbox` and NO allow-scripts and NO
 *      allow-same-origin. Even if a script survives layer 1, it has no
 *      origin to act on and cannot reach our DOM, cookies or tokens.
 *   3. A strict CSP inside the frame, denying scripts outright.
 *   4. Remote content blocked until the user asks for it — an XSS control
 *      and the tracking-pixel protection users expect.
 *
 * Layer 2 is the one that matters most. Sanitisers are bypassed periodically;
 * a sandboxed cross-origin frame has nothing worth stealing even when they are.
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

interface SafeHtmlProps {
  html: string;
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

export function SafeHtml({ html, allowRemoteInitially = false }: SafeHtmlProps) {
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

    const blocked = blockRemoteContent(clean);
    return { sanitized: blocked.html, blockedCount: blocked.blockedCount };
  }, [html]);

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

  // A genuine measurement, attempted anyway and expected to fail.
  //
  // With no allow-same-origin the frame has an opaque origin, so
  // contentDocument throws every time — this is not an edge case, it is the
  // only case. Kept because it costs nothing, refines the estimate on any
  // browser that permits it, and starts working the day the sandbox is
  // revisited. NEVER weaken the sandbox to make it succeed.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const measure = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc?.body) return;
        const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
        if (h > 0) setHeight(Math.min(h + 16, 4000));
      } catch {
        // Cross-origin sandbox can deny access. Falling back to the default
        // height is correct — never weaken the sandbox to fix layout.
      }
    };

    frame.addEventListener('load', measure);
    const t = setTimeout(measure, 60);
    return () => {
      frame.removeEventListener('load', measure);
      clearTimeout(t);
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
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="w-full border-0 bg-white"
        style={{ height }}
      />
    </div>
  );
}
