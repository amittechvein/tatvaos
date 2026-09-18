# 0006 — Mail is a native screen on the phone, not a web view

**Status:** decided by Amit, 17 September 2026 ("start on app development for
mail", after "Native mail screens same as connect" on 16 September). Built the
same night on branch `mobile/mail-screens`. **This supersedes
`docs/MOBILE_LANE_BRIEF.md` §3 and §4 for Mail only.** Written by the session
that built it, for the CTO to review — the brief is decision-of-record and a
silent divergence from it is exactly what this file exists to prevent.
**Date:** 2026-09-17

## What the brief says, and why it said it

`MOBILE_LANE_BRIEF.md` §3: "**Do not rebuild six products for mobile.** Mail,
Space, Calendar, Contacts and the admin console all work acceptably in a mobile
browser today. The app shows them in a web view inside the native shell." §4:
"**Three native screens:** Login… Dashboard… Connect… **Everything else is a
web view** with the session already established."

That was right when it was written. One developer, six products, and a mobile
web Mail that already worked. Connect was the exception because a meeting needs
the camera, the microphone and a screen capture — things a web view cannot
reach.

## What changed

1. **The handoff exists now** (decision 0003, deployed 16 Sept). The brief's
   web-view plan became *possible* at that moment, and the first thing it
   produced was the cost of it: the Mail tile opens the system browser, the
   person signs in through a handoff, and they are in Chrome, not in TatvaOS.
   Coming back means switching apps. Amit used it on the phone and asked for
   native screens the same evening.
2. **Connect proved the pattern.** A native screen against the same API the web
   app uses, no cookie, no handoff: `screens/Meeting.js` has been on a real
   phone in real meetings since 16 Sept. Mail is a simpler case — no media, no
   sockets.
3. **The API needs nothing new.** `/api/mail/*` takes the bearer token this app
   already holds, and has no product gate: a person without Mail gets
   `{ mailbox: null }` rather than a 403. Nothing in the server had to change
   for this, which is the strongest argument that the divergence is cheap.

## What was built

- `lib/mail.js` — the endpoints, ported from `apps/web/lib/mail.ts`, keeping
  the API's field names (`isRead`, not `unread`).
- `screens/Mail.js` — folders, the message list, search, paging, unread marks.
- `screens/MailMessage.js` — one message, with the body rendered in a WebView,
  attachments downloaded with the bearer token and handed to the share sheet.
- `screens/MailCompose.js` — new, reply and forward, with attachments from the
  phone, sent through `POST /api/mail/send` (multipart, the same fields the web
  composer posts).
- `lib/mailHtml.js` — the document a stranger's HTML is rendered inside.

## The part that is a security decision, not a UI one

The API returns `bodyHtml` **unsanitised**; the web app sanitises in the browser
with DOMPurify and a sandboxed iframe (`apps/web/components/mail/SafeHtml.tsx`).
A phone has no equivalent, so the phone removes CAPABILITIES rather than
trusting a tag list:

| | |
|---|---|
| JavaScript | **off** in the WebView (`javaScriptEnabled={false}`). Nothing in a message can execute. |
| Everything else | `Content-Security-Policy: default-src 'none'` — no frames, fonts, fetch or forms. |
| Images | `img-src data: cid:` until the person taps **Show images**, which adds `https:` and nothing else. A remote image is a read receipt; that is a choice, not a default. |
| Links | never navigate in the message. `onShouldStartLoadWithRequest` sends http/https to the system browser, where there is an address bar. |
| Belt and braces | `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `on*=` handlers and `javascript:` URLs are stripped anyway, so a broken CSP is not the only thing standing between a person and a script tag. |

Checked in `__checks__/mailHtml.check.js` and `__checks__/mailScreens.check.js`,
calibrated red: blocking removed → 4 red; JavaScript left on → 1 red; marking
read before opening → 2 red; a reply without `inReplyToId` → 1 red.

## What this costs, honestly

- **Two more native modules** (`react-native-webview`, `expo-document-picker`,
  plus `expo-sharing`/`expo-file-system` for attachments). Every native module
  is another thing that can break a Gradle build on a laptop that already
  struggles (WELCOME §3 trap 10).
- **A second implementation of Mail's UI**, which will drift from the web one.
  The brief's warning was real; this accepts it for Mail and for nothing else.
- **What is NOT ported, and still opens the browser:** filters, signatures,
  shared mailboxes, categories, threads (the phone lists messages, not
  conversations), drafts (the API does not keep attachments with a draft, so a
  Save draft button would quietly lose files), and Mail settings.

## What would make this wrong

If the phone's Mail screens fall behind the web app's and nobody notices —
a feature added to webmail that phone users silently do not get. The mitigation
is that `lib/mail.js` is a port of `apps/web/lib/mail.ts` and says so; the
divergence to watch for is in the screens, not the client.

Space, Calendar, Contacts and Admin stay web views. §3 of the brief still holds
for them.
