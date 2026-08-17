# TatvaOS Connect — developer brief

**For the developer taking Connect end to end: backend, frontend, and
deployment at `connect.tatvaos.com`.**

Read this before writing anything. It is long because the platform has rules
that were learned expensively, and because the biggest risk in this product is
building the wrong thing quickly rather than the right thing slowly.

---

## 0. Welcome — what you are joining

### What TatvaOS is

A **Google Workspace for Indian organisations**: mail, files, calendar and
identity under one login, one bill, and one administration console, hosted in
India. Our customers are schools, clinics, small businesses and family trusts —
people for whom "your data is in another country and your support is a help
article" is a real objection.

Everything is **multi-tenant**. One deployment serves every customer
organisation, and the line between them is enforced in the database itself
(Postgres row-level security), not in application code. Internalise that
sentence; §3 explains what it means for you.

### The products

| Product | Where | State | Owner |
|---|---|---|---|
| **Core** — identity, sign-in, MFA, org & departments, people, domains, storage, billing, audit, and the whole console UI | `tatvaos.com`, `account.tatvaos.com` | Live | Core (me) |
| **Mail** — mailboxes, webmail, shared mailboxes, aliases, the Postfix/Dovecot edge | `mail.tatvaos.com` | Live | Mail dev + Core (client UI) |
| **Space** — Drive-style file storage, sharing, public links | `space.tatvaos.com` | Live | Space dev + Core (UI) |
| **Calendar** — events, recurrence, invitations, reminders | `calendar.tatvaos.com` | Live | Core |
| **Family** — a consumer-side product for households | `family.tatvaos.com` | Live | Core |
| **Connect** — video meetings | `connect.tatvaos.com` | **Yours. Not built.** | You |

Not built and not promised: Docs, Sheets, People/HR, Payroll. They were
deliberately removed from the customer-facing catalogue — we show a product
only once it exists.

### The team, and how it works

Small and lane-based. Three developers plus Amit.

- **Amit** — founder. Owns priorities, infrastructure access, and the customer
  relationships. Every message between developers is relayed through him, so
  write to be understood without a follow-up.
- **Core (me, CTO)** — Core backend, Calendar, and *all* frontend across
  every product. I review other lanes' API contracts and their security-
  sensitive code before it ships. I am your reviewer and the person to argue
  with when something in this document is wrong.
- **Mail developer** — the mail backend and the SMTP/IMAP edge.
- **Space developer** — the storage backend.
- **You** — Connect, both halves plus deployment. You are the first person here
  to own a product end to end, which is a lot of freedom and the reason §3
  exists.

**How lanes cooperate:** you do not edit another lane's files. You agree a
written contract, then each side builds to it. Cross-lane code moves as
`git apply` patches, never as "I pushed a fix to your folder" — a patch
refuses to apply against the wrong revision instead of silently overwriting
someone's work. Four separate incidents in one week came from ignoring that.

**Contract first, always.** Write the API contract as a markdown document in
`docs/`, send it for review, then write code. Every lane that has done this
shipped clean; every lane that skipped it shipped a rewrite. `docs/SPACE_API.md`
is the model to copy.

### Your first day

1. Get the repo, get local Docker Compose up, sign in to the console.
2. Read `docs/README.md`, then `docs/STORAGE_MODEL.md`, then §3 below.
3. Read `Modules/Calendar/` end to end — it is the newest module, so it is the
   cleanest example of a module, a migration, RLS policies, and endpoints.
4. Then §1, and start on Phase 0. Not features. Phase 0.

Ask early and often. A question costs ten minutes; a wrong assumption about
tenancy costs a week and possibly a customer.

---

## 1. What Connect is, and the one decision that decides everything

Connect is video meetings for TatvaOS — our Google Meet. The feature list runs
to about 270 items. **That list is the destination, not the plan.** The plan
is below.

### DO NOT BUILD THE MEDIA LAYER

The instinct is to reach for raw WebRTC peer connections. It works beautifully
for a two-person demo and collapses at five: peer-to-peer means every
participant uploads their video to every other participant, so a 5-person
meeting asks each laptop for 4 outbound video streams. Ordinary office
upstream cannot do it. Every video product that has ever shipped solves this
with an **SFU** (Selective Forwarding Unit): each participant sends one stream
up, the server fans it out.

Writing an SFU is a multi-year specialism — congestion control, simulcast,
packet loss recovery, jitter buffers, NACK/PLI, bandwidth estimation. We are
not doing that.

**Use LiveKit** (Apache-2.0, self-hostable, mature client SDKs for web,
Android and iOS, built-in recording via the Egress service). Alternatives
considered and why not:

- **mediasoup** — excellent and lower-level, but you build the signalling,
  the room model, reconnection and recording yourself. Months of work LiveKit
  gives you.
- **Jitsi** — a whole product, hard to embed as a component of ours without
  inheriting its UI and its opinions.
- **A SaaS API (Daily, Agora, Twilio)** — fastest to demo, but per-minute
  pricing on a product we sell per-seat inverts the economics, and meeting
  media would leave our infrastructure, which is exactly what an Indian
  school or hospital customer will ask about.

**Your first week is not features. It is: LiveKit running on the box, two
browsers in a room, audio and video both directions, through a TURN server,
from two different networks.** Nothing else matters until that works.

---

## 2. Where Connect lives in the platform

### The API is a module in the existing monolith, NOT a new service

`apps/api/Modules/Connect/` alongside Mail, Space, Family, Calendar. One
process, one deploy, one database, one identity. A separate service means its
own auth, its own tenancy, its own deploy pipeline, and cross-service calls
for everything.

