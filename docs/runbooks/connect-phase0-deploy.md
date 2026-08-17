# Runbook — Connect Phase 0 deploy (LiveKit + coturn)

Written before the first deploy, as runbooks here are. Everything below
assumes the box, the repo checkout at `/srv/tatvaos-production`, and the
usual compose invocation:

```
COMPOSE="docker compose -f infra/docker/docker-compose.base.yml \
         -f infra/docker/docker-compose.production.yml \
         --env-file infra/docker/.env"
```

---

## The happy path

1. Commit and push the Connect Phase 0 changes from the dev machine; on the
   box: `git pull` (branch `main`, as always).
2. Append the five variables to `infra/docker/.env` (never the example file):

   ```
   LIVEKIT_API_KEY=$(openssl rand -hex 8)
   LIVEKIT_API_SECRET=$(openssl rand -base64 32)
   TURN_USERNAME=tatvaos
   TURN_PASSWORD=$(openssl rand -base64 24)
   TURN_EXTERNAL_IP=<this box's public IPv4>
   ```

   Copy the filled values into Bitwarden, same as every other secret.
3. Firewall (Linode Cloud Firewall if one is attached, plus any ufw):
   inbound **UDP 3478**, **UDP 49160–49999**, **UDP 50000–50199**,
   **TCP 7881**. 443 already carries `/rtc`.
4. `bash infra/scripts/connect-phase0-preflight.sh` — must end `0 failed`.
5. `./infra/scripts/deploy.sh production` — the usual gauntlet; the two new
   services count toward its health gate.
6. `bash infra/scripts/connect-phase0-smoke.sh` — must end `0 failed`.
7. `bash infra/scripts/connect-dev-token.sh amit` → paste the token at
   `https://connect.tatvaos.com/connect/dev` → run the four-step protocol
   in `docs/CONNECT_PHASE0.md` (two networks → Force TURN → 5 minutes →
   deliberate drop).
8. Afterwards: pin the two image digests
   (`docker inspect --format '{{index .RepoDigests 0}}' $(docker ps -q -f name=livekit)`,
   same for coturn) into `docker-compose.base.yml` in the next commit, and
   record the protocol results in the Phase 0 PR.

---

## Symptom → diagnosis → fix → confirm

### `docker compose` refuses immediately: "LIVEKIT_API_KEY must be set"

- **Diagnosis:** the five Connect variables are not in `infra/docker/.env`
  yet. The compose file demands them with `:?` on purpose — failing to
  start beats starting wrong.
- **Fix:** happy-path step 2.
- **Confirm:** preflight goes green.

### Caddy restart-loops, or every product is suddenly down

- **Diagnosis:** the whole-config-rejection failure the platform has met
  before — a `conf.d` file referencing an unset variable. Phase 0 adds
  **no** new Caddy variable, so if this happens the cause is a different
  edit riding along. Read: `$COMPOSE logs --tail 30 caddy`.
- **Fix:** validate from the outside without touching the running config:
  `$COMPOSE exec -T caddy caddy validate --config /etc/caddy/Caddyfile` —
  the error names the file and line. Correct it, then
  `$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile`.
- **Confirm:** every `*.tatvaos.com` loads; smoke test §route passes.

### `livekit` is restarting in a loop

- **Diagnosis:** `$COMPOSE logs --tail 30 livekit`. Two known causes:
  a YAML mistake in `infra/docker/livekit.yaml` (the server refuses unknown
  or malformed config), or a malformed `LIVEKIT_KEYS` — the format is
  `key: secret`, **with the space**, which the compose file builds from the
  two env variables; a stray `=` or quote inside either value breaks it.
- **Fix:** correct the file or the variable; `$COMPOSE up -d livekit`.
- **Confirm:** smoke test shows `livekit running` and the `/rtc` route
  answers 401/400.

### `coturn` exits immediately

- **Diagnosis:** `$COMPOSE logs --tail 30 coturn`. Usual suspects: port
  3478 already taken on the host (`ss -ulnp | grep 3478` — coturn is
  host-networked), a typo'd flag, or an empty `TURN_EXTERNAL_IP`.
- **Fix:** free the port or fix the variable; `$COMPOSE up -d coturn`.
- **Confirm:** `ss -uln | grep 3478` shows a listener.

### `deploy.sh` fails at the health gate ("services running N/M")

- **Diagnosis:** `$COMPOSE ps` — find the service that is not `running`.
  If it is livekit or coturn, use their entries above. The original
  platform services do not depend on either newcomer, so customer traffic
  is unaffected while you debug.
