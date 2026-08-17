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

## What was validated before this runbook was written (2026-08-16, off-box)

Patches applied cleanly to the live working tree; both compose files and
`livekit.yaml` parse; **coturn 4.6.1 boot-tested with the exact flag set**
from the compose file (full startup sequence, all flags accepted); the
token script's JWT **verified with the official `livekit-server-sdk` 2.17.0
verifier** — claim-for-claim identical to the SDK's own output; the dev
page parses. Not testable off-box (sandbox has no route to Docker Hub):
booting the actual `livekit/livekit-server` image against `livekit.yaml`,
and the two floating image tags — which is why the preflight, the smoke
test, and the livekit entry above exist, and why step 8 pins digests once
the images are proven on the box.