**The exception is the media server**, which IS separate — LiveKit runs as its
own container. That is infrastructure, not business logic. Connect's API
module issues LiveKit access tokens and reacts to LiveKit webhooks; it never
touches media itself.

```
Browser ──── signalling + media (WebSocket/WebRTC) ────► LiveKit container
   │                                                          │
   └──── REST (rooms, tokens, history) ────► TatvaOS API ◄─────┘  webhooks
                                                  │
                                            Postgres (connect.*)
```

### What already exists, done for you

- `connect.tatvaos.com` — DNS is live, `infra/docker/conf.d/connect.caddy`
  is written, `CONNECT_DOMAIN` is in the compose file and `.env`.
- A "being built" page at `apps/web/app/connect/page.tsx` — replace it.
- The `connect` row in `core.products`, and the launcher tile (currently
  `live: false` in `apps/web/lib/nav.tsx` — flip it when you ship).
- Identity, sign-in, MFA, sessions, org/departments, audit — all Core's, all
  yours to use, none of it yours to rebuild.

---

## 3. Platform rules that are not negotiable

These were each learned from an outage or a bug. Breaking them costs a day
minimum.

**Tenancy is RLS.** Every content table gets `tenant_id`, `ENABLE` **and**
`FORCE ROW LEVEL SECURITY`, and a policy comparing to
`nullif(current_setting('app.tenant_id', true), '')::uuid`. The `nullif` is
not optional: the connection interceptor sends an unset user as an **empty
string**, and a bare `::uuid` cast on `''` throws and takes the request with
it. Copy the pattern from `20260816-calendar.sql`.

**The app connects as `tatvaos_app`, which is `NOBYPASSRLS`.** If you ever
find yourself connecting as `postgres` to make a query work, you have
disabled tenant isolation and the query will happily return every customer's
data.