- **Fix:** per-service, above. Rollback below if it will not yield quickly.
- **Confirm:** re-run `./infra/scripts/deploy.sh production` end to end.

### Browsers join, but no video/audio between two networks

The connection state says `connected` (signalling is fine over 443) but
tiles stay black across networks. This is the firewall, and the Force TURN
checkbox is the instrument:

| Direct (box off) | Force TURN (box on) | Meaning | Open |
|---|---|---|---|
| fails | **works** | media UDP range blocked | UDP 50000–50199 (and TCP 7881 for the TCP fallback) |
| works | fails | TURN unreachable or misconfigured | UDP 3478 + UDP 49160–49999; check TURN creds typed on the page match `.env`; check `TURN_EXTERNAL_IP` |
| fails | fails | both closed, or provider-level block | all four ranges; then `chrome://webrtc-internals` + `$COMPOSE logs coturn` (look for `ALLOCATE` lines) |

- **Confirm:** protocol steps 2 and 3 pass from a phone on mobile data.

### `deploy.sh` stops at "Pulling and building" — `next build` exit 1

**Met for real on 2026-08-17.** The tail deploy.sh prints shows only ESLint
*warnings*, which is misleading: the fatal lines scrolled past above it.

- **Diagnosis:** `eslint.config.mjs` extends `next/typescript`, so
  `@typescript-eslint/no-explicit-any` is an **error**, and any error fails
  `next build`. ESLint prints files alphabetically, so an offender under
  `app/connect/…` appears well before `app/mail/…`. Read the real cause with:
  ```
  $COMPOSE build web 2>&1 | grep -iE "error|Failed to compile" | head -30
  ```
- **Fix:** type the offending code. Do **not** reach for
  `eslint.ignoreDuringBuilds` or a blanket disable comment — that turns a
  one-file problem into a platform-wide blind spot.
- **Confirm:** the same grep is empty and the build proceeds past ~50s.
- **Prevention:** `pnpm typecheck` at the repo root catches types but **not**
  lint. Before committing a new page, also run
  `pnpm --filter @tatvaos/web exec eslint <file>`.
- **Production is safe throughout:** deploy.sh builds *before* it recreates
  anything, so a failed build leaves the running containers untouched.

### Force TURN fails, or works only sometimes, while direct works

- **Diagnosis:** coturn left to itself discovers *every* local address and
  will allocate a relay on a docker bridge (`172.17.0.1`, `172.18.0.1`).
  Such a relay is unreachable from the internet, and because `--external-ip`
  rewrites the candidate handed to the client, the allocation fails
  **silently**. Check with `ss -uln | grep 3478`: bridge addresses in that
  list mean the pinning below is missing.
- **Fix:** `--listening-ip` and `--relay-ip` pinned to the public address in
  `docker-compose.base.yml` (both present since 2026-08-17). Then
  `$COMPOSE up -d coturn`.
- **Confirm:** `ss -uln | grep 3478` lists **only** the public IP, and the
  smoke test says `UDP 3478 bound on <public ip>`.

### coturn logs `no-cli option is deprecated` or `Unknown argument:`

- **Diagnosis:** the image ships coturn **4.17.2**, where the CLI is off by
  default and `--no-cli` is deprecated (removed here on 2026-08-17). The
  empty `Unknown argument:` comes from the image's own
  `docker-entrypoint.sh` appending an unset variable as one empty argument —
  coturn ignores it and starts normally.
- **Fix:** none needed for the empty argument. It is noise, not a fault;
  bypassing the entrypoint would trade known noise for unknown behaviour.
- **Confirm:** the log reaches `Total relay threads:` / `Total auth threads:`
  and `ss` shows the listener.

### `git pull` on the box says "Already up to date" but you expected a change

- **Diagnosis:** the commit is still local on the dev machine. Every fix in
  this runbook reaches the box only via commit **and push**.
- **Confirm:** `git log --oneline -1` on both sides shows the same SHA.

### "Permission denied" from the camera, with NO browser prompt, on every device

**Met for real on 2026-08-17** — Chrome on a laptop and Samsung Internet on a
phone, both with no permission prompt and no site setting to change.

- **Diagnosis:** not a browser setting. `apps/web/next.config.ts` sends
  `Permissions-Policy: camera=(), microphone=(), geolocation=()` on every
  response. An empty allowlist means *no origin at all*, including this one,
  so the browser refuses `getUserMedia` before it ever asks the person.
  Confirm with:
  ```
  curl -sI https://connect.tatvaos.com/connect/dev | grep -i permissions-policy
  ```
