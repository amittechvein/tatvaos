/**
 * UTF-8, by hand, for LiveKit data messages.
 *
 * ── WHY NOT TextEncoder / TextDecoder ────────────────────────────────────
 *  Until 23 Sept 2026 the meeting screen decoded incoming data messages with
 *  String.fromCharCode, one byte at a time. That is correct for ASCII and
 *  silently wrong for everything else: a 👍 reaction arrives as four bytes
 *  and came out as four junk characters; a Hindi chat line, the same. The
 *  web sends UTF-8 JSON (new TextEncoder().encode(JSON.stringify(...))),
 *  so the phone must speak UTF-8 or Hindi chat is garbled in one direction
 *  and unreadable in the other.
 *
 *  Whether Hermes has TextEncoder/TextDecoder depends on which polyfills the
 *  runtime happens to install (Expo's "winter" set does today; a bare RN
 *  build does not). Thirty lines of arithmetic have no such dependency, run
 *  identically under jest, and are checked against the bytes the web would
 *  produce. Used for both directions so the two cannot disagree.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** A string to UTF-8 bytes. Lone surrogates become U+FFFD, as the standard says. */
export function encodeUtf8(str) {
  const s = String(str ?? '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes to a string. Malformed sequences become U+FFFD rather than throwing. */
export function decodeUtf8(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  let out = '';
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let cp;
    let n;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c & 0xe0) === 0xc0) { cp = c & 0x1f; n = 2; }
    else if ((c & 0xf0) === 0xe0) { cp = c & 0x0f; n = 3; }
    else if ((c & 0xf8) === 0xf0) { cp = c & 0x07; n = 4; }
    else { out += '�'; i++; continue; }
    if (i + n > b.length) {
      // Truncated at the end: one U+FFFD for the sequence's valid prefix, as
      // a standard decoder does, then carry on with whatever follows it.
      let k = 1;
      while (i + k < b.length && (b[i + k] & 0xc0) === 0x80) k++;
      out += '�';
      i += k;
      continue;
    }
    let bad = false;
    for (let k = 1; k < n; k++) {
      const t = b[i + k];
      if ((t & 0xc0) !== 0x80) { bad = true; break; }
      cp = (cp << 6) | (t & 0x3f);
    }
    if (bad) { out += '�'; i++; continue; }
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/** JSON in, UTF-8 bytes out — what the web sends on the data channel. */
export const packJson = (obj) => encodeUtf8(JSON.stringify(obj));

/** UTF-8 bytes in, parsed JSON out, or null for anything that is not JSON. */
export function unpackJson(bytes) {
  try { return JSON.parse(decodeUtf8(bytes)); } catch { return null; }
}