**Migrations are date-prefixed:** `local/postgres/init/20260901-connect.sql`.
They are plain SQL, idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`), and run
**on every deploy** — so they must be safe to run repeatedly. Numbered
prefixes collided three times in two days; do not revive them.

**`deploy.sh` applies schema BEFORE recreating app containers.** So additive
columns are safe; a migration that *removes* something old code still reads
will break the running app. Add, backfill, switch, remove — across two
deploys, never one.

**Every `conf.d/*.caddy` file needs its variable set in `infra/docker/.env`.**
A mounted site file with an unset variable makes Caddy reject the *entire*
config and crash-loop — taking Core, Mail and Space down with it. `connect.caddy`
and `CONNECT_DOMAIN` are already in place; if you add a second hostname (a
media subdomain, say), add the variable in the same commit.

**Storage is one allowance per person, across all products.**
`core.user_storage(user_id)` is the single definition of "is this person
full". Do not write your own `SUM` — see `docs/STORAGE_MODEL.md`. **Recordings
are the largest objects this platform will ever store, and they belong to the
ORGANISATION, not the host** (the same rule as shared mailboxes): charge them
to the org pool, or one person's quota disappears because they hosted the
all-hands.

**Frontend:** Next.js 15 / React 19, YZEN Bootstrap + Tailwind with preflight
off. You do **not** design a layout — Connect is a new *scope* in the shell
every other product already uses. **§6 is the whole of it. Read it before you
write a component.**

**Working practice:** one clone per lane; every command block starts with
`git checkout main`; `git add` explicit paths only. Share code as `git apply`
patches — a patch refuses to apply against the wrong revision instead of
silently overwriting someone's work. Four incidents in one week came from
skipping this.

**Contract first.** Write the API contract as a markdown document, send it to
Core for review, then build. Every lane that has done this shipped clean;
every lane that skipped it shipped a rewrite. See `docs/SPACE_API.md` for the
shape.

---

## 4. Build order

Each phase ends with something a real person can use. Do not start a phase
until the previous one is deployed and working in production.

### Phase 0 — Prove the media path (week 1)

LiveKit container in `docker-compose.base.yml`, **coturn** for TURN, and a
throwaway page where two browsers join a hardcoded room. Test **from two
different networks**, one on mobile data. If it only works on your LAN you
have not tested anything: TURN exists precisely for the 15–20% of connections
that cannot go direct, and corporate firewalls are the common case for a
business product.

Deliverable: two people, two networks, audio and video, five minutes without
dropping.

### Phase 1 — Meetings that work (weeks 2–5)

The minimum honest product:

- Schema: `connect.meetings`, `connect.participants`, `connect.meeting_events`
- Instant meeting; scheduled meeting; join by link or ID
- Token issuance: our API mints LiveKit JWTs — **never** ship the LiveKit API
  secret to the browser
- Camera/mic toggle, device selection, gallery and speaker view
- Host controls: mute someone, remove someone, end for everyone
- Waiting room, meeting lock, and guest join for people with no account
- Screen sharing
- In-meeting chat (ephemeral — persistence is Phase 3)
- Reconnection that actually works: dropping wifi and coming back must rejoin,
  not strand a black rectangle

Features 1–73 of the list, roughly. This is the product. Everything after is
differentiation.

### Phase 2 — The ecosystem seams (weeks 6–8)

This is where Connect stops being "another video app". **All three are
contracts with other lanes — you do not write code in their files.**

- **Calendar** (Core's): a "Connect meeting" toggle on an event that generates
  the link. Calendar already stores `meeting_url` on the event and already
  sends invitations. You provide an endpoint that mints a meeting for an
  event id; Core wires the toggle.
- **Mail** (Mail dev's): invitations, reminders, cancellations. Mail sends;
  you supply content. Agree the seam in writing first — see
  `docs/MAIL_IMIP_SEAM.md` for how that conversation goes.
- **Space** (Space dev's): recordings, transcripts and reports land in a
  `Meetings/<meeting name>/` folder via `SpaceContentGateway` —
  `EnsureFolderAsync` + `SaveAsync`. Never insert `space.files` rows yourself.

### Phase 3 — Recording and attendance (weeks 9–12)

**Attendance is the easy half and the bigger differentiator.** You already
have the data: LiveKit webhooks fire on every join and leave. Store each as a
row in `connect.meeting_events` and every number in features 135–148 (joins,
leaves, rejoins, duration, late, early, percentage) is a query over those
rows. Do not try to maintain a running "is present" flag — store the events
and compute the report.

**Recording** is LiveKit Egress → our blob storage via Space. Three things
that are not optional:
- **Consent.** Every participant must be told, visibly and before it starts,
  that recording is on. In several jurisdictions recording without notice is
  illegal; in all of them it is a betrayal. A banner, not a tooltip.
- **Retention.** A per-org policy with a default, because unbounded video
  storage is how a customer's bill becomes a support ticket.
- **Access control.** A recording is the most sensitive object we will ever
  store. Reuse Space's permissions rather than inventing a second model.

### Phase 4 — AI (week 13+, and only after a serious conversation)

Transcription, summary, action items. Genuinely valuable, and **the part that
needs a decision above your pay grade before a line is written**:

Meeting audio is the most confidential data our customers have. Sending it to
a third-party AI service (OpenAI, Google, Anthropic) means their private
conversations leave our infrastructure and India. Under the DPDP Act that
requires explicit, informed consent, and for a school or hospital it may be a
deal-breaker. The alternative — self-hosted Whisper plus a local model — means
GPU cost and worse quality.

**Bring this to Amit as a decision with both options costed. Do not pick it
yourself, and do not start by wiring up an API key.** Whichever way it goes,
it needs a per-org toggle that is OFF by default and an in-meeting indicator
when the assistant is listening.

---

## 5. Infrastructure — what you must ask for

The current production box is a single Linode running the whole platform.
**Connect will not fit on it**, and finding that out during a customer demo is
the bad path.

- **Bandwidth is the constraint, not CPU** (until recording). An SFU relays
  every stream: 10 people at 1 Mbps each is ~10 Mbps in and up to ~90 Mbps
  out. Estimate for your target concurrent meetings and check it against the
  server's actual network allowance before you promise anything.
- **coturn** on a public IP, UDP 3478 plus a relay port range, and TLS on 5349
  for networks that block UDP entirely.
- **Recording needs CPU and disk** — Egress transcodes. Budget a separate
  worker if recording is on by default.
- **Ports:** LiveKit wants a UDP range open. Caddy proxies HTTP/WebSocket
  signalling; media does not go through Caddy.

Write the capacity estimate down and give it to Amit **before** Phase 1 ends,
not when it breaks.

---

## 6. Frontend — the shell, the rail, the logo, the top bar

**The rule: Connect looks like TatvaOS, not like Connect.** A customer moving
from Mail to Space to Connect must not feel they changed products. The chrome
is already built and shared; your job is to add a scope to it, not to design
one. Every screen except the meeting room itself is `AppShell` with different
contents.

```tsx
<AppShell scope="connect" brand="TatvaOS Connect"
          sections={connectNav()}
          railFooter={<RailStorage />}
          title="Meetings">
  …
</AppShell>
```

### Registering the scope — four files, or it breaks quietly

`scope` is a **union type repeated in three components**, and one derived
lookup keys off it. Miss any of them and you get either a compile error or,
worse, the wrong logo with no error at all.

1. `components/shell/AppShell.tsx` — add `'connect'` to the `scope` union.
2. `components/shell/Sidebar.tsx` — same union, **and** the `logo` ternary
   just below it. That ternary lists scopes explicitly and falls back to
   `'core'`; forget it and Connect silently wears the Core logo.
3. `components/shell/Topbar.tsx` — same union.
4. `lib/nav.tsx` — flip the `connect` entry in `RAIL_PRODUCTS` to
   `live: true` when you ship, and add `connectNav()`.

### The logo

Two files, referenced by convention as `/brand/<scope>-logo.png` and
`/brand/<scope>-name.png`:

- `apps/web/public/brand/connect-logo.png` — the **mark**, a self-contained
  badge, rendered at 32px high.
- `apps/web/public/brand/connect-name.png` — the **wordmark**, dark artwork on
  transparent, rendered at 30px high.

Source artwork lives in `Logo/` at the repo root (`TatvaOS_Mail_Logo.png`,
`TatvaOS_Space_Name.png`, and so on) — ask Amit for the Connect pair and
follow the naming above when you add them. The brand header sits on **white**
(`overrides.css` forces it) so it lines up with the white top bar; artwork that
assumes a dark background will look wrong there. When the rail is collapsed to
icons the wordmark is hidden by CSS and only the mark shows — check that the
mark reads at 32px on its own.

### The left rail

Data-driven. You write one function in `lib/nav.tsx` returning
`NavSection[]`; `Sidebar` renders it into YZEN's exact markup. Do not write
rail markup.

```tsx
export function connectNav(): NavSection[] {
  return [{
    heading: 'Connect',
    items: [
      { href: '/connect/new',      label: 'New meeting', icon: <Icon d={PATHS.connect} colour="#03b562" /> },
      { href: '/connect',          label: 'Meetings',    icon: <Icon d={PATHS.calendar} colour="#00b8d9" /> },
      { href: '/connect/recordings', label: 'Recordings', icon: <Icon d={PATHS.drive} colour="#7367f0" /> },
    ],
  }];
}
```

Four things about that shape that are not cosmetic:

- **Colour every icon.** At 4rem collapsed the icon *is* the item — the labels
  are hidden, and colour is the only thing that makes one findable at a glance.
- **Real paths, never query strings.** The rail resolves the active item by
  `pathname` (longest match wins). Three links to `/connect?view=…` all light
  up at once.
- **Unfinished entries are `disabled: true` with `badge: 'soon'`,** not hidden.
  A menu that hides unbuilt work gets the same feature requested three times.
- `PATHS.connect` already exists in `lib/nav.tsx`. Reuse the `Icon` helper;
  don't import an icon library.

**Rail slots.** `AppShell` takes `railHeader` (under the brand, for context
that changes what the nav beneath it means — Mail uses it for the mailbox
switcher) and `railFooter` (pinned at the bottom). **Put `<RailStorage />` in
`railFooter`, exactly as Mail, Space, Family and Calendar do.** It is one
meter and one number for the person's whole account; a Connect-specific
storage display would recreate the confusion the storage rework removed. Both
slots collapse away with the rail — that is handled in `overrides.css`,
not by you.

> **The trap that cost several rounds:** anything rendered as a *sibling* of
> `.main-sidebar` is invisible. YZEN gives that element a calculated height and
> its own scroll, so siblings land past the bottom of the rail and look like a
> broken component. `Sidebar` already places both slots correctly — the rule
> matters the moment you are tempted to add a third slot yourself.

### The top bar

**You do not build one.** `Topbar` is shared and rendered by `AppShell`: rail
toggle, search field, app launcher, dark/light toggle, avatar and account
menu. It is `position: sticky` and white in both themes.

If Connect needs a global action in the bar (there is a case for "join with a
code"), that is a change to a **shared** component — propose it to Core first.
The launcher grid, the theme toggle and the avatar behave identically in every
product on purpose; a bar that changes shape per product is how a suite stops
feeling like one.

Two details you will otherwise trip on:

- The launcher tile for Connect exists in `RAIL_PRODUCTS` with
  `colour: '#00b8d9'`, **which is the same cyan as Family.** Tile colour is how
  people find an app in a grid without reading it, so pick a distinct one and
  agree it with Amit in the same commit that flips `live: true`.
- The `live: false` tile currently routes to `app/connect/page.tsx`, the
  honest coming-soon page. Replacing that file *is* your launch switch.

### The meeting room is the one screen that leaves the shell

Deliberately. In a call the video is the interface — Meet, Zoom and Teams all
go full-bleed, and a rail plus a top bar would eat a third of the frame.

- `/connect/room/[id]` renders **outside** `AppShell`: no rail, no top bar,
  its own dark surface regardless of the theme toggle.
- Everything else — meeting list, scheduling, recordings, settings — stays
  inside the shell so people can get back to the rest of TatvaOS in one click.
- The room is also the one place a **guest with no account** ever sees, so it
  must render with no `useAuth` session and no launcher. Build it assuming
  there is no signed-in user, then add the extras for people who are.

### CSS traps — each of these has cost a real day

- **YZEN ships its own `.grid`** which overrides Tailwind's `grid-cols-*`
  unless that exact count is re-declared in `styles/overrides.css`. A
  participant grid built with `grid-cols-3` will silently flatten to one
  column. **Build the video tile layout with flex and `aspect-ratio`** — it
  needs to be fluid across participant counts anyway.
- **Z-index:** YZEN sets `.app-header` to 100 and `.app-sidebar` to 103, so
  Tailwind's `z-50` renders *behind* the shell. Overlays — device pickers,
  in-meeting menus, modals — need `z-[1200]`.
- `styles/overrides.css` must load **last**.
- Tailwind **preflight is off** (YZEN's reboot owns the reset), so bare
  `<ul>`, `<input>` and `<button>` keep browser defaults. Style them.
- `{/* … */}` is a syntax error inside `{cond && ( … )}` — use `/* … */`.
- `useSearchParams()` needs a `<Suspense>` boundary or the **production**
  build fails while dev passes. A join link carrying `?code=` will hit this.
- Use `Kit` components (`Card`, `Button`, `Badge`, `Table`, `Empty`, `Meter`,
  `Stat`) from `components/ui/Kit.tsx`. Badge tones are `ok|warn|danger|info|
  neutral`, not Bootstrap names.

### Verifying frontend work

`pnpm typecheck` at the repo root (~12s) before every commit — it is far
faster than a full build and catches most of it. Then **have a human look at
the page**: `tsc` cannot see a layout regression, and every shell bug in this
document passed typecheck. `NEXT_PUBLIC_BUILD_SHA` renders a build badge in
the bottom-right of every page; compare it against `git log -1` to catch a
deploy that silently did not happen. It has caught three.

---

## 7. Security — the parts specific to Connect

Everything in the platform's security model applies, plus:

- **The LiveKit API secret never leaves the server.** The browser gets a
  short-lived, room-scoped JWT that our API minted after checking the person
  may join *that* meeting. A token that grants "any room" is a token that
  joins any customer's board meeting.
- **Guest join is an unauthenticated path** — treat it with the paranoia that
  earns: one meeting id, no listing, no enumeration, rate-limited, and a
  waiting room by default for anyone outside the organisation.
- **A meeting id is a capability.** Long and random, never sequential.
- **Recordings, transcripts and AI summaries each need their own access
  decision**, not one blanket "meeting participants can see everything" — the
  person who left after five minutes should not automatically get the
  recording of the hour they missed.
- **Audit** every host action (recording started, participant removed,
  meeting locked) to `core.audit_logs` with `productCode: "connect"`.

---

## 8. What NOT to do

- Do not build an SFU.
- Do not put Connect in a separate service.
- Do not start with AI. It is the most fun and the least useful until a
  meeting reliably connects.
- Do not build mobile apps in v1. The browser works on mobile; native apps are
  a second product with their own release cycle.
- Do not implement all 270 features. Ship Phase 1 to real users and let their
  complaints order the rest.
- Do not write into another lane's files. Agree a seam, exchange patches.
- Do not build your own shell, rail or top bar, and do not change the shared
  ones without asking Core — see §6. The only screen that leaves the shell is
  the meeting room.
- Do not deploy the anonymous guest path without asking Core for a review, the
  same rule Space's public links followed.

---

## 9. How you will be judged

Not on feature count. On this: **two people in different cities, on ordinary
office wifi, can join a meeting from a Calendar invitation, see and hear each
other for an hour without a reconnect, and afterwards find the attendance
report in Space.** That single sentence is worth more than two hundred
half-working features, and it is the demo that sells the suite.

## Where to look in the codebase

| For | Read |
|---|---|
| Module + RLS + migration pattern | `Modules/Calendar/`, `20260816-calendar.sql` |
| Contract-first process | `docs/SPACE_API.md`, `docs/SPACE_API_PUBLIC_LINKS_ADDENDUM.md` |
| An anonymous endpoint done carefully | `Modules/Space/Endpoints/SpaceLinkEndpoints.cs` |
| Cross-product seams | `Modules/Space/SpaceContentGateway.cs`, `docs/MAIL_IMIP_SEAM.md` |
| Storage rules | `docs/STORAGE_MODEL.md` |
| Shell, rail, top bar | `components/shell/{AppShell,Sidebar,Topbar,RailStorage}.tsx` |
| Rail data + launcher tiles | `lib/nav.tsx` (`RAIL_PRODUCTS`, `spaceNav`, `calendarNav`) |
| CSS traps in full | `docs/FRONTEND_HANDOVER.md`, `styles/overrides.css` |
| Deployment | `infra/scripts/deploy.sh`, `docs/runbooks/` |

Questions to Core (via Amit) early and often. A contract reviewed before
coding has saved every lane here at least a week.

---

## Appendix A — the complete feature list

Amit's list, **exactly as written**, with one thing added: a phase tag on
every line.

- `[P1]`–`[P4]` — the phase from §4. Build by phase, not by number.
- `[Core]` — the platform already provides this. Consume it; do not build it.
- `[deferred]` — deliberately not in v1. See §8.

A tag on a category heading is that category's default; individual lines
override it. Numbering is Amit's own, including the quirks (105 is skipped,
147 appears twice, "raise hand" is both 62 and 175) so his numbers and yours
always match.

### 1. User & Account  `[Core]`
1. TatvaOS login  `[Core]`
2. SSO with TatvaOS Core  `[Core]`
3. User profile  `[Core]`
4. Profile photo  `[Core]`
5. Name, designation and organization  `[Core]`
6. Personal meeting settings  `[P1]`
7. Device management  `[Core]`
8. Active sessions  `[Core]`
9. Login/security history  `[Core]`
### 2. Dashboard  `[P1]`
10. Upcoming meetings  `[P1]`
11. Today's meetings  `[P1]`
12. Start instant meeting  `[P1]`
13. Join meeting  `[P1]`
14. Schedule meeting  `[P1]`
15. Recent meetings  `[P1]`
16. Recent calls  `[P3]`
17. Unread chats  `[P3]`
18. Meeting invitations  `[P1]`
19. Missed calls  `[P3]`
20. Quick access to contacts  `[P1]`
### 3. Meetings  `[P1]`
21. Instant meeting  `[P1]`
22. Scheduled meeting  `[P1]`
23. Recurring meeting  `[P2]`
24. Private meeting  `[P2]`
25. Meeting ID  `[P1]`
26. Custom meeting link  `[P2]`
27. Meeting password  `[P1]`
28. Waiting room  `[P1]`
29. Guest/anonymous joining  `[P1]`
30. Host and co-host  `[P1]`
31. Meeting duration  `[P1]`
32. Time-zone support  `[P1]`
33. Meeting lock  `[P1]`
34. End meeting for everyone  `[P1]`
35. Rejoin meeting  `[P1]`
36. Meeting history  `[P1]`
### 4. Video & Audio  `[P1]`
37. 1-to-1 video call  `[P1]`
38. Group video meeting  `[P1]`
39. Voice-only call  `[P1]`
40. Camera on/off  `[P1]`
41. Microphone on/off  `[P1]`
42. Speaker selection  `[P1]`
43. Camera selection  `[P1]`
44. Background blur  `[P3]`
45. Virtual background  `[P3]`
46. Noise suppression  `[P1]`
47. Echo cancellation  `[P1]`
48. Automatic quality adjustment  `[P1]`
49. Network-quality indicator  `[P1]`
50. Automatic reconnection  `[P1]`
51. Low-bandwidth mode  `[P1]`
52. Full-screen mode  `[P1]`
53. Gallery/speaker view  `[P1]`
### 5. Participant Management  `[P1]`
54. Participant list  `[P1]`
55. Mute participant  `[P1]`
56. Remove participant  `[P1]`
57. Make co-host  `[P1]`
58. Disable participant camera  `[P1]`
59. Allow/disallow screen sharing  `[P1]`
60. Allow/disallow chat  `[P1]`
61. Admit from waiting room  `[P1]`
62. Raise hand  `[P1]`
63. Participant status  `[P1]`
64. Participant search  `[P1]`
65. Meeting lock  `[P1]`
### 6. Screen & Content Sharing  `[P1]`
66. Share entire screen  `[P1]`
67. Share application  `[P1]`
68. Share browser tab  `[P1]`
69. Share system audio  `[P1]`
70. Presentation mode  `[P2]`
71. Multiple presenters  `[P2]`
72. Stop participant sharing  `[P1]`
73. Shared content history  `[P2]`
### 7. Meeting Chat  `[P3]`
74. Meeting chat  `[P1]`
75. Private participant chat  `[P3]`
76. Group chat  `[P3]`
77. Send files  `[P3]`
78. Send images  `[P3]`
79. Emoji  `[P1]`
80. Reply to message  `[P3]`
81. Edit message  `[P3]`
82. Delete message  `[P3]`
83. Message search  `[P3]`
84. Pin important message  `[P3]`
85. Download shared files  `[P3]`
### 8. TatvaOS Contacts Integration  `[P2]`
86. Use central TatvaOS Contacts  `[P2]`
87. Search contacts  `[P2]`
88. Start video call from Contacts  `[P2]`
89. Start voice call  `[P2]`
90. Start chat  `[P2]`
91. View contact details  `[P2]`
92. Recent communication  `[P2]`
93. Suggested contacts  `[P2]`
94. Organization directory  `[P2]`
---
### 9. TatvaOS Calendar Integration  `[P2]`
95. Schedule Connect meeting from Calendar  `[P2]`
96. Automatically generate meeting link  `[P2]`
97. Calendar invitation  `[P2]`
98. Recurring meetings  `[P2]`
99. Reminder notifications  `[P2]`
100. Join button inside Calendar  `[P2]`
101. Reschedule meeting  `[P2]`
102. Cancel meeting  `[P2]`
103. Automatic participant notification  `[P2]`
104. Time-zone conversion  `[P2]`
---
### 10. TatvaOS Mail Integration  `[P2]`
106. Send meeting invitation through Mail  `[P2]`
107. Join meeting directly from Mail  `[P2]`
108. Meeting reminder email  `[P2]`
109. Meeting cancellation email  `[P2]`
110. Meeting reschedule email  `[P2]`
111. Missed-meeting notification  `[P2]`
112. Meeting recording email  `[P3]`
113. Meeting transcript email  `[P4]`
114. **AI Summary email**  `[P4]`
115. **Attendance report email**  `[P3]`
116. Action-item email  `[P4]`
117. Follow-up email  `[P4]`
118. Meeting attachments  `[P2]`
---
### 11. ⭐ AI Meeting Summary  `[P4]`
This should be one of the flagship features.
119. Enable/disable AI Meeting Assistant  `[P4]`
120. Live transcription  `[P4]`
121. Automatic meeting transcription  `[P4]`
122. Speaker identification  `[P4]`
123. AI meeting summary  `[P4]`
124. Key discussion points  `[P4]`
125. Important decisions  `[P4]`
126. Action items  `[P4]`
127. Questions raised  `[P4]`
128. Important topics  `[P4]`
129. Next steps  `[P4]`
130. Mentioned dates/deadlines  `[P4]`
131. Important names/projects  `[P4]`
132. Search transcript  `[P4]`
133. AI-generated title  `[P4]`
134. AI-generated short summary  `[P4]`
135. Detailed summary  `[P4]`
### After meeting
If the host has enabled **AI Summary**:
```text
Meeting Completed
AI Summary
↓
Generate Summary
↓
Save to TatvaOS Space
↓
Share via TatvaOS Mail
```
The host should be able to select:
* **Send to all participants**
* **Send only to host**
* **Send to selected participants**
* **Don't send automatically**
This permission is important because meeting discussions can be confidential.
---
### 12. ⭐ Meeting Attendance  `[P3]`
I strongly recommend making this much more detailed than simply “present/absent.”
For every participant record:
135. Name  `[P3]`
136. Email  `[P3]`
137. Join time  `[P3]`
138. Leave time  `[P3]`
139. Total duration  `[P3]`
140. Number of joins  `[P3]`
141. Number of leaves  `[P3]`
142. Rejoin time  `[P3]`
143. First join  `[P3]`
144. Final leave  `[P3]`
145. Attendance percentage  `[P3]`
146. Late joining  `[P3]`
147. Early leaving  `[P3]`
148. Connection interruptions  `[P3]`
Example:
| Participant | Join  | Leave | Duration |
| ----------- | ----- | ----- | -------: |
| Amit        | 10:00 | 11:02 |   62 min |
| Rahul       | 10:04 | 11:00 |   56 min |
| Priya       | 10:12 | 10:48 |   36 min |
### Automatically after meeting
**TatvaOS Connect → Attendance Report → TatvaOS Mail**
Email:
> **Meeting Attendance Report**
>
> Meeting: Project Review
> Date: 16 Aug 2026
> Duration: 62 minutes
> Participants: 8
>
> Detailed attendance attached.
Also save the report to:
**TatvaOS Space → Meetings → Attendance**
---
### 13. Meeting Recording  `[P3]`
147. Start recording  `[P3]`
148. Stop recording  `[P3]`
149. Automatic recording  `[P3]`
150. Recording permission  `[P3]`
151. Cloud recording  `[P3]`
152. Recording playback  `[P3]`
153. Download recording  `[P3]`
154. Recording sharing  `[P3]`
155. Recording retention policy  `[P3]`
156. Recording stored in TatvaOS Space  `[P3]`
157. Recording access control  `[P3]`
---
### 14. TatvaOS Space Integration  `[P2]`
158. Share Space file during meeting  `[P2]`
159. Open Space files without downloading  `[P2]`
160. Upload meeting files  `[P2]`
161. Save recording to Space  `[P3]`
162. Save transcript to Space  `[P4]`
163. Save AI summary to Space  `[P4]`
164. Save attendance report to Space  `[P3]`
165. Meeting-specific folder  `[P2]`
166. Permission-controlled sharing  `[P2]`
Example:
```text
Space
└── Meetings
    └── Project Review
        ├── Recording.mp4
        ├── Transcript.txt
        ├── AI Summary.pdf
        └── Attendance.xlsx
