# Connect Phase 1 — the frontend, and what is left

Written while Amit was out, 2026-08-17. Everything here is in the working
tree, uncommitted. Every file typechecks and lints clean against the real
ESLint 9 + tsc harness with `next/core-web-vitals` and `next/typescript`.

---

## The one decision made without you

**`RAIL_PRODUCTS.connect` is still `live: false`.** Flipping it is the launch
switch: it puts the tile in every person's app launcher. It stays off because

1. Core has not reviewed the guest path line by line, and brief §8 makes that
   a gate on *advertising* it, not merely on deploying it; and
2. there is no `connect-logo.png` / `connect-name.png`, so Connect would wear
   the Core logo — the exact silent failure §6 warns about.

Both are one line and one commit away. Nothing else blocks launch.

---

## What was built

| File | What it is |
|---|---|
| `apps/web/lib/connect.ts` | API client. Types for the whole contract, `connectApi` (signed-in) and `guestApi` (no session). |
| `app/connect/(shell)/layout.tsx` | `RequireAuth` + `AppShell scope="connect"`. |
| `app/connect/(shell)/page.tsx` | Today/upcoming/past, live meetings pulled out, join-by-code box, start-now. |
| `app/connect/(shell)/new/page.tsx` | Schedule form. |
| `app/connect/(shell)/meetings/[id]/page.tsx` | Participants, invite link, waiting room, host controls, lock, cancel. |
| `app/connect/room/[code]/page.tsx` | The meeting. Tiles, camera/mic, devices, gallery/speaker, screen share, chat, host controls, waiting room, guest join, reconnection. |
| `connect-phase1-0005-shell-scope.patch` | Core's four shell files. Verified to apply cleanly. |

Two things changed outside the frontend:

- **`GET /api/connect/meetings/by-code/{code}`** (new, in our own module). A
  shareable link carries the *code*; every authenticated route keys on the
  *id*. Without this a colleague clicking a shared link had no way to become
  anything but a guest in their own organisation's meeting. It sits inside the
  authorised group, so RLS scopes it to the caller's tenant and another
  tenant's code answers 404 — the same answer as one that never existed.
- **`livekit-client` added to `apps/web/package.json`.** Phase 0's `/connect/dev`
  loads the SDK from jsDelivr at runtime, which is fine for a throwaway page
  and wrong for a meeting room: a third-party CDN outage should not be able to
  stop a call, and the version should be pinned by the lockfile like everything
  else. **This means you must run `pnpm install` before pushing** — see below.

---

## Run these, in this order

### 1. Windows — install, then verify

`pnpm install` is not optional. CI runs `pnpm install --frozen-lockfile`, which
**fails** when `package.json` and `pnpm-lock.yaml` disagree — and adding a
dependency without regenerating the lockfile is exactly that disagreement.

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git apply connect-phase1-0005-shell-scope.patch
pnpm install
pnpm typecheck
pnpm --filter @tatvaos/web exec eslint app/connect lib/connect.ts
pnpm build
dotnet build apps/api
```

`pnpm build` is the one that matters and the one my harness cannot fully
stand in for. It is also where a missing `<Suspense>` boundary shows up —
production fails while dev passes. I used no `useSearchParams` anywhere in
this tree specifically to stay clear of that.

### 2. Commit

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git add apps/web/lib/connect.ts "apps/web/app/connect/(shell)" apps/web/app/connect/room apps/web/package.json pnpm-lock.yaml apps/web/components/shell apps/web/lib/nav.tsx apps/api/Modules/Connect/Endpoints/ConnectEndpoints.cs infra/scripts/connect-host-controls-test.sh docs/CONNECT_PHASE1_FRONTEND.md connect-phase1-0005-shell-scope.patch
git rm --cached apps/web/app/connect/page.tsx
git commit -m "Connect Phase 1 frontend: shell scope, meetings screens, meeting room"
git push
```

