# Connect Phase 0 — prove the media path

**Status: COMPLETE — 2026-08-17. Deployed to production and the four-step
protocol passed.** Connect's media path is proven on our own infrastructure.
The short version lives in `docs/runbooks/connect-phase0-deploy.md`; this
document is the reasoning. Phase 1 begins when Core has reviewed
`docs/CONNECT_API.md`.

Deliverable, from the brief: *two people, two networks (one on mobile data),
audio and video both directions, through TURN, five minutes without
dropping.* No features, no schema, no API code — this phase is
infrastructure and one throwaway page.

The six `connect-phase0-000N-*.patch` files at the repo root are the
applied change, kept as the review record; `git diff` shows the same
content as tracked modifications.

---

## What gets added

```
Browser A ──┐                          ┌── 7880 ws ── caddy `handle /rtc*` on connect.tatvaos.com
            ├── wss signalling ────────┤
Browser B ──┘                          └──► livekit container (mailnet)
     │                                            ▲
     │  media: UDP 50000–50199 straight to the    │ published 1:1 on the host
     ├────────────────────────────────────────────┘
     │  when UDP cannot pass: TURN relay
     └──► coturn (host network) UDP 3478, relay 49160–49999 ──► livekit's ports
```

| Piece | Where | Patch |
|---|---|---|
| `livekit` service | `infra/docker/docker-compose.base.yml` | `0001` |
| `coturn` service | same file | `0001` |
| LiveKit config | `infra/docker/livekit.yaml` (new) | `0002` |
| Signalling route | `infra/docker/caddy/conf.d/connect.caddy` — add `handle /rtc*` | `0003` |
| Variables | `infra/docker/.env.production.example` | `0004` |
| Production limits/logging | `infra/docker/docker-compose.production.yml` | `0005` |
| Throwaway test page | `apps/web/app/connect/dev/page.tsx` (new) | `0006` |

Design choices, argued:

- **Signalling rides `connect.tatvaos.com/rtc`.** LiveKit's websocket lives
  at `/rtc` on its own port; Caddy already fronts the connect hostname, so a
  path handle gives us wss with the existing certificate — no new subdomain,
  no new DNS wait, no new `*_DOMAIN` variable, and therefore no way to
  recreate the family.caddy crash-loop. Media never touches Caddy, exactly
  as the brief requires. (Contract Open Question §8 records the subdomain
  alternative.)
- **LiveKit stays on the bridge network** with its UDP range published 1:1
  and `use_external_ip: true`, so ICE candidates advertise the box's public
  IP. 200 UDP ports is deliberate Phase 0 sizing — enough for dozens of
  simultaneous participants, small enough that docker's per-port proxies are
  a non-issue. Widening the range (or moving LiveKit to host networking) is
  a production-sizing decision for the capacity conversation below.
- **coturn runs on the host network.** A TURN relay allocates ports from its
  relay range on demand; publishing that range through the docker proxy one
  port at a time is exactly the overhead host networking exists to skip.
  Ranges must not overlap: coturn relays on 49160–49999, LiveKit media on
  50000–50199.
