# Connect recording — build and deploy

Two machines. Everything below is runnable as written **except two lines**, and
both are marked, and both fail safely rather than doing the wrong thing.

No new npm or NuGet packages were added, so `pnpm-lock.yaml` and the `.csproj`
are untouched and CI's `--frozen-lockfile` has nothing to complain about.

---

# PART 1 — your machine (PowerShell)

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
```

## 1.1 Build both halves before committing anything

```powershell
dotnet build apps/api
pnpm build
```

Both must be clean. `pnpm build` should show `/connect/room/[code]` at about
**7.6 kB / 114 kB** and `/connect/meetings/[id]` at about **4.9 kB / 114 kB**.
If the room jumps back to ~245 kB, the `next/dynamic` split has been lost.

## 1.2 Stage — directories, not globs

```powershell
git add apps/api/Modules/Connect
git add apps/api/Workers/ConnectNotesWorker.cs
git add apps/api/Program.cs
git add apps/api/Shared/Data/AppDbContext.cs
git add apps/web/app/connect
git add apps/web/lib/connect.ts
git add infra/docker/docker-compose.base.yml
git add infra/docker/docker-compose.production.yml
git add infra/scripts/connect-recording-verify.sh
git add infra/scripts/connect-phase1-verify.sh
git add infra/patches
git add local/postgres/init/20260818-connect-recording.sql
git add docs/CONNECT_RECORDING_AND_NOTES.md
git add docs/CONNECT_RECORDING_DEPLOY.md
```

> **Why directories for the web paths.** `apps/web/app/connect/room/[code]/Stage.tsx`
> looks like a path and is not: git pathspecs are globs, and `[code]` is a
> character class matching one of `c o d e`. It would silently match nothing
> and the file would not be staged, and you would find out on the box. Adding
> the parent directory sidesteps it entirely.

Check what you are about to commit:

```powershell
git status --short
git diff --cached --stat
```

## 1.3 Commit

```powershell
git commit -m "Connect: record meetings, transcribe them, and write the notes

Egress records a room to a shared volume; the webhook moves the row to ready;
a worker transcribes it and writes notes from the transcript.

Audio is the default everywhere. LiveKit prices a video room composite at 4 CPU
against 1 for audio (egress/pkg/config/service.go) because audio-only with no
layout takes the SDK path and never launches Chrome. On one box also running
the SFU that is the difference between recording a meeting and degrading it.

Recordings charge the ORGANISATION, through core.storage_allocations with
product_code 'connect', derived rather than incremented. Deliberately NOT in
core.user_storage_usage: charging the host would move a colleague's remaining
space when somebody else records.

Transcription is off unless a URL is set, so no audio leaves the box by
default. The contract is OpenAI's /v1/audio/transcriptions, which every
self-hosted Whisper server and every vendor already speaks, so the choice stays
three environment variables rather than a rebuild. With no notes model the
notes are a mechanical digest and say so.

The in-room notice is driven by LiveKit's room.isRecording, not by this API, so
a client cannot decline to show it, and it is read on Connected as well as on
the event so somebody joining a recording already in progress is still told.

Widens connect.meeting_events.kind to accept egress events. Without that the
first egress webhook fails its CHECK, the handler answers 500, and LiveKit
retries a request that can never succeed."
```

The earlier uncommitted work — `apps/web/lib/nav.tsx`, the two brand PNGs,
`docs/CONNECT_FEATURE_AUDIT.md`, `docs/CONNECT_TEST_AND_NEXT_BUILD.md` — is a
separate concern. Its own commit:

```powershell
git add apps/web/lib/nav.tsx apps/web/public/brand docs/CONNECT_FEATURE_AUDIT.md docs/CONNECT_TEST_AND_NEXT_BUILD.md
git commit -m "Connect: brand tile, logo pair, feature audit and test plan"
```

`_to_delete/` is scratch and should not be committed. If it keeps showing up:

```powershell
Add-Content .gitignore "`n_to_delete/"
```

## 1.4 Push

```powershell
git push
```

Wait for CI to go green before Part 2.

---

# PART 2 — the production box

```bash
cd /srv/tatvaos-production
git pull

# Used throughout Part 2. Re-run this line if you open a new shell.
C="docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env"
```

## 2.1 Switch recording on for this server

```bash
grep -q '^CONNECT_RECORDING_ENABLED=' infra/docker/.env \
  || echo 'CONNECT_RECORDING_ENABLED=true' >> infra/docker/.env
