# TatvaOS Connect — API contract, Phase 1

**Status: CONTRACT DRAFT — FOR CORE'S REVIEW, before any code.** Nothing is
built before Core has read this. Decisions that go beyond the brief are marked
**[DECISION]** with the reasoning inline, so they cannot slip through
unexamined. Shapes follow Mail and Space: `authedFetch`, JSON bodies,
camelCase, and every error is `{ "error": "sentence." }` — the console prints
it verbatim.

Written against migration `20260817-connect.sql` (below), branch
`feature/connect-phase1`. Covers §4 Phase 1 of `docs/CONNECT_BRIEF.md`
(≈ features 1–73). Phases 2–4 get their own addenda, the way
`SPACE_API_PUBLIC_LINKS_ADDENDUM.md` extended `SPACE_API.md`.

---

## Conventions

- **Base path** `/api/connect/*`, same-origin behind `connect.caddy` (already
  written), so the refresh cookie stays first-party. Auth is the shared JWT —
  no Connect login exists.
- **Visibility vs permission.** A meeting the caller cannot *see* (RLS) is a
  **404** — never a 403, which would confirm existence. A meeting the caller
  can see but may not act on is a **403**. Same rule as Space.
- **Roles** `participant < cohost < host`. The creator is host. Host and
  cohost may run the meeting (admit, mute, remove, lock, end); only the host
  may promote or demote a cohost and cancel the meeting. Enforced in the
  application; RLS answers visibility only.
- **Status codes**: `200`, `201`, `204`; `400` validation, `403` insufficient
  role or wrong password, `404` not visible / does not exist, `409` state
  conflict (locked, ended, already started), `429` rate-limited (guest paths).
- **The meeting id is internal; the CODE is the capability.** `id` (uuid)
  appears in authenticated URLs. `code` — 16 bytes from the CSPRNG, base64url,
  22 chars, no padding, exactly the Space public-link token recipe — is what
  travels in invitations and is the only thing a guest ever presents.
  Unlike Space's tokens it is stored in **plaintext** with a unique index:
  the host must be able to re-read and re-share it for the meeting's whole
  life, and it does not by itself grant media access — a LiveKit token does,
  and that is minted only after the checks below. **[DECISION]** flagged for
  review in Open Questions §1.
- **The LiveKit API secret never leaves the server.** The browser receives
  only short-lived, room-scoped LiveKit JWTs minted by this module. There is
  no configuration in which the signing secret reaches a client, a log line,
  or a URL.

### DTOs

```jsonc
// MeetingDto
{
  "id": "uuid",
  "code": "fRzWq3G8kJ2mB5nX0aYcVw",          // 22-char base64url capability
  "joinUrl": "https://connect.tatvaos.com/connect/room/fRzWq3G8kJ2mB5nX0aYcVw",
  "title": "Weekly review",
  "kind": "instant | scheduled",
  "status": "scheduled | active | ended | cancelled",
  "scheduledStart": "iso | null",             // null on instant meetings
  "scheduledEnd": "iso | null",
  "timezone": "Asia/Kolkata",
  "startedAt": "iso | null",                  // set by the room_started webhook
  "endedAt": "iso | null",
  "hasPassword": true,                        // never the password or its hash
  "waitingRoom": "everyone | guests | off",   // who must be admitted
  "allowGuests": true,
  "locked": false,
  "createdByUserId": "uuid | null",
  "myRole": "host | cohost | participant | null",
  "createdAt": "iso",
  "updatedAt": "iso"
}

// ParticipantDto — meeting detail page and lobby
{
  "identity": "user:9d2f… | guest:41ab…",     // the LiveKit identity
  "displayName": "Priya Sharma",
  "role": "host | cohost | participant",
  "isGuest": false,
  "connected": true,                          // derived from meeting_events
  "firstJoinedAt": "iso | null",
  "lastSeenAt": "iso | null"
}
```

---

## Schema — `20260817-connect.sql`

Date-prefixed, idempotent, additive; runs on every deploy like every other
migration. RLS follows `20260816-calendar.sql` exactly: parent table carries
`tenant_id` with the `nullif(current_setting('app.tenant_id', true), '')::uuid`
policy, ENABLE **and** FORCE; children scope through the parent with EXISTS.
`connect.*` tables must also be added to `local/scripts/test-isolation.sh` —
the CI tenant-isolation gate blocks merge without it.

