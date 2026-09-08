# The UI lane — one design system, and the end of YZEN

**5 September 2026.** Written by the CTO. Amit's decision: drop the purchased
template and redesign properly.

Nobody is assigned to this yet. This document exists so that whoever takes it
starts from an audit and a decision rather than an opinion.

---

## 1. Why this exists

TatvaOS looks like two products because it is built from two styling systems.
Changing how the whole application looks is currently impossible to do well —
not because the design is hard, but because any change has to be made twice and
the seam always shows somewhere.

The goal is one system, one set of components, one place where a colour or a
corner radius is decided.

---

## 2. What is actually there today

Audited 5 September against `apps/web`, not remembered.

### Two styling systems, both loaded on every page

`app/layout.tsx` lines 11–12:

```tsx
import '../styles/yzen/bootstrap.min.css';
import '../styles/yzen/styles.css';
```

`styles/yzen/styles.css` is **27,778 lines** of purchased template. It ships on
every request whether the page uses it or not.

Alongside it, Tailwind — configured properly, reading colours from CSS custom
properties in `styles/globals.css`.

### The brand green is written twice

| File | Declaration |
|---|---|
| `styles/globals.css` | `--brand-500: 3 181 98` |
| `styles/yzen/styles.css` line 69 | `--primary-rgb: 3, 181, 98` |

The same colour, in two places, kept in agreement by hand. Change one and half
the product turns a different green. This is the clearest single argument for
the whole exercise.

### 27 files use Bootstrap/YZEN classes

Grouped as they will be migrated:

| Group | Files |
|---|---|
| **Sign-in** (2) | `app/login/page.tsx`, `app/signup/page.tsx` |
| **Account** (1) | `app/account/page.tsx` |
| **Org console** (7) | `app/org/` — api-keys, audit, departments, domains, mailboxes, storage, users |
| **Super-admin** (4) | `app/admin/` — organisations, plans, settings, storage |
| **Family** (3) | `app/family/[view]`, `import`, `labels` |
| **Connect** (5) | `ConnectSkin.tsx`, `meetings/[id]`, `meetings/[id]/Recordings.tsx`, `new`, and the index |
| **Marketing** (1) | `app/(marketing)/page.tsx` |
| **Shared components** (4) | `components/shell/Topbar.tsx`, `components/ui/Kit.tsx`, and two `ComingSoon.tsx` |

The other 20 pages are already Tailwind-only and need no migration — they
inherit the new look automatically once the components change.

### What already exists to build on

`components/ui/` holds `Kit.tsx`, `Modal.tsx`, `AuthCard.tsx`, `Avatar.tsx`,
`Icon.tsx`, `Charts.tsx` and others. `components/shell/` holds `AppShell`,
`Sidebar`, `Topbar`, `AppLauncher`. **This is the beginning of a component
library, not a blank page.** It should be extended, not replaced.

---

## 3. The gap nobody should skip

**YZEN is currently doing our design work.** It is not only styling — it is the
opinion about what a button looks like, how dense a table is, how a form is
laid out. Remove it without an answer and the result is 27 pages that look
worse than they do today.

So the design has to exist before the migration finishes. Where it comes from
is an open decision (§6), but it cannot be "we'll see how it looks".

---

## 4. The plan, in four stages

### Stage 1 — Decide the design and write the tokens

Colours, type scale, spacing scale, radii, shadows, and the dozen or so
component shapes that matter: button, input, select, checkbox, card, table,
modal, tabs, nav item, badge, toast, empty state.

Output: a decision, and the tokens in `styles/globals.css` and
`tailwind.config.ts`. **Nothing visible ships in this stage.**

### Stage 2 — Build the components

Extend `components/ui/` until every shape above exists and is documented by
example. Still nothing visible ships — the new components are not used by any
page yet.

### Stage 3 — Migrate, one page at a time, looking the same

Each page moves off Bootstrap onto the new components **while looking roughly
as it does now.** This is the part people get wrong: migrating and redesigning
in the same commit means every change is both a refactor and a judgement call,
and a broken page cannot be told from a deliberate one.

One page per pull request. Any single page can be reverted without touching the
others.

### Stage 4 — Delete YZEN, then change the look