- **Fix:** scope the header — Connect's routes get
  `camera=(self), microphone=(self), display-capture=(self)`, every other
  path keeps the restrictive default. `next.config.ts` is **Core's file**, so
  this travels as a patch for review, not as an edit
  (`connect-phase0-0008-permissions-policy.patch`). A full
  `deploy.sh production` is required: it rebuilds the web image.
- **Why not one blanket header:** browsers **combine** multiple
  Permissions-Policy headers restrictively, so adding a permissive header
  next to the restrictive one still blocks. There must be exactly one per
  response, which is why the two `source` patterns are complementary rather
  than overlapping.
- **Confirm:** the curl above shows `camera=(self)` on `/connect/…` and
  `camera=()` on `/mail/…`; the browser then prompts normally.

### LiveKit logs `path=/rtc/rtc/v1  invalid authorization token`

**Met for real on 2026-08-17, during the first browser test.**

- **Diagnosis:** the path is doubled. `livekit-client` appends the
  signalling path to whatever base URL you hand it — `createV0RtcUrl()`
  appends `rtc`, then `v1` for the versioned path — so a base ending in
  `/rtc` yields `/rtc/rtc/v1`, which LiveKit rejects. The token is fine;
  the URL is not.
- **Fix:** give the client the **origin only** —
  `wss://connect.tatvaos.com`, no path. Caddy's `handle /rtc*` covers
  `/rtc`, `/rtc/v1` and `/rtc/v1/validate` alike, so nothing changes
  server-side. (The dev page's default was corrected on 2026-08-17; anyone
  typing a URL by hand should still know this.)
- **Confirm:** the LiveKit log shows `/rtc/v1` — single `rtc` — and the
  page's state goes to `connected`.

### The page says "connecting…" then errors before any state change

- **Diagnosis:** the wss URL. `curl -s -o /dev/null -w '%{http_code}\n'
  https://connect.tatvaos.com/rtc/validate` — a **404** means Caddy is
  serving the config from before the deploy (its container was not
  recreated and reload did not run).
- **Fix:** `$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile`
  (deploy.sh does this; it is non-fatal there, so it can be missed — its
  output says so loudly).
- **Confirm:** the same curl returns 401 or 400 — that is LiveKit
  answering "where is your token", which is correct.

### Rollback — remove Connect's services, keep everything else

```
git checkout -- infra/docker/docker-compose.base.yml \
                infra/docker/docker-compose.production.yml \
                infra/docker/conf.d/connect.caddy
$COMPOSE up -d --remove-orphans
$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

`--remove-orphans` retires the livekit and coturn containers; the extra
`.env` variables, `livekit.yaml`, the scripts and the dev page are inert
without their services. Nothing here touches volumes, the database, or any
other product's service definition.

- **Confirm:** `$COMPOSE ps` lists exactly the pre-Connect services, all
  running; every product hostname loads.

---

## Validation record

**2026-08-16, off-box.** Patches applied cleanly to the working tree; both
compose files and `livekit.yaml` parse; coturn boot-tested with the exact
flag set; the token script's JWT verified with the official
`livekit-server-sdk` 2.17.0 verifier — claim-for-claim identical to the
SDK's own output. Not testable off-box (no route to Docker Hub from the
build sandbox): booting the real LiveKit image, and the floating tags.

**2026-08-17, first deploy on the box — what is now proven:**

- `deploy.sh production` completes; **all 10 services running**.
- LiveKit answers on the compose network, and
  `https://connect.tatvaos.com/rtc/validate` returns **401** through public
  TLS — signalling reaches LiveKit, which correctly refuses an
  unauthenticated request.
- coturn 4.17.2 starts and binds UDP 3478.
- Schema application, pre-deploy backup and Caddy reload all unaffected by
  Connect's additions.

**Two bugs found and fixed on the day** (both recorded above): the dev page
failed the build on `no-explicit-any`, and coturn was binding docker bridge
addresses. A third was mine in the tooling — `preflight`/`smoke` used
`grep -q` under `set -o pipefail`, so a match SIGPIPEd `ss` and the check
reported the opposite of the truth, *intermittently*. Both scripts now use
`grep -c`, which reads to EOF. If you write another check here, do the same.

**Still to prove:** the four-step browser protocol (two networks, Force
TURN, five minutes, deliberate drop) and image digest pinning.
