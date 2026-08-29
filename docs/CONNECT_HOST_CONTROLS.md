# Connect — host controls, 19 August 2026

What shipped in this session, why it is shaped the way it is, and how to get
it onto the box. Written to be read alongside CONNECT_HANDOVER.md.

## What was built

**The host cannot leave by accident.** A host clicking Leave now gets a
dialog: end the meeting for everyone, hand it to a named signed-in
participant, or — when everyone else is a guest and nobody *can* host — leave
with the meeting running, stated in those words. The hand-over goes through a
new endpoint, `POST /api/connect/meetings/{id}/host`, which is deliberately
separate from the existing `/role` route: `/role` shares the controls and
refuses `host`; this one gives the meeting away. The old host becomes a
cohost. Transfer resolves BEFORE the browser disconnects, so a failed
transfer never orphans the meeting.

**Co-host, from the room.** The People panel now shows roles (read from our
rows via `/participants`, never from LiveKit metadata) and lets the host — the
host alone — promote to co-host and demote. A guest cannot be a co-host: every
host control keys on a user account they do not have, and a cohost who cannot
call any host endpoint would be a title, not a role.

**Removed means removed.** `connect.meeting_blocks` (migration 20260819-connect-host-controls)
records who a host removed. The join path refuses a blocked user with a plain
403 sentence — checked before the lock and the password, so a blocked person
learns nothing about either — and the admit path refuses to wave one back in
from the lobby with a 409 the host can read. Keyed on `user_id`, the only
stable handle we have: a guest gets a fresh participant row and identity at
every door, so a guest cannot be usefully blocklisted — for guests the
waiting room IS the control, which Remove already sends them back to. Hosts
and cohosts are not blockable via Remove; their standing changes through
`/role` and `/host`.

**Auto-record on create.** A checkbox on the meeting form sets
`meetings.auto_record`; the `room_started` webhook is what acts on it,
because that is the moment the media server says the meeting exists. The
three gates from 20260818-connect-recording are re-read AT THAT MOMENT — org flag, storage
headroom — so an org that switches recording off stops auto-record on
meetings that already carry the flag. Refusals are log lines that name the
reason (there is nobody to show a sentence to), and a failure in auto-record
can cost the recording but never the webhook event: it runs after the event's
own commit, in its own try/catch, and only when that commit actually
succeeded.

**Who may share.** `meetings.share_policy` — `host` | `cohost` | `everyone`,
default `everyone` so no existing meeting changes behaviour. Enforced where
it cannot be argued with: the LiveKit token's `canPublishSources` claim,
minted from the caller's role in the DATABASE. A policy change mid-meeting is
pushed to everyone already connected through `UpdateParticipant`, and role
changes push the same way, so promotion under a `cohost` policy lets somebody
share this minute rather than on their next token. The host sets the policy
at creation or live from the People panel. The Share button disables itself
with an honest tooltip for signed-in users; a guest (who cannot read the
policy) gets the server's refusal turned into a sentence.

One protojson trap worth knowing, now written down in LiveKitRoomClient: the
JWT grant spells TrackSource as lower_snake strings (`screen_share`), the
Twirp API's ParticipantPermission spells the same enum by NAME
(`SCREEN_SHARE`). Same concept, two wires, two spellings. Also:
UpdateParticipant REPLACES the permission object wholesale, so
canPublish/canSubscribe/canPublishData are restated on every call — omitting
them would revoke a microphone as a side effect of changing who may share.

**Stop one share.** The mute endpoint takes `kind: 'screen'` and targets the
SOURCE, not the media type — a screen share is a VIDEO track like a camera
is, and matching on type alone would stop a presenter's face when the host
meant to stop their slides. The People panel shows "Stop share" on anybody
sharing. (Camera mute now also excludes screen-share tracks for the same
reason, which was a latent wrong-target bug.)

**Pre-join screen.** Camera preview (mirrored, like every mirror), a live
microphone level meter, a speaker test chime generated from an oscillator (no
asset, works offline), device pickers, and join-with-mic/cam-off toggles that
Stage now honours. Deliberately no livekit-client — same reasoning as the
door: it must render fast on bad connections, and the SDK downloads while you
look at yourself. The seat token is a ten-minute join window, so time spent
here costs nothing. A camera denial never blocks joining.

**One found bug, fixed.** A signed-in colleague parked by
`waiting_room='everyone'` polls the same wait route as a guest, and the
admitted-claim lookup assumed `IsGuest` — so every admitted COLLEAGUE was
answered "This meeting link does not work". The lobby row carries their
user_id; the lookup now uses it.

## What was deliberately NOT built