When no file references Bootstrap classes, remove the two imports from
`app/layout.tsx` and delete `styles/yzen/`. **That deletion is the definition
of done** — it is a check with a real failure mode, because if anything still
depends on the template the page breaks visibly and immediately.

Only then does the look change, and by then it is a token change rather than a
project.

---

## 4.1 Stage 1 output — the agreed palette

**Decided by Amit, 5 September 2026**, from the Techvein Monitor reference:
violet on a warm cream canvas. Reviewed against two mockups — the `/org`
console and the Mail inbox, the densest screen in the product.

These are the values to paste into `styles/globals.css`. **Space-separated RGB
channels, not hex** — Tailwind needs to insert an alpha channel, and it can only
do that with `rgb(var(--x) / <alpha-value>)`. That constraint is already
documented at the top of `globals.css`; it is repeated here because it is the
single easiest thing to get wrong.

```css
/* Brand — violet. Replaces YZEN's #03b562 green. */
--brand-50:  245 241 254;   /* #F5F1FE */
--brand-100: 234 226 252;   /* #EAE2FC */
--brand-200: 211 196 248;   /* #D3C4F8 */
--brand-300: 179 155 242;   /* #B39BF2 */
--brand-400: 143 107 236;   /* #8F6BEC */
--brand-500: 108  60 233;   /* #6C3CE9  ← the brand colour */
--brand-600:  90  47 204;   /* #5A2FCC */
--brand-700:  74  41 168;   /* #4A29A8 */
--brand-800:  58  33 131;   /* #3A2183 */
--brand-900:  42  25  97;   /* #2A1961 */

/* Canvas, surfaces, lines */
--canvas:  250 246 239;     /* #FAF6EF — WARM, not grey. See note below. */
--surface: 255 255 255;     /* #FFFFFF */
--line:    236 231 221;     /* #ECE7DD */

/* Text */
--ink:       21  20  27;    /* #15141B */
--ink-muted:107 104 128;    /* #6B6880 */
--ink-faint:156 153 171;    /* #9C99AB */

/* The rail is now LIGHT — see below. Kept as variables so the
   sidebar's markup does not change. */
--rail:         250 246 239;  /* same as canvas */
--rail-soft:    245 241 254;  /* brand-50, the active-item tint */
--rail-text:    107 104 128;
--rail-heading: 156 153 171;

/* Status accents. Status only — never decoration. */
--ok:     23 166 115;       /* #17A673 */
--warn:  194  65  12;       /* #C2410C */
--danger:179  38  30;       /* #B3261E */
--info:   26 115 199;       /* #1A73C7 */
```

`styles/yzen/styles.css` line 69 must change in the same commit or half the
product stays green:

```css
--primary-rgb: 108, 60, 233;
```

### The three rules the mockups established

**1. Cream is for chrome, white is for content.** The rail and page background
are warm cream; message lists, cards and reading panes are white. Small text on
the cream loses contrast, and the contrast between the two is what gives a
reading pane its "sheet of paper" quality.

**2. Violet appears only where something is clickable or current.** Active nav
item, primary button, selected row, small accents. Everything else is ink on
cream or ink on white. The restraint is the design.

**3. State is never colour alone.** The active nav item and the selected
message both get a violet left bar *and* a tint. Unread mail is weight plus a
small dot, not a tinted row — tinted rows are fine at six messages and a wall
at two hundred, and weight scales where colour does not.

### The rail becomes light, and that fixes the logo

Today `overrides.css` line 71 forces `background: #fff !important` behind the
sidebar logo. That exists only because the wordmark is dark artwork and the
rail is dark — a transparent dark logo on a dark rail is an invisible logo. The
PNGs already carry a real alpha channel (checked: `core-logo.png` and
`core-name.png` are both RGBA); transparency was never the problem.

A light rail removes the dark background, which removes the white block, which
removes the seam. **Delete that `!important` line as part of the migration.**

### Still required from Amit: SVG logos

Seven product lockups as SVG rather than PNG, so colour is controlled by CSS
instead of baked into pixels. One file then works on white, on cream, on
violet, and in dark mode — and is sharp at any size, where `space-name.png` is
currently 127 KB of fixed-resolution artwork displayed 30 pixels tall.

Not a blocker: the existing dark PNGs work on a light rail as they are. But
they cannot survive a dark mode.

### Not yet decided: dark mode

