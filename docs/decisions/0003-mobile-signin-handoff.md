# 0003 — Mobile sign-in handoff: token to browser session, code in the fragment

**Status:** accepted
**Date:** 2026-09-13, revised 2026-09-15, accepted by the CTO 2026-09-15

## Context

The mobile app holds a bearer token. The web products authenticate by
cookie. So a web view inside the app lands on a login page, and the brief's
web-view plan (`docs/MOBILE_LANE_BRIEF.md` §3) is blocked on one endpoint:
trade the token for a short-lived authenticated URL. Ruling of 13 Sept:
single-use, hashed at rest, sixty seconds, bound to user and tenant — and the
code must travel in the URL **fragment**, never the query string, so it
never reaches a server log or a proxy.

**What logs today.** `infra/docker/Caddyfile` and every `conf.d/*.caddy`
fragment have no `log` directive, and the running Caddy container printed
zero request lines in ten minutes on 13 Sept and in sixty minutes on 15 Sept:
Caddy access logging is off. On 15 Sept the web container printed six lines
in an hour, none of them a request: Next's standalone server does not log
requests. So a query-string code would not land in a server log *today* — the
ruling is about the day somebody turns logging on, and about browser
history, which is a log we do not control.

## Options

1. **Code in the query string, redeemed by GET.** Simplest. Every proxy,
   access log and history entry keeps the code for its lifetime; a GET with
   a side effect is prefetchable by link previews.
2. **Code in the fragment, read by a small page script, redeemed by POST.**
   The fragment never leaves the browser. The page script does
   `history.replaceState` to scrub it before anything else, then POSTs it.
   Cost: one static landing page with one script.
3. **No handoff; keep the system browser.** Honest, and what ships today.
   Cost: one extra sign-in per product, and the app never shows a product
   inside itself.

## Decision

Option 2.

**Mint.** `POST /api/auth/handoff` with the app's bearer token. Body:
`{ "path": "/mail/inbox" }` (the product path to land on; its first segment
must be one of `mail`, `space`, `calendar`, `family`, `admin` — each a real
route under `apps/web/app/`, checked 15 Sept — and anything else is refused,
so the handoff cannot become an open redirect). Response:
`{ "url": "https://core.tatvaos.com/handoff#c=<code>&p=/mail/inbox", "expiresAt": "..." }`.
The code is 32 random bytes, base64url. Stored: `sha256(code)`, `user_id`,
`tenant_id`, `path`, `created_at`, `expires_at = now() + 60s`,
`redeemed_at NULL`, in a new additive table `core.auth_handoff_codes` with
RLS like every other table. The plaintext code exists only in the response
and the app's memory.

**Land.** `apps/web/app/handoff/page.tsx` is a static page. Its script, on
load: read `location.hash`, immediately `history.replaceState` to `/handoff`
so the fragment is gone from history, then `POST /api/auth/handoff/redeem`
with `{ code }`, credentials included. If the redeem answers 401, the page
shows one sentence — "This link has expired. Go back to the app and open it
again." — and stops: no retry loop, no spinner, no form left waiting.

**Redeem.** One statement, single-use by construction:
`UPDATE core.auth_handoff_codes SET redeemed_at = now() WHERE code_hash = $1
AND redeemed_at IS NULL AND expires_at > now() RETURNING user_id, tenant_id,
path`. Because the lookup happens before any tenant is known, it runs inside
a SECURITY DEFINER function, the `core.resolve_refresh_token` pattern. Zero
rows means invalid, used, or expired — the same 401 for all three, so a
probe cannot tell them apart. Then the same checks login makes
(`users.status = 'active'`, `tenants.status IN ('active','trial')`), then the
same cookies login sets, then `{ "redirect": path }`; the page navigates.
Rate limit: five redeems a minute per IP, a new fixed-window policy beside
the ones `apps/api/Program.cs` already registers with `AddRateLimiter`.

**Bound to user and tenant** means the redeemed session is for the row's
user in the row's tenant, whatever the browser already holds. A browser
signed in as somebody else is replaced, not merged.

## What proves it

- Minting with a bearer token for user A yields a URL; redeeming it once
  sets cookies for A (`/api/auth/me` answers A); redeeming it a second time
  answers 401.
- A code redeemed at 61 seconds answers 401.
- A path outside the allowlist is refused at mint, not at land.
- A suspended user's code redeems to 401 even inside the window.
- The landing page's URL after load has no fragment (read `location.href`
  in a browser test), and Caddy, with `log` temporarily enabled on a
  scratch box, shows `/handoff` with no code.
- A cold phone still redeems inside the window. The sixty seconds run from
  mint to redeem, and a slow landing page or a slow script spends them. A CI
  browser test loads the landing page under a throttled slow network profile
  with CPU slowdown and confirms the redeem lands inside the window; with the
  window forced shorter than the load, it confirms the expiry sentence
  appears and nothing hangs. If the test cannot pass at sixty seconds, the
  window becomes ninety, and whether that extra exposure is acceptable is
  Amit's decision (CTO, 15 Sept).
- Red first: remove `AND redeemed_at IS NULL` and watch the second redeem
  succeed.

## Consequences

Easier: the app can open Mail, Space, Calendar and the admin console inside
itself, signed in, which is the brief's plan. Harder: one more credential
shape to reason about, with a 60-second life; one more table; a landing
page that must scrub its own URL before anything else runs. Accepted: a
code that is read by a script means the page is not usable with JavaScript
off, which no product page is anyway.

## Revisit when

A second client (desktop, a partner) needs the same handoff, or 0004's
OpenID Connect provider ships — then the app can sign in as a public client
and this handoff may become one use of that provider rather than its own
mechanism. Either way this record is superseded.
