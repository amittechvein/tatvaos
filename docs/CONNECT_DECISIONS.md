# Connect — decisions that outlive a session

## The `sharing` capability is OFF, and this matrix is the condition for turning it on

Recording sharing is deployed and inert. Tables, RLS, four levels, the
organisation switch and all the routes are live in production as of
`172d83f`. The Share button does not render, because `Recordings.tsx` shows it
only when the recordings list carries a `sharing` capability and **no API code
emits that field**. Emitting it is one line.

**Do not write that line until every case below has been run and the result
shown.** Not reasoned about — run, against a deployed system, with the output
kept. Public links to recordings are the most exposed surface this product
would have; the CTO's standard for entitlements applies here and this is it.

The cases can all be exercised today. The endpoints exist and take ordinary
HTTP; none of this needs the button.

### The matrix

| # | Case | Must happen | Why it is in the list |
|---|---|---|---|
| 1 | Link holder with no session at all | Level `public` resolves only if the org switch is on; `password` requires the password; `organisation` and `named` refuse | The whole point of the feature |
| 2 | Revoked share | Refused. No row returned, not a row with a flag | A caller that forgets to check a flag leaks; one that forgets to check for no rows gets a null reference |
| 3 | Expired share | Refused, same shape as revoked | — |
| 4 | Suspended organisation | Refused | Not implemented in `resolve_share_token` today — see below |
| 5 | Wrong recording | A share for recording A must not authorise recording B, even in the same meeting | `meeting_id` is denormalised onto the share for exactly this check |
| 6 | **Participant with no share at all** | **Still reads the recording** | The baseline never moves. `SeenMeetingAsync` decides it and nothing here may override it. The likeliest invariant for a future change to break |
| 7 | **Named grant across organisations** | Reader in tenant B reads a recording owned by tenant A, and **cannot list who else it was shared with** | The only reason `share_for_user` is SECURITY DEFINER. The second half is enforced by what the RLS policy omits, which makes it invisible |
| 8 | **The switch flipped off while a link is live** | The existing link stops resolving immediately; the row is not deleted; flipping back on resumes it | Read-time enforcement. Verified by me in a sandbox, never against the deployed system |
| 9 | **An anonymous read is logged** | A row appears in `recording_access_log` with the tenant, recording and level taken from the share, `subject_user_id` NULL | Not an authorisation outcome, so nobody thinks to test it — and a public link with no record of who opened it is the failure that matters after the fact |

Cases 1–5 are the CTO's. **6 to 9 are mine, from writing the code**, and they
are the ones the next owner would not derive from the endpoint signatures.

### Case 4 is not implemented, and saying so is the point

`connect.resolve_share_token` checks revocation, expiry and the organisation's
`allow_public_recording_links`. It does **not** check whether the organisation
is suspended. If suspension is meant to stop a public link resolving — and it
probably is — that clause does not exist yet. I did not add it because I could
not find where suspension is represented and would have been guessing at a
column, which is the same mistake that kept this feature blocked for two weeks.

Run case 4 expecting it to fail. A matrix whose every row passes on the first
attempt has usually been written to match the code.

### What enforces what

Two enforcement points and they are not equivalent.

**Share time**, in `CreateAsync`: refuses to create a `public` share when the
switch is off. This is a courtesy — it stops somebody generating a link that
would never work.

**Read time**, inside `connect.resolve_share_token`: refuses to resolve a
`public` token at all. This is the security. It lives in the definer function
rather than the download route because the anonymous path reaches these tables
through that function and nothing else — a condition in a route is one the
next route can forget.

Turning the switch off does not delete anything. Live `public` rows stay,
stop authorising, and resume if it is switched back on, with the gap visible
in `recording_access_log`.

### Where the pieces are

- Migration and every design decision, each recorded beside the code it
  decided: `local/postgres/init/20260908-b-connect-recording-shares.sql`
- Endpoints, the share-time check and the three audit writes:
  `apps/api/Modules/Connect/Endpoints/ConnectShareEndpoints.cs`
- The switch: `connect.tenant_settings.allow_public_recording_links`,
  default **false**, no backfill. A missing row reads as off.
- Client, already shipped and waiting: `Recordings.tsx`, `list.sharing`

---

## Guest removal does not remove a guest

`connect.meeting_blocks` keys on `user_id` and a guest has none — their
identity is minted fresh at every door. A removed guest returns through the
same link, and only the waiting room stops them. The Removed-people list
labels this per row; the Remove button does not, and means two different
things depending on who it is pointed at.

## `DUPLICATE_IDENTITY` is a consequence, not a decision

Connect mints `user:<uuid>` as a participant identity — stable and keyed to the
account, because roles, blocks and the baseline all key on the person rather
than the session. LiveKit disconnects an earlier connection holding the same
identity. So a second device kicks the first, and **nobody decided that**; it
falls out of an identity scheme chosen for other reasons. It cost the Mobile
lane time twice.

Changeable: a per-session suffix would allow two devices, and
`connect.meeting_blocks` keys on `user_id` rather than identity so blocking
would survive. What breaks is anything assuming one participant row per person
per meeting.

## `departureTimeout` stays at 20 seconds

Proposed at 120 on 8 September, withdrawn on the 12th. The harm being argued
against — a group losing connectivity for over 20 seconds, the room closing,
and the meeting being permanently unreopenable — stopped existing when Reopen
shipped on the 8th. The proposal outlived its reason.

Three reasons not to raise it, each sufficient alone. Egress stops when the
room closes, so every recording would gain up to 100 seconds of empty room and
`ready` would arrive that much later. A meeting already reads as live for
~50 seconds after the host leaves; this makes that guaranteed to be two
minutes. And `empty_timeout` (300s) governs a room nobody ever joined, which
is a different question that should not move with this one.

**The condition for revisiting**: measure how long a real group drop actually
lasts. Not "raise it a bit".

`infra/docker/livekit.yaml` sets neither value — 20 and 300 are LiveKit's own
defaults, confirmed by the CTO on 12 September.

## The chime burst threshold is a measurement, not a code change

`CHIME_BURST_MAX = 4` and `CHIME_BURST_WINDOW_MS = 10_000` in `Stage.tsx` are
provisional, and the comment beside them is a standing review condition:
measure it in a real meeting and report the number rather than defend a guess.
The `console.info` in `chime()` prints how many tones played and how many were
suppressed. Somebody needs to be in a real meeting with the console open at
the moment people arrive.

Listed as available work for two days before it became clear it cannot be done
from a code editor.

## Two layout bugs, diagnosed, unfixed

**Tiles are the wrong shape in the gallery.** `bestColumns` picks the column
count that yields the largest 16:9 tile in a cell; the CSS then sets
`width:100%; height:100%; aspect-ratio:auto`, so the tile takes the cell's
shape instead and `object-fit:cover` crops faces. The algorithm optimises for
a shape nothing enforces. Fix: pass the tile width `bestColumns` already
computed to CSS and size the tile from it.

**The room is taller than the window with the People panel open** — the second
tile and the left toolbar are both clipped. Different cause, undiagnosed. The
question that separates the two possibilities: with the panel open, does the
page scroll, or is it simply clipped?