`globals.css` has a `.dark` block, and every value in it was chosen against the
green. **Nothing in this section covers dark mode**, and the violet ramp cannot
simply be dropped into it — light-on-dark needs different steps to stay
readable. Whoever takes stage 1 owns it. Until then the dark theme will look
wrong, and that is a known state rather than a surprise.

### And the mobile app

`apps/mobile/theme.js` carries a third brand colour — `#0F6E56`, a green that
matches neither of the web ones. It must move to this palette in the same
sprint, or the same two-systems problem exists again across two codebases.

---

## 4.2 Progress, and what it taught us — 7–8 September 2026

**Stage 2 is done.** `components/ui/` now holds three files that together are
the set:

| File | Holds |
|---|---|
| `Kit.tsx` | Card, Button, Badge, Stat, Table, Td, Meter, Empty — rewritten off Bootstrap onto tokens |
| `Form.tsx` | **New.** Field, Input, Textarea, Select, Checkbox, FormActions |
| `Page.tsx` | **New.** PageHeader, Tabs, Alert, Toolbar |

**`Kit.tsx` is the lever, and finding that changed the plan.** Thirty-one files
import it and delegate their containers to it, so rewriting that one file moved
all thirty-one without editing any of them. Anyone continuing this work should
look for the next such file before opening thirty individually.

**Stage 3 is roughly two thirds.** 17 files migrated directly on top of those
31: login, signup, the seven `/org` pages, account, three `/admin`, three
Family, and `RecoveryCard`. What remains is the part that cannot be scripted —
Connect's meeting page (41 usages, on its own dark skin), `admin/plans`, the
Family list, and the `row`/`col-md-*` grid that sits *around* components rather
than inside them.

### The measurement that mattered more than the migration

Audited live on `/org/storage`: **65 elements below the 4.5:1 contrast body
text needs. Sixty-three were one colour** — YZEN's `--text-muted: #8d9eb5`, at
2.73:1 on white and 2.48:1 on its own grey. Roughly half the required contrast,
on the captions, hints and secondary labels of the entire console, since the
day the template shipped.

Repointing that single variable at our `--ink-muted` took the page from **65
failures to 1**. The one survivor is the build badge, which is separately
unreadable at 1.1:1 — and separately still reports `unknown`.

**This is the real argument for stage 4.** Deleting YZEN is not tidiness; it
removes a stylesheet whose own defaults are unreadable. Our tokens pass, its
do not.

### Four traps, written down so nobody pays for them twice

1. **Tailwind's preflight is OFF.** `border` sets a width against a style of
   `none` and renders nothing. The fix needs `border-width: 0` **and**
   `border-style: solid` together — because CSS's *initial* border-width is
   `medium` (~3px), invisible only while the style is `none`. Setting the style
   alone drew a 3px box around every element on the page. It is in
   `globals.css` now, with that warning beside it.
2. **The dark rail came from `data-menu-styles` in `layout.tsx`, not from our
   `--rail` token** — and `lib/theme.tsx` set it back to `dark` after
   hydration, so the served HTML said one thing and the browser did another.
   Two places, and changing one looks like a failure of the token.
3. **This repo had four separate `Field` components** — `ui/Modal.tsx`,
   `ConnectSkin.tsx`, one local to signup, and the new shared one. That is what
   an absent component set produces. Two remain; fold them in when you are in
   those files anyway.
4. **Signed-in pages cannot be checked on `localhost`** — the auth cookie is
   scoped to `.tatvaos.com`, so a dev-server session never sticks. Verify those
   by deploying, or by measuring computed styles in the browser against
   production.

### The loop that made this possible

`pnpm web` on `localhost:3000`, with `pnpm --filter @tatvaos/web typecheck` and
`lint` beside it. The typecheck caught a bad prop in four seconds that would
otherwise have cost a commit, a CI run, a merge and a deploy. **Anyone working
this lane should have all three running before they change a line.**

### Bridge, not migration

`overrides.css` now restyles Bootstrap's `.alert-*`, `.btn-close` and
`.form-check-input` with our tokens. That is deliberately **not** a migration:
those pages are still Bootstrap markup and still count as unmigrated on the
stage 3 list. It exists so the product stops looking like two products while
the list is worked through, and so that when YZEN is deleted those rules are
already the real styles rather than a hole. Delete the block to revert.