```sql
CREATE SCHEMA IF NOT EXISTS connect;

-- ----------------------------------------------------------------------------
--  Meetings. The code is the shareable capability; the LiveKit room is named
--  m-{id} and exists only on the media server, never in a URL.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meetings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    code               text NOT NULL,          -- 22-char base64url, CSPRNG, globally unique
    title              text NOT NULL DEFAULT 'Meeting',
    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    kind               text NOT NULL DEFAULT 'instant'
                       CHECK (kind IN ('instant','scheduled')),
    scheduled_start    timestamptz,
    scheduled_end      timestamptz,
    timezone           text NOT NULL DEFAULT 'Asia/Kolkata',

    status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','active','ended','cancelled')),
    started_at         timestamptz,            -- room_started webhook
    ended_at           timestamptz,            -- room_finished webhook, or /end

    password_hash      text,                   -- Argon2id via IPasswordHasher; NULL = none
    waiting_room       text NOT NULL DEFAULT 'guests'
                       CHECK (waiting_room IN ('everyone','guests','off')),
    allow_guests       boolean NOT NULL DEFAULT true,
    locked             boolean NOT NULL DEFAULT false,

    -- Phase 2 seam, reserved now so Calendar integration is a feature and not
    -- a migration — the same reasoning as public_links.password_hash.
    calendar_event_id  uuid REFERENCES calendar.events(id) ON DELETE SET NULL,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT meetings_schedule CHECK (
        scheduled_start IS NULL OR scheduled_end IS NULL
        OR scheduled_end >= scheduled_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_meetings_code ON connect.meetings (code);
CREATE INDEX IF NOT EXISTS ix_meetings_tenant_start
    ON connect.meetings (tenant_id, scheduled_start);
CREATE INDEX IF NOT EXISTS ix_meetings_tenant_status
    ON connect.meetings (tenant_id, status);

-- ----------------------------------------------------------------------------
--  Participants — one row per person per meeting, users and guests alike.
--  Presence is NOT a flag here: joins and leaves live in meeting_events and
--  reports are computed from them (brief §4 Phase 3).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.participants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES core.users(id) ON DELETE SET NULL,  -- NULL for guests
    display_name    text NOT NULL,
    role            text NOT NULL DEFAULT 'participant'
                    CHECK (role IN ('host','cohost','participant')),
    is_guest        boolean NOT NULL DEFAULT false,
    identity        text NOT NULL,             -- user:{userId} | guest:{participantId}
    first_joined_at timestamptz,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_meeting_user
    ON connect.participants (meeting_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_meeting_identity
    ON connect.participants (meeting_id, identity);

-- ----------------------------------------------------------------------------
--  Waiting room. The wait token is a bearer capability for an unauthenticated
--  poller, so it is stored HASHED — the Space public-link rule. Plaintext
--  exists exactly once, in the join response.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.lobby_requests (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id         uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    user_id            uuid REFERENCES core.users(id) ON DELETE CASCADE,  -- NULL for guests
    display_name       text NOT NULL,
    wait_token_hash    text NOT NULL,          -- SHA-256 hex
    status             text NOT NULL DEFAULT 'waiting'
                       CHECK (status IN ('waiting','admitted','denied','expired','cancelled')),
    decided_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    decided_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lobby_wait_token
    ON connect.lobby_requests (wait_token_hash);
CREATE INDEX IF NOT EXISTS ix_lobby_meeting_status
    ON connect.lobby_requests (meeting_id, status);

-- ----------------------------------------------------------------------------
--  The event log LiveKit webhooks feed. Attendance (Phase 3, features 135–148)
--  is queries over these rows; nothing maintains a running "is present" flag.
--  payload keeps the raw webhook body so later phases can recompute without
--  re-living the meetings.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meeting_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id   uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN (
                     'room_started','room_finished',
                     'participant_joined','participant_left',
                     'recording_started','recording_finished')),
    identity     text,                         -- NULL on room-level events
    display_name text,
    occurred_at  timestamptz NOT NULL,
    webhook_id   text,                         -- LiveKit event id — idempotency
    payload      jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_meeting_events_webhook
    ON connect.meeting_events (webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_meeting_events_meeting
    ON connect.meeting_events (meeting_id, occurred_at);

-- ----------------------------------------------------------------------------
--  Org kill-switch for guest access — the allow_public_links precedent:
--  a column on core.tenants, OFF closes the tap on EXISTING meetings too.
-- ----------------------------------------------------------------------------
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_connect_guests boolean NOT NULL DEFAULT true;
```