`git rm --cached` is needed because the old coming-soon page is **deleted**:
`app/connect/page.tsx` and `app/connect/(shell)/page.tsx` both resolve to
`/connect`, and Next refuses to build with two pages on one path. I moved the
file into `_to_delete/` because the device bridge cannot unlink; delete that
folder in Explorer whenever you like.

`/connect/dev` is deliberately **kept** for now. The plan said delete it in the
same commit as the room screen, but the room screen has never rendered in a
real browser — keeping the one tool that is known to work, for one more cycle,
is worth more than the tidiness. Delete it once you have joined a real meeting
from `/connect/room/{code}`.

### 3. Server — after CI is green

```bash
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh production
bash infra/scripts/connect-phase1-verify.sh
bash infra/scripts/connect-host-controls-test.sh
```

`connect-host-controls-test.sh` is new and closes the last unproven backend
surface. Mute, remove and end-for-everyone are Twirp calls to LiveKit that had
never executed once, in any environment. It asserts against
`connect.meeting_events` rather than against our own HTTP status, because a
200 from our API only proves our API ran — the same lesson the webhook taught.
A remove that really happened produces a `participant_left` row; an end
produces `room_finished`.

### 4. Then, by hand, the thing no script can do

Open `https://connect.tatvaos.com/connect`, start a meeting, and join it from a
second device. That is the brief's own definition of Phase 1 being done, and
none of the automation above substitutes for it.

---

## What I could not verify, and why

**None of these screens has rendered in a browser.** My sandbox's egress proxy
refuses `connect.tatvaos.com`, so I could not open the app or join a room from
here — that was already established when the headless join attempt failed with
`ERR_TUNNEL_CONNECTION_FAILED`. What I *did* verify: every file typechecks
under their exact `strict` + `noUncheckedIndexedAccess` config, lints clean
under `next/typescript` where `no-explicit-any` is an error, the C# compiles,
and the shell patch applies to a pristine checkout.

So expect layout adjustments, not structural ones. The specific things I would
look at first, in order:

1. **The video wall at three or more people.** Tiles are `flex` +
   `aspect-ratio` with a `320px` basis, deliberately never `grid-cols-*`
   (YZEN's own `.grid` flattens those). The arithmetic is untested against
   real tile counts.
2. **The dark surface against YZEN's Bootstrap.** The room sets its own
   colours inline and sits outside the shell, but the `.btn` and `.alert`
   classes inside it are YZEN's and are styled for light backgrounds.
3. **Screen share on Safari.** `setScreenShareEnabled` is the SDK's problem
   more than ours, but Safari is where it will differ.

---

## Phase 1, honestly, after this

| Brief item | State |
|---|---|
| Schema | Done, deployed, RLS verified |
| Token issuance, secret never in the browser | Done, proven on production |
| Instant / scheduled / join by link or ID | API proven; UI written, unrendered |
| Camera/mic toggle, device selection, gallery & speaker | Written, unrendered |
| Host controls | API written + a test that proves it; UI written, unrendered |
| Waiting room, lock, guest join | Written; doorstep proven; admit→claim untested end to end; **Core review outstanding** |
| Screen sharing | Written, unrendered |
| In-meeting chat (ephemeral) | Written, unrendered — data channel, nothing persisted |
| Reconnection | SDK proven in Phase 0; the UI half written, unrendered |

The honest summary: Phase 1 has gone from roughly a third done to **written in
full, with the backend proven and the frontend unexercised**. The remaining
work is a browser, two review gates, and your logo.

---

## Still owed to you, unchanged

- Core's line-by-line review of the guest path: `ConnectGuestEndpoints.cs`, the
  four `SECURITY DEFINER` functions, the `connect-guest` limiter, patch 0001.
- Six open contract questions in `docs/CONNECT_API.md`.
- The capacity estimate: 5 concurrent meetings of 8 ≈ 280 Mbps outbound;
  monthly transfer, not port speed, is what becomes a bill.
- A known cosmetic bug: `JoinAsync` mints host tokens with the name `"Host"`,
  so the organiser's tile is labelled by role instead of by name. One line, but
  it needs a decision about where the display name comes from.