One rule in that block is worth copying elsewhere. Bootstrap's `.btn-close` is
a background-image X, so it needs a second class (`.btn-close-white`) to work
on a dark ground — and it was still wrong on the grey fallback pill in
`family/[view]`, where the artwork is dark on a dark-ish chip. Our replacement
is a text glyph in `color: inherit`. That is not a shortcut: inside an alert it
takes the alert's ink, on a coloured filter pill it takes that pill's white, on
the grey pill it takes the dark text. One rule, three grounds, no variants. Any
time a control needs a `-white` twin, ask first whether it could just inherit.

### The build badge was unreadable, which is the one thing it must not be

`components/BuildBadge.tsx` was `rgba(130,135,150,.9)` on `rgba(127,127,140,.14)`
— a contrast ratio of **1.1**. For a week the only way to read the commit stamp
was to query the DOM for it, which defeats the reason it exists: to answer "is
this the build I just deployed?" at a glance. It is now `ink-muted` on the
surface with a hairline, about 4.8, and still visually quiet. **Unobtrusive and
unreadable are not the same requirement**, and the badge is the case where the
difference costs a debugging session.

It still prints `unknown`. That is not a styling bug and it is not fixed here:
`next.config.ts` resolves the SHA by reading `.git/HEAD` inside the image, and
the root `.dockerignore` excludes `.git`. The fix is to pass `BUILD_SHA` as a
Docker build arg — `resolveSha()` already prefers `process.env.BUILD_SHA` — not
to ship `.git` into the image. Open with Core.

### Verifying without the developer's machine

`typecheck` needs `node_modules`, and pnpm's store is symlinked in a way a
Linux review sandbox cannot follow, so for two weeks every change from this lane
had to wait on Amit to run `pnpm --filter @tatvaos/web typecheck` by hand.

That is now solved, and the method is worth knowing because it applies to any
pnpm workspace: `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>` are
**real directories**, not links. Copy the ones the app depends on into a flat
`node_modules` beside a copy of the source, add `tsconfig.base.json`, the
`packages/` sources and a stub `.next/types/routes.d.ts`, and `tsc --noEmit`
runs clean in about 35 seconds. Transitive `.d.ts` imports have to be copied too
or they surface as fake errors in our files — a missing `typed-emitter` made
`Room.on` "not exist" in Connect's `Stage.tsx`, which is a sandbox artefact and
not a real failure. **The rule that matters: if the only errors left are in
`node_modules/`, the harness is incomplete, not the code.**

---

## 5. The rule while this is running

**Every new page built from today uses Tailwind and `components/ui/` only.**
No new Bootstrap classes, in any lane, for any reason. The Hire and People
products are about to add many screens; if they are built on YZEN the migration
list grows faster than it shrinks and this document becomes fiction.

That applies to Core, Mail, Connect and the incoming Hire developer equally.

---

## 6. Decisions still needed from Amit

**1. Where does the design come from?** Three honest options:

- **Hire a designer** for a few weeks. Best result, real cost, and they need
  direction from someone about what TatvaOS should feel like.
- **Buy a design system** — a Tailwind component library with a licence.
  Faster, cheaper, and it replaces one purchased opinion with another, but a
  modern one that is actually built for the stack we use.
- **Adopt an open-source system** and accept its choices. Free, well-tested,
  and the product ends up looking like other products built on the same base.

**2. Who does the work?** Nobody is assigned. Core, Mail and Connect are fully
committed; the incoming Hire developer has fifteen phases waiting. Options are a
second new hire, or the Hire developer doing stages 1–2 before starting Hire —
which has the side benefit that Hire's own screens get built on the new system
from the first day rather than migrated later.

**3. Does the look change, or just the plumbing?** Stages 1–3 can be done with
the product looking exactly as it does now — a pure consolidation, low risk,
invisible to customers. Stage 4's visible change is a separate decision and can
wait as long as you like.

---

## 7. What is not in scope

The mobile app (`apps/mobile`) has its own `theme.js` and is not part of this.
It should eventually read the same tokens, but React Native styling is not CSS
and forcing them together now would slow both down.

---

*Related: `docs/HOUSE_RULES.md`, `docs/MOBILE_LANE_BRIEF.md`,
`docs/TATVAOS_HR_ROADMAP.md`. Nobody is assigned to this lane.*