- **Secrets stay in `.env`.** LiveKit's key pair arrives via `LIVEKIT_KEYS`
  (environment), coturn's static credential via compose `command:`
  substitution — the repo carries neither, matching the postgres-password
  pattern. Static `lt-cred-mech` is Phase-0-grade; the follow-up (rotating
  `use-auth-secret` or LiveKit's embedded TURN once a TLS cert exists) is
  listed under "not in this phase".
- **No TURN-over-TLS (5349) yet.** It needs a certificate coturn can read,
  which means either a `turn.tatvaos.com` name + issuance story or sharing
  Caddy's — a real decision, not a default. UDP 3478 TURN covers the
  ordinary "corporate wifi blocks peer-to-peer" case; total-UDP-blackout
  networks are the follow-up. Flagged in the asks below.

## Deploy sequence (on the box)

The runbook (`docs/runbooks/connect-phase0-deploy.md`) is the checklist;
three scripts do the checking so deploy day is reading green lines, not
remembering rules:

1. Commit + push from the dev machine; `git pull` on the box. Add the five
   variables to `infra/docker/.env` (generation commands in the runbook) —
   compose demands them with `:?`, so nothing starts half-configured.
2. Open the firewall: inbound UDP 3478, UDP 49160–49999, UDP 50000–50199,
   TCP 7881. 443 is already open and now also carries `/rtc` websockets.
3. `bash infra/scripts/connect-phase0-preflight.sh` — env values present
   and not CHANGE_ME, TURN_EXTERNAL_IP matches the box, mounted files
   present, host ports free, compose interpolates, and the running Caddy
   validates the new conf.d **before** anything is deployed.
4. `./infra/scripts/deploy.sh production` — the two new services must reach
   `running` or the deploy's health gate fails, loudly, which is what we
   want.
5. `bash infra/scripts/connect-phase0-smoke.sh` — services up, LiveKit
   answering, `/rtc` reaching LiveKit through TLS (401/400, not the web
   app's 404), coturn bound.
6. Pin the images: the compose file uses floating tags
   (`livekit/livekit-server:latest`, `coturn/coturn:alpine`) so nothing
   depended on guessing a version; once the deploy is proven,
   `docker inspect --format '{{index .RepoDigests 0}}'` each and write the
   digests back into the compose file in the next commit.

## The test protocol — what "works" means

The throwaway page is `/connect/dev` — no shell, no session, takes the
websocket URL (prefilled `wss://connect.tatvaos.com/rtc`) and a pasted
token, renders local + remote tiles, and has one checkbox that matters:
**Force TURN**, which sets `iceTransportPolicy: 'relay'` so a "pass" cannot
secretly be a direct connection.

Mint one token per person on the box (never in a browser, never in the
repo) — pure stdlib python, no image pull, and the JWT it emits was
verified claim-for-claim against the official livekit-server-sdk:

```
bash infra/scripts/connect-dev-token.sh amit
bash infra/scripts/connect-dev-token.sh priya-phone
```

Then, in order — each step only counts after the previous one passes:

1. **Same machine, two browser tabs** — proves LiveKit + signalling route.
2. **Two machines, two networks** — office/home wifi vs **mobile data**
   (phone browser is fine and is the realistic client anyway).
3. **Same pair, Force TURN on** — proves coturn actually relays; watch
   `docker logs -f tatvaos-coturn-1` for the allocation lines.
4. **Five minutes, audio + video both directions, then a deliberate
   network drop** (toggle wifi) — LiveKit's client should resume on its own.
5. Record in this file's PR: date, networks used, direct or relayed, and
   `docker stats` for livekit during the call.

Pass = steps 1–4 clean. Then Phase 1 starts; this page is deleted the day
the real room screen exists.

## Capacity estimate — first numbers for Amit (finalized before Phase 1 ends)

The SFU multiplies **outbound** bandwidth: each participant uploads once
(~1 Mbps at 720p) and downloads everyone else.

| Scenario | In | Out (worst case, gallery view) |
|---|---|---|
| 1 meeting × 6 people | ~6 Mbps | 6×5×1 ≈ **30 Mbps** |
| 5 meetings × 8 people | ~40 Mbps | 5×(8×7×1) ≈ **280 Mbps** |
| 20 meetings × 8 people | ~160 Mbps | ≈ **1.1 Gbps** |

Simulcast (already on in the config) cuts real-world outbound roughly in
half because thumbnails subscribe to the low layer — but the shape of the
math stands. Two consequences, both asks rather than surprises:

- **Monthly transfer is the bill, not the port.** 280 Mbps sustained ≈ 3 TB
  **per day**. The current Linode's transfer allowance and the price of
  overage decide whether Connect gets its own box the moment real customers
  meet daily — the brief predicted this ("Connect will not fit"), and this
  table is the start of the written estimate it demands.
- **Phase 0 on the current box is fine** — two people is ~2 Mbps. The
  decision point is a Phase 1 pilot with one real customer, before which we
  need the target: how many concurrent meetings is launch sized for?

## What I need from Amit

1. Go/no-go to run Phase 0 on the production box (traffic is negligible;
   the risk is config, which the health gate catches).
2. Firewall reality check: is a Linode Cloud Firewall active on the box, and
   who opens the UDP ranges above?
3. The launch sizing target (concurrent meetings × typical size) so the
   capacity estimate becomes a number with a price on it.
4. Later, with no urgency: a decision on TURN-over-TLS (5349) — needs a
   hostname + certificate story — and on `turn.`/`rtc.` subdomains vs the
   `/rtc` path.

## Result — the protocol, run 2026-08-17

The deliverable this phase existed for, met in full:

| Step | Result |
|---|---|
| 1. Two browsers in a room, audio + video both ways | **PASS** — Windows/Chrome laptop and Android/Samsung Internet phone, each subscribing to the other's audio and video |
| 2. Two different networks, one on mobile data | **PASS** — phone on carrier data with wifi off |
| 3. Relay-only (`iceTransportPolicy: 'relay'`) through coturn | **PASS** — so the ~15–20% of real connections that cannot go direct are covered, not assumed |
| 4. Five minutes, then a deliberate network drop | **PASS** — reconnected on its own, no black rectangle |

LiveKit reported `connectionType: "udp"` with sub-500 ms connect times
throughout. **Connect's media never leaves TatvaOS infrastructure**, which is
the property the whole architecture was chosen for.

Both images are now **pinned by digest** to exactly the builds the protocol
ran against — `livekit/livekit-server@sha256:3497163e…` and
`coturn/coturn@sha256:771a95d0…` (coturn 4.17.2). The readable tag stays
beside the digest; docker resolves the digest. Re-pin only by re-running the
protocol, never by deleting the digest to "get the latest".

One thing left: delete `/connect/dev` the day the real room screen exists.

## What the first deploy proved, and what it cost (2026-08-17)

**Proven on the box:** `deploy.sh production` completes with all 10 services
running; LiveKit answers inside the compose network; `/rtc/validate` returns
**401 over public TLS**, so signalling reaches LiveKit through Caddy on the
existing certificate exactly as designed; coturn 4.17.2 binds UDP 3478.
Schema application, the pre-deploy backup and the Caddy reload were
untouched by Connect's additions. **Remaining:** the four-step browser
protocol, then digest pinning.

**Three bugs, all worth the phase existing.** The dev page failed the build
on `@typescript-eslint/no-explicit-any` — `next/typescript` makes it an
error, and `pnpm typecheck` cannot see lint, which is why the check now
belongs in the pre-commit habit. coturn was binding docker bridge addresses
and would have allocated relays unreachable from the internet, failing
*silently* because `--external-ip` rewrites the candidate — found by reading
the startup log rather than by any test, and the reason the flag set now
pins `--listening-ip` and `--relay-ip`. And the preflight/smoke port checks
used `grep -q` under `set -o pipefail`, where a match SIGPIPEs `ss` and the
pipeline reports failure — so the check returned the opposite of the truth,
*intermittently*. That last one is the instructive one: a check that lies is
worse than no check, and it lied in both directions on different runs.

**Off-box validation that did hold up (2026-08-16):** compose and
`livekit.yaml` parsing, coturn's flag set boot-tested, and the token
script's JWT verified against the official `livekit-server-sdk` verifier —
that last one meant tokens worked first time on the box.

## Note on the patch files

`connect-phase0-000{1..6}-*.patch` at the repo root are the review record of
what Phase 0 introduced, kept in step with the tree (0001 and 0006 were
regenerated after the 2026-08-17 fixes). **Git history is the source of
truth**; the patches exist because this platform exchanges cross-lane work
as patches, and a patch that no longer matches its file is a trap.

## Not in this phase, deliberately

Schema, API module, webhooks, tokens minted by our API (script-minted
only), the room UI, recording/Egress, TURN-over-TLS, image digest pinning
(follow-up commit after the first successful deploy), and any change to
shared shell files. The `/connect/dev` page is the only frontend file and
it is disposable by design.