```
---
### 15. Collaboration Features  `[P2]`
167. Whiteboard  `[deferred]`
168. Screen annotation  `[P3]`
169. Pointer  `[P1]`
170. Drawing tools  `[P3]`
171. Notes  `[P2]`
172. Polls  `[P2]`
173. Q&A  `[P2]`
174. Reactions  `[P1]`
175. Raise hand  `[P1]`
176. Live captions  `[P4]`
177. Presentation controls  `[P2]`
---
### 16. Post-Meeting Automation  `[P4]`
This is another area where TatvaOS can differentiate itself.
178. Automatic meeting summary  `[P4]`
179. Attendance report  `[P3]`
180. Recording processing  `[P4]`
181. Transcript generation  `[P4]`
182. Action-item extraction  `[P4]`
183. Follow-up reminder  `[P4]`
184. Send summary through Mail  `[P4]`
185. Save documents to Space  `[P4]`
186. Create follow-up Calendar event  `[P4]`
187. Create tasks from action items  `[P4]`
188. Notify absent participants  `[P4]`
189. Meeting analytics  `[P4]`
### Example
AI detects:
> “Rahul will submit the financial report by Friday.”
TatvaOS could suggest:
**Create Task → Rahul → Financial Report → Friday**
---
### 17. Smart Meeting Features  `[P4]`
190. Meeting agenda  `[P3]`
191. Agenda shared before meeting  `[P3]`
192. Agenda displayed during meeting  `[P3]`
193. Meeting notes  `[P3]`
194. Important moments/bookmarks  `[P3]`
195. Mark important discussion  `[P3]`
196. Search meeting transcript  `[P4]`
197. Search all past meetings  `[P4]`
198. “What did we decide?” AI query  `[P4]`
199. “What are my action items?” AI query  `[P4]`
200. Find a specific person/topic across meetings  `[P4]`
---
### 18. Notifications  `[P2]`
201. Meeting invitation  `[P2]`
202. Meeting reminder  `[P2]`
203. 10-minute reminder  `[P2]`
204. Meeting starting notification  `[P2]`
205. Participant joined notification  `[P2]`
206. Participant left notification  `[P2]`
207. Missed call  `[P2]`
208. Missed meeting  `[P2]`
209. Recording ready  `[P3]`
210. Transcript ready  `[P4]`
211. AI summary ready  `[P4]`
212. Attendance report ready  `[P3]`
213. Follow-up reminder  `[P4]`
---
### 19. Enterprise/Admin  `[P3]`
214. Organization management  `[Core]`
215. Departments  `[Core]`
216. User management  `[Core]`
217. Admin roles  `[Core]`
218. Meeting policies  `[P3]`
219. Recording policies  `[P3]`
220. AI policies  `[P3]`
221. Guest access policies  `[P3]`
222. External domain restrictions  `[P3]`
223. Participant limits  `[P3]`
224. Storage limits  `[Core]`
225. Meeting duration limits  `[P3]`
226. Chat policies  `[P3]`
227. Retention policies  `[P3]`
228. Audit logs  `[Core]`
229. Usage reports  `[P3]`
230. Meeting analytics  `[P3]`
---
### 20. Security  `[P1]`
231. Secure authentication  `[Core]`
232. SSO  `[Core]`
233. Role-based access  `[Core]`
234. Meeting access token  `[P1]`
235. Meeting password  `[P1]`
236. Waiting room  `[P1]`
237. Meeting lock  `[P1]`
238. Encryption in transit  `[P1]`
239. Encryption at rest  `[P3]`
240. Recording access control  `[P3]`
241. Transcript access control  `[P4]`
242. AI data permissions  `[P4]`
243. Device/session management  `[Core]`
244. Audit trail  `[Core]`
245. Organization-level security policies  `[P1]`
---
### 21. Mobile  `[deferred]`
246. Android app  `[deferred]`
247. iOS app  `[deferred]`
248. Push notifications  `[deferred]`
249. Mobile video calls  `[deferred]`
250. Mobile voice calls  `[deferred]`
251. Mobile chat  `[deferred]`
252. Screen sharing  `[deferred]`
253. Meeting joining from notification  `[deferred]`
254. Background audio  `[deferred]`
255. Mobile meeting controls  `[deferred]`
---
### 22. Advanced Features — Future  `[deferred]`
256. Large meetings  `[deferred]`
257. Webinars  `[deferred]`
258. Live streaming  `[deferred]`
259. Breakout rooms  `[deferred]`
260. Waiting-room customization  `[deferred]`
261. External meeting guests  `[deferred]`
262. Meeting registration  `[deferred]`
263. Webinar registration  `[deferred]`
264. Speaker management  `[deferred]`
265. Audience Q&A  `[deferred]`
266. Advanced analytics  `[deferred]`
267. AI meeting coach  `[deferred]`
268. AI follow-up generator  `[deferred]`
269. AI search across meetings  `[deferred]`
270. Automatic task creation  `[deferred]`
---
### ⭐ Three features I would make the USP
### 1. AI Meeting Intelligence  `[Core]`
**Meeting → Transcript → Summary → Decisions → Action Items**
### 2. Automatic Attendance  `[P1]`
**Join/Leave tracking → Duration → Detailed report → Mail + Space**
### 3. TatvaOS Ecosystem Automation  `[P1]`
**Calendar → Connect → Meeting → AI Summary → Mail → Space → Tasks**
That last one is particularly important. Instead of building **“another video calling app,”** you're building a system where the meeting automatically produces useful business information and distributes it across the TatvaOS ecosystem.



---

### How to read the three USPs

They are the right ambition, and they are why Connect is worth building
rather than buying. They are also why **Phase 1 must be boring and solid**:
none of the three is worth anything on top of a call that drops.

Two dependencies in that list that are bigger than their one line suggests:

- **167 Whiteboard** — a real-time collaborative canvas is its own product
  with its own synchronisation problem. Not in v1, and not to be started
  without Amit agreeing it deserves a phase of its own.
- **187 / 270 Create tasks from action items** — depends on a **Tasks product
  that does not exist yet**. Do not build one inside Connect; raise it.

And one that is cheaper than it looks: **category 9** is nearly done already.
Calendar has events, RRULE expansion, attendees, reminders and time-zone
handling. You provide an endpoint that mints a meeting for an event id; Core
wires the toggle.

---

## Appendix B — the reading list, in order

All paths are from the repository root. Read the groups in order; inside a
group, top to bottom. Nothing here is optional except where marked.

### Day 1 — orientation (about two hours)

```
docs/CONNECT_BRIEF.md                 ← this file, all of it, first
docs/README.md                        index of everything else
docs/architecture/00-product-structure.md
docs/architecture/01-architecture.md
docs/architecture/02-tech-stack.md
docs/STORAGE_MODEL.md                 one allowance per person — affects recordings
docs/BACKLOG.md                       what is shipped, what is owed, known debts
```

### Day 2 — how a module is actually built

Calendar is the newest and cleanest module. Read it end to end; it is the
template for `Modules/Connect/`.

```
apps/api/Program.cs                             composition root: DI, auth, pipeline order
apps/api/Shared/Tenancy/TenantMiddleware.cs     where tenant + user come from
apps/api/Shared/Tenancy/TenantConnectionInterceptor.cs   ← the empty-string trap lives here
apps/api/Shared/Data/AppDbContext.cs            snake_case mapping, declared FKs
local/postgres/init/20260816-calendar.sql       migration + RLS policies to copy
apps/api/Modules/Calendar/Endpoints/CalendarEndpoints.cs
apps/api/Modules/Calendar/Recurrence.cs         (skim — but read the anchor-stepping comment)
```

### Before you write any frontend — §6 in full, then these

```
apps/web/components/shell/AppShell.tsx    the wrapper you will use on every screen
apps/web/components/shell/Sidebar.tsx     the rail + the logo lookup you must extend
apps/web/components/shell/Topbar.tsx      shared; do not fork it
apps/web/components/shell/RailStorage.tsx goes in your railFooter
apps/web/components/shell/AppLauncher.tsx the product grid
apps/web/lib/nav.tsx                      RAIL_PRODUCTS + every product's nav function
apps/web/lib/auth.tsx                     authedFetch, token handling, authedUpload
apps/web/components/ui/Kit.tsx            the component set — use it, don't add a UI library
apps/web/styles/overrides.css             READ THE COMMENTS. Every trap is documented here.
docs/FRONTEND_HANDOVER.md                 the traps written out long-form
apps/web/app/calendar/[view]/page.tsx     a full product screen built the house way
apps/web/app/connect/page.tsx             the coming-soon page you will replace
apps/web/public/brand/                    where connect-logo.png + connect-name.png go
Logo/                                     source artwork (ask Amit for the Connect pair)
```

### Before you touch cross-product seams (Phase 2)

```
docs/SPACE_API.md                                   what a good contract looks like
docs/SPACE_ATTACH.md                                how other products read/write Space
apps/api/Modules/Space/SpaceContentGateway.cs       EnsureFolderAsync / SaveAsync
docs/MAIL_IMIP_SEAM.md                              how a seam with Mail gets agreed
docs/plans/LARGE_ATTACHMENTS.md                     a three-lane feature, split and sequenced
apps/api/Modules/Core/Endpoints/MyStorageEndpoints.cs
local/postgres/init/31-user-storage.sql             core.user_storage() — call it, never re-SUM
```

### Before your first anonymous/guest endpoint

```
apps/api/Modules/Space/Endpoints/SpaceLinkEndpoints.cs   the only unauthenticated route we ship
apps/web/lib/space.ts                                    its client, incl. the no-oracle handling
```

Then send yours to Core for a line-by-line review, as Space did.

### Deployment — before your first deploy, not after

```
infra/docker/docker-compose.base.yml       services; LiveKit + coturn go here
infra/docker/docker-compose.production.yml the overlay that owns the project name
infra/docker/conf.d/connect.caddy          already written for you
infra/docker/.env.production.example       CONNECT_DOMAIN already listed
infra/scripts/deploy.sh                    read it before running it
infra/scripts/backup.sh                    what is protected, and what is not
apps/api/Dockerfile                        native deps must be in the IMAGE (see §3)
docs/setup/09-cicd-and-topology.md
docs/setup/01-dev-environment.md           get local running
docs/setup/00-command-reference.md
docs/runbooks/                             what to do when production misbehaves
```

### Reference — when you hit the specific thing

```
docs/setup/02-troubleshooting.md
docs/setup/08-cloud-environments.md        production is the ONLY environment
docs/setup/10-client-dns-records.md
docs/decisions/                            architecture decision records
```
