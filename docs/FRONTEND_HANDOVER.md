# Frontend handover — TatvaOS console, Mail and marketing

Written on handing the front end from the UI/styling lane to the Core
developer. Read the "Traps" section before writing any CSS; most of it was
learned by breaking production-looking pages first.

Scope of what is being handed over: everything under `apps/web/` — the Core
console at `core.tatvaos.com`, Mail at `mail.tatvaos.com`, the marketing pages,
and all deployment of the web app.

---

## 1. Where things stand

The design direction is the **licensed YZEN admin template** (Bootstrap 5),
living in `apps/web/styles/yzen/`. It is not a starting point to be replaced —
it is the product's visual language, and the console is built to render YZEN's
own markup so their stylesheet styles it directly.

The front end is mid-migration off MUI onto that markup. Roughly two-thirds is
done. The remaining MUI files are listed in task 3 below.

**Nothing built in the last week is live.** Production is checked out on
`feature/tatvaos-family-backend`, so deploys from `main` have been no-ops. Six
screens' worth of work is on `main` and reaching nobody. This is the single most
important thing to fix and it is task 2.

---

## 2. Pending tasks, in the order I would do them

### 1. Build and commit `apps/web/app/org/departments/page.tsx`

It is **sitting uncommitted in the working tree right now**. It is the MUI→YZEN
conversion of the departments screen, plus a delete confirmation the old screen
did not have (it deleted a whole department subtree on one click).

```
pnpm --filter @tatvaos/web build
git add apps/web/app/org/departments/page.tsx
git commit -m "refactor(org): departments off MUI onto YZEN markup; confirm before delete"
git push origin main
```

The build is a hard gate — do not commit if it fails. Note there is also
uncommitted work from other lanes in the tree (`infra/`, `docs/setup/`), which
is why the `git add` names one path. **Never `git add -A` in this repo.**

### 2. Point production at `main` — this unblocks everything else

`feature/tatvaos-family-backend` is already **fully merged into `main`**
(verified: its tip is an ancestor of `main`). So pointing the server checkout at
`main` loses nothing — it is strictly a superset. No merge is required, only a
branch switch on the server.

On the server (`ssh deploy@172.105.57.198`, repo `/srv/tatvaos-production`),
switch the checkout to `main` and redeploy. Until that happens every deploy is
theatre. Confirm it worked using the build badge (see Traps).

### 3. Finish the MUI removal

Remaining files that still import `@mui/*`:

- `app/org/users/page.tsx` — the heaviest one left, do it first
- `app/account/page.tsx`
- `app/login/page.tsx`
- `app/signup/page.tsx`
- `app/(marketing)/page.tsx`
- `lib/mui/theme.ts` and `lib/mui/ThemeRegistry.tsx` — delete last

Then drop `@mui/material`, `@mui/material-nextjs`, `@mui/icons-material` and the
three `@emotion/*` packages from `apps/web/package.json`, and remove
`<MuiRegistry>` from `app/layout.tsx`.

This is worth doing on measured evidence, not taste: converted pages come out at
roughly 120 kB First Load JS, unconverted ones at 196–217 kB. That is about
75 kB saved per page.

Follow the pattern already established in `app/org/domains/page.tsx` and
`app/org/departments/page.tsx`. The mapping is mechanical:

| MUI | Replacement |
|---|---|
| `Dialog` + `DialogTitle/Content/Actions` | `Modal` from `components/ui/Modal` |
| `TextField` | `Field` + `<input className="form-control">` |
| `TextField select` / `MenuItem` | `<select className="form-select">` |
| `Switch` + `FormControlLabel` | `<div className="form-check form-switch">` |
| `LinearProgress` | `Meter` from `components/ui/Kit` |
| `CircularProgress` | `<span className="animate-spin rounded-full border-2 …">` |
| `Chip` | `<span className="badge bg-*-transparent">` |
| `Alert` | `<div className="alert alert-danger\|info\|warning">` |
| `Collapse` | plain conditional rendering |
| `Tooltip` + `IconButton` | `<button className="btn btn-icon btn-sm">` with `title` |
| `Box sx={{…}}` | Tailwind classes, or `style` for one-offs |

### 4. Renumber the colliding SQL init files

`local/postgres/init/` has three duplicate prefixes and one gap:

- `13-mail-blocklist.sql` and `13-user-avatars.sql`
- `14-mail-filters.sql` and `14-password-reset.sql`
- `15-mail-search.sql` and `15-signin-alerts.sql`
- no `18-`

Postgres runs these in lexical order, so duplicates currently resolve
alphabetically — which works by luck, not design. Renumber to close the gap
(this is now a pure rename commit; the files are all already merged). Coordinate
with the Mail lane before doing it so nobody is holding a branch that adds
another `15-`.

### 5. Merge the outstanding Mail branches, in this order

`feature/mail-search` (1 commit) → `feature/mail-filters-ui` (3) →
`feature/mail-signatures` (4) → `feature/mail-drafts` (5). They are stacked and
will conflict badly out of order. `feature/mail-quota-policy` (1) is independent
and can go any time.

### 6. Mail UI work that is blocked on the Mail backend

Not startable until the Mail lane ships the underlying endpoints:

- skinning the `@`-mention dropdown and chip in the composer
- the split-view menu (glyphs `split-v`, `split-h`, `split-none` already exist)
- multi-compose (more than one composer window at once)
- blocking "switch account" when the target account has no mailbox