**Pause/resume recording.** Verified against LiveKit: Egress has no
pause/resume (github.com/livekit/egress issue #195, open, unimplemented).
The honest version is stop-and-start producing multiple segment files — which
the recordings list already supports; each segment appears as its own row on
the meeting page. A Pause button that secretly stops and starts would
manufacture the expectation that one file comes out. If pause matters, the
UI should say "each pause starts a new file" — product call, not built today.

**Single-sharer enforcement.** The brief asks for one active sharer at a
time; the module ships multiple simultaneous sharers as a feature (built
deliberately — see §6 of the handover, feature 71). These want a product
decision before code: if one-at-a-time wins, it is a small server-side check
in the same UpdateParticipant machinery. Left as-is (multiple) today.

## Files touched

    local/postgres/init/20260819-connect-host-controls.sql     NEW  migration
    apps/api/Modules/Connect/ConnectEntities.cs                auto_record, share_policy, ConnectMeetingBlock, ConnectShare
    apps/api/Modules/Connect/LiveKitTokenService.cs            canPublishSources grant
    apps/api/Modules/Connect/LiveKitRoomClient.cs              SetPublishSourcesAsync, mute kind 'screen', LkTrack.Source
    apps/api/Modules/Connect/Endpoints/ConnectEndpoints.cs     blocklist, /host, share policy, auto-record fields
    apps/api/Modules/Connect/Endpoints/ConnectGuestEndpoints.cs  guest tokens under policy; colleague-admission fix
    apps/api/Modules/Connect/Endpoints/ConnectWebhookEndpoints.cs  auto-record on room_started
    apps/api/Shared/Data/AppDbContext.cs                       CORE'S FILE — via infra/patches/connect-host-0001-dbcontext.patch
    infra/patches/connect-host-0001-dbcontext.patch            NEW  the two Core-lane lines
    infra/scripts/connect-recording-verify.sh                  + a 20260819-connect-host-controls section (and the uncommitted 20260819-connect-minutes section)
    apps/web/lib/connect.ts                                    types, transferHost, mute 'screen'
    apps/web/app/connect/room/[code]/PreJoin.tsx               NEW  pre-join screen
    apps/web/app/connect/room/[code]/page.tsx                  prejoin phase
    apps/web/app/connect/room/[code]/RoomChrome.tsx            preview/meter/modal styles
    apps/web/app/connect/room/[code]/Stage.tsx                 leave dialog, roles, share policy, prefs
    apps/web/app/connect/(shell)/new/page.tsx                  auto-record + share policy fields

## Build, test, commit — on Windows

Nothing in this session could be COMPILED where it was written (no .NET, no
node_modules there), so the build below is not a formality — run it before
anything else, and treat a red build as this session's bug to find.

```powershell
cd apps\api ; dotnet build --nologo ; cd ..\..
pnpm --filter @tatvaos/web build

dotnet run --project tests\connect-wire
dotnet run --project tests\connect-minutes
```

Also still uncommitted from before this session (handover §7.0): the
Program.cs DI registration is ALREADY APPLIED in this tree (line ~149) — it
needs committing, not applying.

```powershell
git status --short          # read it; push.cmd does git add -A
git add apps/api/Program.cs apps/api/Modules/Connect apps/api/Shared/Data/AppDbContext.cs `
        apps/web/lib/connect.ts "apps/web/app/connect/room/[code]" "apps/web/app/connect/(shell)/new/page.tsx" `
        local/postgres/init/20260819-connect-host-controls.sql `
        infra/patches/connect-host-0001-dbcontext.patch infra/scripts/connect-recording-verify.sh `
        docs/CONNECT_HOST_CONTROLS.md docs/CONNECT_COORDINATION.md
git commit -m "Connect: host controls — leave dialog, co-host, blocklist, auto-record, share policy, pre-join"
git push
```

## Deploy — on the box

```bash
cd /srv/tatvaos-production
git checkout -- apps/api/Program.cs   # the sed edit; the same line now comes from git
git pull
git log --oneline -1                  # confirm the commit you expect
./infra/scripts/deploy.sh production  # THE ARGUMENT IS REQUIRED
bash infra/scripts/connect-recording-verify.sh   # now checks 20260819-connect-minutes AND 20260819-connect-host-controls
```

## What to test by hand (the parts no suite covers)

A meeting with three people — host, colleague, guest:

1. Set sharing to "Only the host" from the People panel → the colleague's
   Share button disables within a second or two; the guest's share attempt
   says the host has limited sharing. Set back to Everyone → both can share.
2. Promote the colleague to co-host under "host + co-hosts" policy → they can
   share immediately, no rejoin.
3. Remove the colleague → they see "You were removed"; their rejoin via the
   same link answers "The host removed you from this meeting". Try to admit
   them from the lobby if they knock → refused with a sentence.
4. Host clicks Leave → dialog. Hand to the colleague → old host's controls
   demote to co-host, meeting continues. Rejoin as the new host and End.
5. Create a meeting with auto-record on (org recording ON) → first join
   starts an audio recording; the notice appears for everyone. Repeat with
   org recording OFF → meeting runs unrecorded, API log says why.
6. Pre-join: deny the camera → the screen says so and Join still works.
   `waiting_room='everyone'`, join as a signed-in colleague, admit them —
   this exercises the colleague-admission fix.