RLS block (same `DO $$` shape as calendar; abbreviated here, verbatim in the
migration): `meetings` gets the direct `tenant_id` policy USING + WITH CHECK;
`participants`, `lobby_requests`, `meeting_events` scope through
`connect.meetings` with EXISTS. All four ENABLE + FORCE. Then
`GRANT USAGE ON SCHEMA connect TO tatvaos_app;`, table DML grants, and
`ALTER DEFAULT PRIVILEGES` — the calendar migration's closing block, with
`connect` substituted.

### The anonymous path's database access

Anonymous requests carry no JWT, so `app.tenant_id` is empty and RLS fails
closed. Exactly four `SECURITY DEFINER` functions with pinned `search_path`
exist for the anonymous paths — the Space public-links rule — and the API
issues no other query before tenant context is established. Three serve the
guest path; the fourth (`webhook_meeting_tenant`, listed with the webhook
section below) serves the LiveKit callback, which is anonymous in exactly the
same way and was originally — wrongly — given an ordinary query instead:

```sql
connect.resolve_meeting_code(p_code text)
  RETURNS TABLE (meeting_id uuid, tenant_id uuid, title text, status text,
                 scheduled_start timestamptz, locked boolean,
                 has_password boolean, waiting_room text)
-- SELECT-only. Empty result unless ALL of: code matches; meeting status IN
-- ('scheduled','active'); tenant status IN ('active','trial');
-- tenant.allow_connect_guests; meeting.allow_guests.
-- The predicate is stated once here so review can diff it against the code.

connect.peek_lobby_request(p_token_hash text)
  RETURNS TABLE (request_id uuid, meeting_id uuid, tenant_id uuid,
                 status text, display_name text)
-- SELECT-only, by hash. The plaintext wait token never reaches SQL.
```

After a successful resolve, the endpoint creates a DI scope and sets
`TenantContext` to the resolved tenant explicitly — the `MaildirIngestWorker`
pattern — and every subsequent read and write happens under normal RLS. No
guest work runs as `postgres`, ever.

---

## LiveKit — rooms, identities, tokens, webhooks

**Room name** is `m-{meetingId}`. It appears in LiveKit tokens and webhooks
only — never in a URL, never shown to a person.