### 7. Smoke-test block/unblock on production

The delivery path (blocklist, filter rules, threading at ingest) merged but was
never exercised against real mail. Do it once production is actually serving
current code.

### 8. Prune the Docker build cache on the server

~52 GB of layers. This is most of why a one-line CSS change takes six or seven
minutes to deploy: the build has to re-resolve and re-copy far more than it
should. `docker builder prune` on the server, then time a deploy again.

### 9. Add a branch guard to `infra/scripts/deploy.sh`

It pulls whatever branch the server checkout happens to be on and says nothing
about it. That is exactly how a week of deploys became no-ops without anyone
noticing. Make it print the branch and refuse to proceed if it is not the
expected one.

---

## 3. Traps — read this before touching CSS

**Tailwind preflight is off.** `corePlugins.preflight: false` in
`tailwind.config.ts`, because YZEN's Bootstrap reboot owns the reset. Two
systems resetting the same elements is worse than one. The consequence: a bare
`<ul>` keeps the browser's default disc bullets and 40 px padding, and a bare
`<input>` keeps its native look. This is what made the collapsed sidebar icons
look broken — invisible bullets pushing them out of frame. Always give lists and
inputs an explicit class.

**YZEN has its own `.grid`, and it is a 12-column Bootstrap grid.** It collides
with Tailwind's `.grid` + `.grid-cols-*`. `styles/overrides.css` neutralises
YZEN's rule and re-declares the *enumerated* `grid-cols-1/2/3/4/…` utilities. It
cannot re-declare arbitrary values — `grid-cols-[200px_1fr]` will be silently
flattened to one column. **Prefer flex for anything that is not a plain N-column
grid.**

**`styles/overrides.css` must load last** in `app/layout.tsx`. Order in that
file is: globals → bootstrap.min.css → styles.css → overrides.css. Changing that
order breaks the console.

**Z-index.** YZEN's `.app-header` is z-index 100 and `.app-sidebar` is 103.
Tailwind's scale stops at `z-50`. Any overlay that must sit above the shell
chrome needs an explicit arbitrary value — the composer uses `z-[1200]` for the
window and `z-[1190]` for its backdrop. A modal at `z-50` will be covered by the
sidebar, which is how the composer's close button became unreachable in full
screen.

**JSX comments.** `{/* … */}` is only valid in *child* position. Inside
`{cond && ( … )}` it is a syntax error and the build fails with a confusing
`Expected '</', got 'className'`. Use a plain `/* … */` there.

**`useSearchParams()` needs a `Suspense` boundary** or the production build
fails — it passes in dev, so this only shows up at build time.

**The build stamp reads `.git` directly.** `next.config.ts` parses `.git/HEAD`
and the ref file by hand rather than shelling out, because the Alpine build image
has no `git` binary. It exposes `NEXT_PUBLIC_BUILD_SHA`, rendered by
`components/BuildBadge.tsx` in the bottom-right of every page. **Use it.** It
exists specifically to catch deploys that silently did not happen, and it has
caught three. Compare the badge on the live site against `git log -1`.

**Authenticated images cannot go in `<img src>`.** A bearer token cannot ride on
an image request, so avatars are fetched as blobs and turned into object URLs.
`lib/avatars.ts` holds a module-level cache plus a small pub/sub
(`bustAvatar` / `onAvatarChange`) so that changing a photo in one place updates
the topbar and account menu without a reload. Reuse it rather than re-solving it.

**Do not use `core.cmd`, `push.cmd` or `mail.cmd`.** They obscure what is
actually being run. Use explicit git commands.

---

## 4. Conventions worth keeping

Deliberate British spelling throughout the UI copy — "organisation", "colour",
"personalise". It is consistent everywhere; keep it.

Error messages relay the server's own words rather than a friendlier rewrite.
The person reading a DNS failure usually has to forward it to whoever manages
their DNS, and "NXDOMAIN looking up TXT" is more use to that person than "check
your settings".

Thresholds live on the server, not in the UI. `Meter` accepts an explicit `tone`
so screens can pass through the API's own `isWarning` / `isCritical` flags
instead of recomputing 80/95 client-side. Two copies of a threshold eventually
disagree, and the one that blocks the action is the one that matters.

Shared primitives are in `components/ui/`: `Kit.tsx` (Card, Button, Badge, Stat,
Table, Meter, Empty), `Modal.tsx` (Modal, Field), `AuthCard`, `PasswordStrength`,
`PhotoPicker`, `UserPhoto`, `AnchoredPopover`, `Charts`. Reach for these before
writing new markup; if something is missing, add it there rather than inline.

---

## 5. What was built recently and is on `main` but not yet visible to users

`/forgot-password` and `/reset-password` (email link plus phone OTP, strength
meter, session revocation on reset). `/org/storage` (pool, per-product
allocations, heaviest mailboxes, allocation dialog that refuses
over-allocation). `/admin/plans` (add/edit/delete). Profile photos end to end
(add-person, edit dialog, account page, topbar, account menu). Composer
minimise / dock / full-screen, signature seeding, draft autosave with BCC. Auto-
hiding icon rail on both Core and Mail, with the Mail rail carrying Mail's own
navigation. The build badge. Six pages converted off MUI.

All of it becomes visible the moment task 2 is done.
