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
  img{max-width:100%;height:auto}
  a{color:#2145d6}
  table{max-width:100%;border-collapse:collapse}
  blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #e5e7eb;color:#6b7280}
  pre{white-space:pre-wrap}
  img[data-blocked-src]{
    display:inline-block;min-width:24px;min-height:24px;
    background:#f3f4f6;border:1px dashed #d1d5db;border-radius:4px
  }
</style>
</head><body>${body}</body></html>`;

  // Size the frame to its content. postMessage is unavailable without
  // allow-scripts, so measure from the parent instead.
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