**Identity** is `user:{userId}` for signed-in people (stable across rejoins,
so attendance aggregates correctly) and `guest:{participantId}` for guests
(stable for that guest's participant row).

**Token minting** (server-side only, key + secret from environment):

- TTL **10 minutes** — a join window, not a session limit; LiveKit keeps an
  established session alive past token expiry, and a rejoin simply calls the
  join endpoint again for a fresh token.
- Grants: `roomJoin`, `room: m-{meetingId}`, `canPublish`, `canSubscribe`,
  `canPublishData` (in-meeting chat rides data channels — ephemeral in
  Phase 1, exactly as the brief orders). Host and cohost additionally get
  `roomAdmin`.
- Never granted to anyone: room listing, room creation, wildcard rooms. A
  token that grants "any room" is a token that joins any customer's board
  meeting — brief §7.

**Server API use** (API → LiveKit over the internal network): create room on
first join (`emptyTimeout` 5 min, `maxParticipants` from org policy later),
`MutePublishedTrack`, `RemoveParticipant`, `UpdateParticipant` (role change),
`DeleteRoom` (end for everyone).

**Webhooks** (LiveKit → API): `POST /api/connect/webhooks/livekit`,
`AllowAnonymous`, and the platform's first inbound webhook, so stated
plainly: every request is authenticated by verifying LiveKit's JWT in the
`Authorization` header against the API key/secret, including the body-hash
claim; unverifiable requests are `401` and nothing is written. Events are
deduplicated on `webhook_id` (unique index — replays are no-ops). Handled
events: `room_started` → meeting `active` + `started_at`;
`room_finished` → `ended` + `ended_at`; `participant_joined` /
`participant_left` → a `meeting_events` row + participant
`first_joined_at`/`last_seen_at`. Tenancy: the handler's first read runs
before any tenant is set, where forced RLS returns nothing, so it goes
through `connect.webhook_meeting_tenant(p_meeting_id uuid)` — SECURITY
DEFINER, one column out, keyed by primary key, granted only to
`tatvaos_app`; the tenant it returns is entered before anything is written.
(Found the hard way: the original ordinary query read zero rows and the
handler acknowledged every event while recording none.) LiveKit is
configured to deliver to
`http://api:8080/...` inside the compose network; the route is also reachable
through Caddy and is safe there because verification, not reachability, is
the control.

---

## Endpoints — authenticated

All under `MapGroup("/api/connect").RequireAuthorization("User")
.WithTags("Connect")` in `Modules/Connect/Endpoints/ConnectEndpoints.cs`,
plus one `app.MapConnectEndpoints();` line in `Program.cs`.

### `GET /api/connect/meetings?range=upcoming|today|past&page=&pageSize=`

Meetings I created or am a participant of, in my tenant. `upcoming` (default)
sorts soonest-first and includes `active` meetings first; `past` sorts
latest-first. `pageSize` default 50, max 200.

```jsonc
// 200
{ "meetings": [ MeetingDto ], "page": 1, "pageSize": 50, "total": 3 }
```

### `POST /api/connect/meetings`

```jsonc
{
  "title": "Weekly review",              // optional, default "Meeting", ≤ 200 chars
  "kind": "instant | scheduled",         // default instant
  "scheduledStart": "iso",               // required when scheduled
  "scheduledEnd": "iso",                 // optional
  "timezone": "Asia/Kolkata",            // default Asia/Kolkata
  "password": "string | null",           // 4–100 chars when present
  "waitingRoom": "everyone | guests | off",  // default guests
  "allowGuests": true                    // default true
}
// 201 → MeetingDto (the only convenient moment to copy the code — but the
//        code is re-readable from every later GET, deliberately)
```

Errors: `400` scheduled without a start, start in the past by more than a
day, bad enum, title too long. Audited: `connect.meeting.created`.

### `GET /api/connect/meetings/{id}` → `200` MeetingDto
### `GET /api/connect/meetings/{id}/participants` → `200 { "participants": [ ParticipantDto ] }`

`404` if not visible (RLS or not mine/not invited — indistinguishable).

### `PATCH /api/connect/meetings/{id}`

Host/cohost. Any subset of: `title`, `scheduledStart`, `scheduledEnd`,
`timezone`, `password` (string sets, `null` clears), `waitingRoom`,
`allowGuests`, `locked`. `200` MeetingDto. `403` not host/cohost; `409`
editing schedule of an `ended`/`cancelled` meeting. Lock flips are audited:
`connect.meeting.locked` / `connect.meeting.unlocked`.

### `DELETE /api/connect/meetings/{id}`

Host only. `scheduled` → `cancelled`, `204`. `409` when `active` — ending a
live meeting is `/end`, a different intent. Audited `connect.meeting.cancelled`.

### `POST /api/connect/meetings/{id}/join`

The token mint for signed-in, same-tenant people. Body `{ "password": "…" }`
required only when the meeting has one (host and cohost skip it).

```jsonc
// 200 — admitted
{ "status": "joined", "token": "…LiveKit JWT…",
  "wsUrl": "wss://connect.tatvaos.com/rtc",
  "identity": "user:9d2f…", "role": "participant" }

// 200 — parked in the waiting room (waitingRoom = "everyone", non-hosts)
{ "status": "waiting", "waitToken": "…22 chars, plaintext, shown once…" }
```

Rejoin after a drop is the same call again — it is idempotent per person and
mints a fresh token every time. Errors: `403` wrong password; `409` locked
(`"This meeting is locked."`) or ended; `404` not visible. Joins are not
audited (they are meeting_events); lobby decisions are.

### Waiting room — host side

- `GET /api/connect/meetings/{id}/lobby` → `200 { "waiting": [ { "requestId",
  "displayName", "isGuest", "requestedAt" } ] }`. Host/cohost; `403` others.
- `POST /api/connect/meetings/{id}/lobby/{requestId}/admit` → `204`.
  Audited `connect.lobby.admitted`.
- `POST /api/connect/meetings/{id}/lobby/{requestId}/deny` → `204`.
  Audited `connect.lobby.denied`.

The waiting person learns the outcome from their wait poll (below) —
Phase 1 polls; a push channel is Open Question §4.

### In-meeting host controls

Host/cohost; `403` others; `404` unknown identity; all → LiveKit server API;
all audited with `productCode: "connect"`.

| Call | Effect | Audit |
|---|---|---|
| `POST …/{id}/participants/{identity}/mute` body `{"kind":"audio"\|"video"}` | mute that track | `connect.participant.muted` |
| `DELETE …/{id}/participants/{identity}` | remove from the room; their next join needs re-admission | `connect.participant.removed` |
| `PUT …/{id}/participants/{identity}/role` body `{"role":"cohost"\|"participant"}` | host only | `connect.participant.role_changed` |
| `POST …/{id}/end` | DeleteRoom; meeting `ended` | `connect.meeting.ended` |

---

## Endpoints — the guest path

Unauthenticated, under `MapGroup("/api/connect/g")` with
`.RequireRateLimiting("connect-guest")` — a new named fixed-window policy,
**60 requests/min per IP**, `QueueLimit 0`, partitioned by the **last**
`X-Forwarded-For` entry, copied line for line from `"space-public-links"`.
Registered beside it in `Program.cs` (one small shared-file patch, sent to
Core like the Map line).

**The one-answer rule.** Unknown code, malformed code, cancelled meeting,
guests disabled on the meeting, guests disabled for the org, tenant
suspended — every one of them is the same
`404 { "error": "This meeting link does not work." }`. No oracle: a code
cannot be probed for existence, and Connect never confirms to a stranger that
an organisation exists. Codes are shape-checked
(`^[A-Za-z0-9_-]{22}$`) before they cost a query.

### `GET /api/connect/g/{code}` — the doorstep

What the pre-join screen may show. Costs nothing, counts nothing.

```jsonc
// 200
{ "title": "Weekly review", "scheduledStart": "iso | null",
  "state": "not_started | active | ended",
  "passwordRequired": true, "locked": false }
```

**[DECISION]** A meeting that genuinely ran and finished answers
`state: "ended"` rather than 404 — a real attendee clicking a stale link
deserves the truth. Disclosure of `title` to any code-holder is the
`sharedByDisplayName` conversation again: Open Question §2.

### `POST /api/connect/g/{code}/join`

```jsonc
{ "displayName": "Ravi (Vendor)", "password": "…" }   // displayName 1–100 chars
// 200 — waiting room (the default for guests):
{ "status": "waiting", "waitToken": "…plaintext, shown once…" }
// 200 — meeting has waitingRoom "off":
{ "status": "joined", "token": "…", "wsUrl": "wss://…", "identity": "guest:41ab…" }
```

`403` wrong password (honest AFTER a valid code resolved — Open Question
§3); `409` locked; `404` everything in the one-answer rule. Creates the
participant row (`is_guest`, `user_id NULL`) and, when waiting, the
`lobby_requests` row. Signed-in users from **another tenant** join through
this same path — cross-tenant attendance is guest attendance in Phase 1.

### `GET /api/connect/g/wait/{waitToken}`

The park-bench poll (client polls every 2 s; the limiter allows it).

```jsonc
// 200
{ "status": "waiting" }
{ "status": "admitted", "token": "…", "wsUrl": "wss://…", "identity": "guest:41ab…" }
{ "status": "denied" }
// 404 — unknown, expired (30 min), or cancelled request
```

Wait tokens are looked up by SHA-256 hash; admitted tokens are one-shot —
the first poll that collects the LiveKit token flips the request to a
terminal state, atomically, the `consume_public_link` UPDATE-as-check shape.

**Per brief §8: none of this group deploys until Core has reviewed it
line-by-line, the same rule Space's public links followed.**

---

## Frontend — routes and registration

| Route | Shell | Notes |
|---|---|---|
| `/connect` | AppShell, scope `connect` | dashboard: today + upcoming, join-by-code box, new meeting |
| `/connect/new` | AppShell | schedule form |
| `/connect/meetings/[id]` | AppShell | detail: participants, code, host controls, cancel |
| `/connect/room/[code]` | **none** — full-bleed, own dark surface | the meeting room; renders with **no session** (guests), `useSearchParams` under `<Suspense>` |

Scope registration is the four-file change from brief §6 (AppShell, Sidebar
union **and** logo ternary, Topbar, `nav.tsx`), sent as a patch for Core's
review since the shell is shared. `connectNav()` uses real paths, coloured
icons, and `Recordings` as `disabled: true, badge: 'soon'`. The launcher
tile flips `live: true` in the same commit as a distinct tile colour
(current `#00b8d9` collides with Family — needs Amit's pick) and the
`connect-logo.png` / `connect-name.png` pair. Video tiles are flex +
`aspect-ratio`, never `grid-cols-*`; overlays are `z-[1200]`.

---

## Storage, audit, and what Phase 1 does not do

- **No storage.** Phase 1 stores no files, so no quota interaction. When
  recordings arrive (Phase 3) they go through `SpaceContentGateway` into the
  **organisation pool** — never the host's personal allowance, the shared-
  mailbox rule — and never by inserting `space.files` rows directly.
- **Audit**: every event named above goes to `core.audit_logs` via
  `AuditWriter.WriteAsync(action, "connect.meeting", id, after: …,
  productCode: "connect")`.
- **Non-goals in this contract, deliberately**: recording and Egress,
  transcripts, AI anything (Phase 4 is Amit's decision first), persistent
  chat, contacts integration, calendar toggle (Phase 2 — but
  `calendar_event_id` already exists), recurring meetings, custom links,
  breakout rooms, webinars, dial-in, mobile apps, background blur/virtual
  backgrounds, and the admin policy console (Phase 3; `allow_connect_guests`
  is the only org switch in v1).

## Acceptance for Phase 1

Two people on different networks join by link from two different
organisations' accounts (plus one guest with no account through the waiting
room), see and hear each other for an hour, survive a deliberate wifi drop
by rejoining automatically, the host mutes and removes someone, and
afterwards `GET /meetings/{id}/participants` shows who was there. `pnpm
typecheck` and both test suites green, `connect.*` in the isolation suite.

---

## Open questions for Core

1. **Code stored plaintext.** Space hashes its tokens; I store meeting codes
   plaintext because hosts re-read them for the meeting's life and the code
   alone mints nothing. If Core prefers the hash rule anyway, the cost is a
   "copy it now" UX like MFA recovery codes — say the word.
2. **What a code-holder learns.** `GET /g/{code}` returns `title` and
   `scheduledStart` before any admission. Space flagged
   `sharedByDisplayName` as a conscious disclosure; this is the same
   decision. Alternative: return nothing but state until admitted.
3. **Wrong-password honesty on the guest path.** After a valid code, a wrong
   password answers `403` (distinct from 404) so typos are correctable.
   Strictly, that distinguishes "code valid" from "code invalid" — I think
   the UX is worth it and the limiter holds the line; confirm.
4. **Lobby notification transport.** Phase 1 polls (2 s). If Core would
   rather introduce SignalR now (nothing in the API uses it yet), the wait
   endpoints stay and the poll becomes the fallback.
5. **`calendar_event_id` FK into Calendar's schema** — reserved column,
   Core owns that table; confirm the FK or I keep the uuid without one.
6. **`core.tenants.allow_connect_guests`** — a column on Core's table, the
   `allow_public_links` precedent; in my migration or yours?
7. **`meeting_events` retention** — webhook rows grow forever; propose a
   per-org retention with a 400-day default, enforced by a worker, decided
   before Phase 3 needs the rows.
8. **Signalling URL** — `wsUrl` is `wss://connect.tatvaos.com/rtc` (a
   `handle /rtc*` in `connect.caddy`, no new hostname, no new cert). The
   alternative is a dedicated subdomain. Phase 0 plan assumes the path;
   flag if you want the subdomain from day one.
