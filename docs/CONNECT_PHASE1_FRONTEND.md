# Connect Phase 1 — the frontend

Updated 2026-08-17, second pass: the room UI rebuilt, in-room admission added,
and two bugs the first live meeting exposed.

Everything below has been verified with a **real `next build`** in a harness
carrying your exact `tsconfig` (`strict`, `noUncheckedIndexedAccess`) and
`eslint.config.mjs` (`next/core-web-vitals` + `next/typescript`, where
`no-explicit-any` is an error). Zero warnings from any Connect file.

---

## What changed in this pass

### 1. The room has its own UI

The first version used YZEN's Bootstrap classes on a dark surface — white
`.btn-light` boxes on near-black, which is what you saw. The room now carries
its own stylesheet, because it is the one screen in TatvaOS that sits outside
the shell and fills the viewport.

- Floating control bar: icon-over-label buttons, hover lift, clear on/off
  states (muted is red-tinted, sharing is cyan-tinted) rather than a colour
  swap you have to decode.
- Tiles: 16&nbsp;/&nbsp;9, rounded, and the **active speaker gets a green ring**
  so you can see who is talking without reading names.
- Your own tile is **mirrored**, the way every video app does it — but a
  shared screen never is, because mirrored text is unreadable.
- Camera-off shows a large initial on a soft radial ground instead of a black
  rectangle, which is what makes "their video broke" and "they turned it off"
  distinguishable at a glance.
- Header carries the title, a live dot, the participant count, and Copy link.
- Panels (People / Chat / Settings) slide in from the right at `z-index:1200`
  — above YZEN's sticky chrome, which claims the hundreds.
- Under 640px the labels drop and the bar becomes icons.

The styles are a plain `<style>` element with a string child, **not**
`dangerouslySetInnerHTML` — `react/no-danger` is an error in your config.

### 2. You can let people in from inside the meeting

This was the real gap. Admitting somebody meant leaving the call and opening
the meeting page, which nobody does mid-meeting — so a guest would wait until
they gave up.

Now, for a host or cohost in a live meeting with a waiting room switched on:

- a card slides in at the top right for each person knocking, with their name,
  whether they are a guest, and **Let in / Turn away**;
- the People button carries a count badge;
- the People panel lists everyone waiting above everyone present, with the
  same two actions and per-person Mute / Remove.

Polled every three seconds, and **only while it can matter** — a host, in a
live meeting, waiting room not `off`. A lobby poll for an ended meeting is a
request every three seconds per open tab, forever, whose answer never changes.

### 3. Your tile said "Host (you)"

`DisplayName` was the literal string `"Host"` at creation and `"Participant"`
on join — placeholders that were never replaced. It shipped, and the first
live meeting showed the organiser labelled by role instead of by name.

Fixed in `ConnectEndpoints.cs`: a small `NameOfAsync` reads the person's real
`DisplayName` from `core.users`. The name is **copied onto the participant row**
rather than joined at read time, deliberately — a guest has no user row to join
to, and attendance has to keep reading correctly years later after somebody
leaves the organisation.

### 4. The room was 245 kB before it showed anything

`livekit-client` is ~140 kB, and the door — a name field and a button — needs
none of it. A guest arriving from a link is the least likely person in the
system to be on a fast connection.

The live meeting now loads on demand (`next/dynamic`, `ssr:false`), so the SDK
downloads while they are typing their name:

```
before   ƒ /connect/room/[code]   139 kB   245 kB First Load
after    ƒ /connect/room/[code]  6.87 kB   113 kB First Load
```

That is the room going from the heaviest route in the app to roughly the same
weight as every other page. It cost one extra file.

---

## Files

| Path | |
|---|---|
| `apps/web/app/connect/room/[code]/page.tsx` | **replaced** — the door, and the phase machine |
| `apps/web/app/connect/room/[code]/Stage.tsx` | **new** — the live meeting |
| `apps/web/app/connect/room/[code]/RoomChrome.tsx` | **new** — styles + shared wrappers |
| `apps/api/Modules/Connect/Endpoints/ConnectEndpoints.cs` | **replaced** — real display names |
| `apps/api/Modules/Connect/Endpoints/ConnectWebhookEndpoints.cs` | **replaced** — SyncTenantAsync, and a catch that no longer hides RLS refusals |
| `apps/api/Modules/Connect/Endpoints/ConnectGuestEndpoints.cs` | **replaced** — SyncTenantAsync at both guest sites |
| `infra/scripts/connect-waiting-room-test.sh` | **new** — see below |

If the device bridge was down when these were produced, they arrive as
attachments in the conversation rather than in the repo. Save each to the path
above; the three room files all sit in the same folder.

---

## The waiting-room test

