// ============================================================================
//  Where the sign-in page may send a person afterwards: a place on THIS site,
//  and nowhere else. `next` arrives in the address bar, so anyone can write
//  it, and it is followed straight after a person has typed their password.
//
//  ASK THE PARSER, NOT THE STRING (Mr. Singh, 29 Sept 2026). The first
//  version tested the raw text: starts with "/", not "//", not "/\". A
//  browser strips tab, CR and LF out of a URL before it parses it, so
//  "?next=/%09/evil.example" passed that test (its second character is a
//  tab) and the browser then read "//evil.example": another site. That is
//  the standard way past a check of this kind, and tests/web-safe-next
//  proves the old check fell to it (red on 5fa25c5).
//
//  So the answer is whatever the browser's own URL parser makes of it,
//  resolved against this site: if it lands on another origin it is refused,
//  and what is returned is the parsed path, query and fragment, never the
//  raw text.
//
//  And it must be written as a path. Every caller passes one (RequireAuth,
//  join, the consent screen, OidcEndpoints). Without this rule the parser
//  alone reads "https:evil.example", on an https site, as the path
//  "/evil.example" on this site: harmless, but not the person's home, and
//  nothing legitimate is written that way.
// ============================================================================

export function safeNext(raw: string | null, origin: string): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  let u: URL;
  try {
    u = new URL(raw, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  return u.pathname + u.search + u.hash;
}
