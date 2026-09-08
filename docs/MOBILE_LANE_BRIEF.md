# TatvaOS mobile — lane brief

Written 3 September 2026 by the CTO. Design approved by Amit the same day.
This is the decisions, not the plan — a plan needs someone assigned, and
nobody is yet. See §7.

---

## 1. Why an app exists at all

**An iPhone cannot share its screen from a web page.** Safari on iOS does not
implement `getDisplayMedia`, and neither does Chrome on Android. This is not
something our code can work around — screen capture on a phone requires an
installed application with the platform's own permissions.

That is the whole reason this lane exists. Everything else the app does, a
mobile browser already does adequately.

**Keep that straight when scope is discussed.** If a proposed feature would
work in a mobile browser, it does not justify app work on its own.

---

## 2. Stack: React Native with Expo, TypeScript

**Decided against Flutter deliberately, and Flutter is the better framework
on one axis.** Flutter draws every pixel itself, so it has a higher ceiling
for custom design and consistently smooth animation. If this were a
design-led product with dozens of hand-built screens, Flutter would win.

It loses here on two of Amit's stated requirements:

**Language.** The web app is React and TypeScript. React Native is the same
language and much of the same thinking, so the existing lane owners can read
and change the app. Flutter is Dart — a separate skill nobody here has, and a
second thing to hire for.

**Updates without a store submission.** Expo's over-the-air updates push
JavaScript changes straight to installed phones. Amit's requirement was "for
small changes no need to deploy again and again"; this meets it exactly.
**Flutter cannot do this** — Dart compiles to machine code, so every change,
however small, goes through Apple's review queue.

**The UI difference barely applies at our scale**, because of §3: v1 has three
hand-built screens, not thirty.

---

## 3. Architecture — the decision that makes this small

**Do not rebuild six products for mobile.**

Mail, Space, Calendar, Contacts and the admin console all work acceptably in a
mobile browser today. The app shows them in a web view inside the native
shell. The user sees an app with our icons and our dashboard; each product
opens full-screen within it.

**Build only Connect natively**, because it is the one thing that genuinely
cannot work in a mobile browser. Screen sharing, camera, microphone,
background audio and call interruption handling all need real native code.
LiveKit — which Connect already uses — has a React Native SDK covering both
platforms.

That turns "build six mobile apps" into "build a shell, a login, a dashboard,
and one real product."

**The honest cost of this choice:** web views feel slightly less native than
hand-built screens, and offline support is poor. Both are acceptable for v1
and both are reversible — any product can be rebuilt natively later without
disturbing the others.

---

## 4. v1 scope

**Three native screens:**

1. **Login** — email and password against the existing auth API. Same
   credentials as the website. Store the refresh token in the platform
   keychain, never in plain storage.
2. **Dashboard** — a grid of six product icons with names, plus a "next
   meeting" card with a Join button. Joining a meeting is the most common
   reason someone opens this on a phone; making them navigate into Connect
   first wastes the moment.
3. **Connect** — the meeting screen, native. Join, camera, microphone,
   speaker, participant tiles, **screen share**, and leaving cleanly.

**Everything else is a web view** with the session already established.

**Six icons, not seven.** Platform is developer-facing and will be used from a
laptop. It costs a dashboard slot and confuses school staff.

**Not in v1:** push notifications, offline mail, biometric unlock, tablet
layouts, deep links from email. All reasonable, none load-bearing.

---

## 5. What Amit must supply before a build starts

- **The logo file**, in the sizes both stores want.
- **An Apple Developer account** — $99/year — and a **Google Play developer
  account** — $25 once. Both are in his name; neither can be created by a
  developer on his behalf.
- **A decision on what else the dashboard shows.** Unread mail count,
  today's classes, anything a head teacher opens the app to check. The grid
  works without it; it is better with one useful number.

---

## 6. Risks, named before anyone starts

**App store review is not under our control.** The first submission to Apple
takes days and can be rejected for reasons that surprise you. Budget for two
rounds. After that, over-the-air updates avoid most of it — but anything
touching native code still queues.

**Screen sharing is the hardest single piece of this app.** iOS requires a
Broadcast Upload Extension, which is a separate process with its own memory
limits and its own signing. Android requires MediaProjection and a foreground
service notification. LiveKit's SDK handles both, but "handles" means "makes
possible", not "makes easy". **This is the piece that should be built and
proven first**, before the shell around it — if it cannot be made to work,
the case for the whole lane changes.

**Web views inherit our web bugs.** A layout problem in mobile webmail becomes
an app problem. That is an argument for Mail's mobile layouts getting the same
attention as desktop, not against the approach.

---

## 7. Who builds it — ASSIGNED, 9 September 2026

**A mobile developer has been hired.** The recommendation below was taken.

**Read `docs/onboarding/mobile/WELCOME.md`** — this brief remains the decision
record for *why* and *what*; that document is what exists in the repository
today, what is blocked and on whom, and the five environment traps that each
cost a day on 8 September.

**What changed since this brief was written, and it matters:**

The app is no longer nothing. `apps/mobile` signs in against production, stores
its refresh token in the Android keystore, comes back signed in after a
restart, shows the person's real entitlements, and opens each product. About 8%
of v1, but a real foundation rather than a demo.

**Section 3's web-view decision is currently NOT what ships.** The tiles open
the system browser instead, because the web apps authenticate by cookie and the
app holds a token — a web view lands on a login page inside our own app, and
teaches people to type passwords into app-shaped screens. **That objection
disappears the moment Core ships the sign-in handoff endpoint** (token → short-
lived authenticated URL), at which point section 3 becomes correct as written.
Chasing that endpoint is the highest-value thing on this lane.

**Section 6's "build screen sharing first" is reinforced, not softened.**
`getDisplayMedia` does not exist on Android Chrome or iOS Safari, so screen
sharing from a phone is the one capability no browser can provide — which makes
it the capability that justifies the app. Prove it before building around it,
and check `connect_server_capacity` first: we are on a 2 vCPU box that already
cannot record.

---

**The CTO's original recommendation, kept for the record:**

Nobody was assigned. Core, Mail and Connect were all fully loaded, and this is a
genuinely different skill: store submissions, signing certificates, native
permissions, two platforms' review processes. The recommendation was to hire,
because Connect is the most complex product in the suite and pausing it to learn
app development is expensive in both directions.

---

*The design was approved from a mockup on 3 September. Whoever picks this up
should ask to see it before writing a screen.*