`connect-waiting-room-test.sh` exercises the guest path end to end, with no
session at any point on the guest side: doorstep → knock → parked → host
admits → seat collected. Then it presents the **same wait token a second time
and requires nothing back**.

That last assertion is the one that matters. `claim_lobby_admission` is an
UPDATE-as-check: the row moves to `claimed` only if every condition still holds
at the instant of the write, and the `RETURNING` says whether this caller won.
It means two polls racing cannot both be handed a seat, and a stolen wait token
cannot be replayed after the real guest has used it. That property has never
been exercised outside a sandbox, and it is the whole security argument for the
waiting room — so it is asserted explicitly rather than assumed.

It also checks that unknown, malformed and near-miss codes are **byte-identical**
in their refusal, that a denied guest is told so and gets no token, and that a
locked meeting refuses newcomers with 409.

It will stop early with a clear message if
`core.tenants.allow_connect_guests` is off for your organisation — otherwise
every check would fail for that one reason and look like something else.

---

## Run these

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
pnpm build
dotnet build apps/api
git add apps/web/app/connect/room apps/api/Modules/Connect/Endpoints infra/scripts/connect-waiting-room-test.sh docs/CONNECT_PHASE1_FRONTEND.md
git commit -m "Connect: room UI, in-room admission, real names, SDK off first load, and push tenant scope into the DB session"
git push
```

Then after CI:

```bash
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh production
bash infra/scripts/connect-phase1-verify.sh
bash infra/scripts/connect-waiting-room-test.sh
bash infra/scripts/connect-host-controls-test.sh
```

`connect-host-controls-test.sh` is still owed a passing run — its last attempt
stopped at "nobody joined", which was the webhook not recording rather than the
host controls themselves. The section below is why, and what changed.

---

## The missing rows — diagnosed, and it was TWO bugs

`connect.meeting_events` had never gained a row. The first fix
(`webhook_meeting_tenant`) was necessary and not sufficient, and the second
bug is why the first one appeared not to work.

**Proven against a real PostgreSQL, migration applied from scratch:**

```
definer fn, no tenant   -> 11111111-1111-...   the read works
INSERT,     no tenant   -> ERROR: new row violates row-level security policy
                                  for table "meeting_events"
INSERT,     tenant set  -> INSERT 0 1
```

So the read was only half of it. `EnterAnonymousScope` changes a C# object;
`app.tenant_id` is what RLS actually reads, and the interceptor only sets it
when a connection **opens**. The handler then INSERTs on a session that still
carries no tenant, the policy refuses it, EF raises `DbUpdateException` — and
the handler **swallowed every one of them** and answered 200. LiveKit never
retries a 200, so each event was lost for good while every log said delivered.

**Connect was the only module in the codebase doing this.** Auth and Admin
call `db.SyncTenantAsync(ct)` on the line immediately after changing tenant
scope, sixteen times between them, with a comment in `AuthEndpoints` spelling
out why. Connect had three `EnterAnonymousScope` calls and zero syncs. Fixed at
all three — the webhook and both guest sites, so guest joins were carrying the
same latent bug.

`SyncTenantAsync` is a no-op when the connection is closed (the interceptor
handles the next open), so adding it is safe whichever way EF was behaving —
it removes the question rather than betting on the answer.

The catch is now honest: a `23505` unique violation on `webhook_id` is still a
silent no-op, because that is a genuine replay. **Anything else logs an error
and returns 500**, which is visible and which makes LiveKit retry. Had it been
written that way, both of these bugs would have announced themselves the first
time instead of hiding for a day.

**One caveat, stated plainly:** this is proven as a *mechanism*, not as *the*
cause of what you saw. The deploy log showed `web` recreated but `api` only
started, so the container may also have been running pre-fix code. Both
explanations fit "no rows". The difference no longer matters much — the fix is
correct either way, and a silent failure can no longer happen. If rows still do
not appear after this deploy, `docker compose ... up -d --force-recreate api`
is the next move.

## Phase 1 status

| Brief item | State |
|---|---|
| Schema | Done, deployed, RLS verified |
| Token issuance, secret never in the browser | Done, proven |
| Instant / scheduled / join by link or ID | Done; room proven live in a browser |
| Camera/mic toggle, device selection, gallery & speaker | Written; camera/mic proven live |
| Host controls | Written; **test not yet passing** |
| Waiting room, lock, guest join | Written; test written, not yet run; **Core review outstanding** |
| Screen sharing | Written, unexercised |
| In-meeting chat | Written, unexercised |
| Reconnection | SDK proven in Phase 0; UI written, unexercised |

Still blocking launch, unchanged: Core's line-by-line review of the guest path,
your logo pair, and a tile colour that is not Family's `#00b8d9`.
`RAIL_PRODUCTS.connect` stays `live: false` until all three land.