grep -n 'CONNECT_RECORDING' infra/docker/.env
```

Transcription and notes are **optional** and take values only you can choose.
Leave them unset for now — recording works without them, and nothing leaves the
box. When you have picked a service, add whichever apply:

```
CONNECT_TRANSCRIPTION_URL=
CONNECT_TRANSCRIPTION_KEY=
CONNECT_TRANSCRIPTION_MODEL=
CONNECT_TRANSCRIPTION_LANGUAGE=
CONNECT_NOTES_URL=
CONNECT_NOTES_KEY=
CONNECT_NOTES_MODEL=
```

## 2.2 Deploy

```bash
./infra/scripts/deploy.sh production
```

`deploy.sh` applies `local/postgres/init/*.sql` **before** recreating
containers, so `20260818-connect-recording.sql` lands first. Watch for:

```
OK  20260818-connect-recording.sql
```

and for **11** services running rather than 10 — `egress` is the new one. It
pulls `livekit/egress:latest`, which is a few hundred MB, so the first deploy
takes longer than usual.

## 2.3 The volume — the step that, skipped, makes recordings silently vanish

Egress writes as uid **1001**. The API reads and deletes as **5000**. So the
directory has to be owned by egress, group-owned by the API, and **setgid** so
files egress creates inherit the API's group rather than egress's.

This runs **after** the deploy, not before. Creating the volume by hand first
would be one step shorter, but Compose inspects volumes it did not create and
I could not test that behaviour against your Compose version from here — so
this ordering is the one that does not depend on the answer. Compose creates
the volume during 2.2; we fix its ownership and restart the two containers
that use it.

```bash
docker run --rm -v tatvaos_connectrec:/r alpine \
  sh -c 'chown 1001:5000 /r && chmod 2775 /r && ls -ldn /r'
```

Expect `drwxrwsr-x ... 1001 5000`. The **`s`** in the group position is the
setgid bit — without it, egress's files land in egress's group and the API
cannot delete them.

If that errors with *no such volume*, the deploy did not create it. Check the
service is in the rendered config:

```bash
$C config --volumes
docker volume ls | grep connectrec
```

Then pick up the new ownership:

```bash
$C up -d --force-recreate api egress
```

## 2.4 Pin the egress image

`livekit` and `coturn` are pinned by digest so a later `compose pull` cannot
swap them under a deployment that works. Egress shipped as a tag because the
digest could not be resolved from the machine that wrote it. Pin it now — this
is fully runnable, no editing:

```bash
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' livekit/egress:latest | cut -d@ -f2)
echo "resolved: ${DIGEST}"
sed -i "s|image: livekit/egress:latest$|image: livekit/egress:latest@${DIGEST}|" \
  infra/docker/docker-compose.base.yml
grep -n 'image: livekit/egress' infra/docker/docker-compose.base.yml
```

The `$` anchor means running it twice does nothing — an already-pinned line no
longer ends in `latest`. Verified against your actual file, including the
second run and that the result still parses as YAML.

Then apply it:

```bash
$C up -d egress
```

Commit it on your machine afterwards so the pin is not lost on the next pull:
the same one-line change to `infra/docker/docker-compose.base.yml`.

## 2.5 Verify

```bash
bash infra/scripts/connect-recording-verify.sh
bash infra/scripts/connect-phase1-verify.sh
```

`connect-phase1-verify.sh` now expects **7 tables and 12 definer functions**,
not 4 and 4. If it still says 4, the migration did not apply.

Anything that fails, send me the exact output.

## 2.6 Switch recording on for the organisation

Default is off, per organisation, on purpose. First list them:

```bash
$C exec -T postgres psql -U postgres -d tatvaos_mail \
  -c "SELECT id, name, allow_connect_recording FROM core.tenants ORDER BY created_at"
```

> **The next line is the one line here that needs editing.** Replace
> `PASTE_TENANT_ID` with an id from the list above. Run as-is it fails with
> `invalid input syntax for type uuid` and changes nothing — it cannot do the
> wrong thing, only nothing.

```bash
$C exec -T postgres psql -U postgres -d tatvaos_mail \
  -c "UPDATE core.tenants SET allow_connect_recording = true WHERE id = 'PASTE_TENANT_ID'"
```

## 2.7 Test — T8

Full table is in `docs/CONNECT_RECORDING_AND_NOTES.md`. The short version, and
the two rows that actually matter:

1. Start a meeting, press **Record**. Button turns red, red banner appears.
2. Have a second person join **while it is recording** — they should see the
   banner without doing anything.
3. Talk for a minute. Press **Stop rec**.
4. **This one:**

```bash
$C exec -T postgres psql -U postgres -d tatvaos_mail \
  -c "SELECT status, mode, size_bytes, duration_ms, file_name, error FROM connect.recordings ORDER BY created_at DESC LIMIT 5"
```

Expect `ready`, a non-zero size, and a bare file name with no slashes.

5. **And this one:** meeting page → Recordings → **Download**. If the audio
   plays, the API can read what egress wrote and 2.1 was done correctly.

If step 4 shows `starting` or `recording`, wait five minutes and run it again.
The worker asks LiveKit directly about anything stuck, so it will correct
itself — but if it only moves after five minutes, the **webhook is not
arriving**, which is a different bug from recording not working, and worth
knowing which one you have.

---

# If something goes wrong

**Nothing at all happens when you press Record.**

```bash
$C logs --tail 100 api | grep -iE 'egress|recording|LOST|row-level'
```

**Egress will not start, or restarts.**

```bash
$C logs --tail 100 egress
```

`NOAUTH` / `WRONGPASS` / `connection refused` means the Redis bus. Check both
sides agree:

```bash
$C exec -T livekit sh -c 'echo "$REDIS_HOST / ${REDIS_PASSWORD:0:4}..."'
$C exec -T egress sh -c 'echo "$EGRESS_CONFIG_BODY"' | head -5
```

**The recording says ready but Download 404s.** That is 2.1. Check it:

```bash
$C exec -T api sh -c 'ls -ln /var/lib/connect/recordings; stat -c "%u %g %a" /var/lib/connect/recordings'
```

Want `1001 5000 2775` — 1001 is what egress actually reports on this box; confirm with `$C exec -T egress id -u` rather than trusting the number.

**Roll back the recorder without rolling back anything else.** The rest of
Connect does not depend on it:

```bash
$C stop egress
sed -i 's|^CONNECT_RECORDING_ENABLED=true|CONNECT_RECORDING_ENABLED=false|' infra/docker/.env
$C up -d --force-recreate api
```

Every recording endpoint then answers *"Recording is not switched on for this
server"*, the button disappears from the room, and meetings carry on. Nothing
is deleted — the rows and any files already written stay where they are.

**Full rollback.** `git revert` the commit and redeploy. The migration is
additive and idempotent: the three tables and the widened CHECK stay, and
nothing reads them. It does not need undoing, and undoing it would drop
recordings somebody may already have.
