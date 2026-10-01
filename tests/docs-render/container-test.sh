#!/usr/bin/env bash
# ============================================================================
#  The render container's hardening, PROVEN — red first on the network rule
# ============================================================================
#
#  Mr. Singh, 29-30 Sept 2026: the compose PR must show, each proven:
#    no internet (internal network only; RED FIRST: with internal: false the
#    same request SUCCEEDS), no database access, no secrets in its
#    environment, non-root, read-only filesystem, memory and CPU limits,
#    reachable only from the API, the 10-second render limit.
#
#  Runs the REAL service definition (infra/docker/docker-compose.base.yml)
#  with stand-ins around it (container-test.compose.yml). Needs a Docker
#  engine: on the laptop, the one INSIDE WSL (Amit + Mr. Singh, 30 Sept 2026 —
#  never Docker Desktop), as root:
#
#    wsl -u root -e bash tests/docs-render/container-test.sh
#
#  If the engine was not running it is STARTED here and STOPPED on the way
#  out by the trap, pass or fail — nothing is left running. In CI, where
#  Docker already runs, it is left as found.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$ROOT/infra/docker/docker-compose.base.yml"
STUBS="$ROOT/tests/docs-render/container-test.compose.yml"
EGRESS_RED="$ROOT/tests/docs-render/container-test.egress-red.yml"
P=rendertest
TMP="$(mktemp -d)"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1${2:+ — $2}"; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

# The base file refuses to be read without its required settings (${X:?}).
# Placeholders, so compose can READ it: none of them reaches the render
# service, whose environment is checked below to hold no secret at all.
for v in $(grep -oE '\$\{[A-Z0-9_]+:\?' "$BASE" | sed -E 's/\$\{([A-Z0-9_]+):\?/\1/' | sort -u); do
  export "$v=placeholder-for-render-test"
done
# Optional settings get one too, only so compose stops warning about them in
# this log (a warning line once swallowed the red-first result).
for v in $(grep -oE '\$\{[A-Z0-9_]+' "$BASE" | sed -E 's/\$\{//' | sort -u); do
  [ -n "${!v:-}" ] || export "$v=placeholder-for-render-test"
done

STARTED=0
if ! docker info >/dev/null 2>&1; then
  { systemctl start docker 2>/dev/null || service docker start; } >/dev/null 2>&1
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { echo "the Docker engine did not start"; exit 2; }
  STARTED=1
fi
# NOT DOCKER DESKTOP (Amit + Mr. Singh, 30 Sept 2026: the Docker ENGINE from
# Ubuntu's packages inside WSL; Docker Desktop is banned on the laptop). With
# Docker Desktop running, its WSL integration answers on the same
# /var/run/docker.sock, `docker info` succeeds, this script starts nothing —
# and the whole run happens on Docker Desktop without a word (1 Oct 2026: a
# 35/0 run that was on Docker Desktop, started by someone else). Refuse, and
# say so; stopping Docker Desktop is its owner's call, not this script's.
DAEMON_OS="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)"
case "$DAEMON_OS" in
  *"Docker Desktop"*)
    echo "REFUSED: the daemon answering is Docker Desktop ('$DAEMON_OS'), not the Docker engine in WSL."
    echo "  Docker Desktop is not used for this test. Ask whoever started it to stop it, then re-run."
    # Before the trap is set: stop the engine here if this run started it.
    [ "$STARTED" = 1 ] && { systemctl stop docker.service docker.socket 2>/dev/null || service docker stop; } >/dev/null 2>&1
    rm -rf "$TMP"
    exit 2 ;;
esac
echo "  (daemon: $DAEMON_OS)"
DC()    { docker compose -p "$P" -f "$BASE" -f "$STUBS" "$@"; }
DCRED() { docker compose -p "${P}red" -f "$BASE" -f "$STUBS" -f "$EGRESS_RED" "$@"; }
cleanup() {
  DC down -v --remove-orphans >/dev/null 2>&1
  DCRED down -v --remove-orphans >/dev/null 2>&1
  docker rm -f "${P}-render-limit" >/dev/null 2>&1
  if [ "$STARTED" = 1 ]; then
    { systemctl stop docker.service docker.socket 2>/dev/null || service docker stop; } >/dev/null 2>&1
    echo "  (the Docker engine was started for this run and is stopped again: $(pgrep -x dockerd >/dev/null && echo STILL RUNNING || echo stopped))"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# From inside a container: can it reach host:port? Prints "open" or the error.
TCP='const [h,p]=process.argv.slice(1);const s=require("net").connect({host:h,port:+p,timeout:4000});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("timeout");process.exit(1)});s.on("error",e=>{console.log(e.code||e.message);process.exit(1)})'
WEB='fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>{console.log("reached "+r.status);process.exit(0)},e=>{console.log("refused "+(e.cause?.code||e.name));process.exit(1)})'

echo "== the base image is pinned by digest (Mr. Singh, 1 Oct 2026)"
# Every FROM names an image@sha256:<64 hex>, and all name the same one. Shown
# to fail first on a copy with one stage back on the moving tag, so the check
# can see an unpinned line at all.
DOCKERFILE="$ROOT/apps/render/Dockerfile"
pinned() {
  local froms digests
  froms=$(grep -E '^FROM ' "$1")
  [ -n "$froms" ] || return 1
  echo "$froms" | grep -vqE '^FROM [^ ]+@sha256:[0-9a-f]{64}( |$)' && return 1
  digests=$(echo "$froms" | grep -oE 'sha256:[0-9a-f]{64}' | sort -u | wc -l)
  [ "$digests" = 1 ]
}
sed '0,/@sha256:[0-9a-f]\{64\}/s///' "$DOCKERFILE" > "$TMP/Dockerfile.unpinned"
if cmp -s "$DOCKERFILE" "$TMP/Dockerfile.unpinned"; then bad "red first: the unpinning plant changed nothing"
elif pinned "$TMP/Dockerfile.unpinned"; then bad "red first: a stage on the moving tag was NOT caught"
else ok "red first: a stage back on the moving tag is caught"; fi
# The second stage on a DIFFERENT digest (its first hex digit changed).
awk '/^FROM /{n++; if (n==2 && match($0,/sha256:./)) { c=substr($0,RSTART+7,1); $0=substr($0,1,RSTART+6) (c=="0"?"1":"0") substr($0,RSTART+8) }} {print}' \
  "$DOCKERFILE" > "$TMP/Dockerfile.split"
if cmp -s "$DOCKERFILE" "$TMP/Dockerfile.split"; then bad "red first: the split-digest plant changed nothing"
elif pinned "$TMP/Dockerfile.split"; then bad "red first: two stages on different digests were NOT caught"
else ok "red first: two stages on different digests are caught"; fi
if pinned "$DOCKERFILE"; then ok "both stages name one base image by digest"
else bad "a FROM line is not pinned by digest, or the stages differ"; grep -E '^FROM ' "$DOCKERFILE"; fi

echo "== build the image (dependencies from the lockfile, at build time)"
if DC build render >"$TMP/build.log" 2>&1; then ok "the image builds from the lockfile (frozen install)"
else bad "the image did not build"; tail -15 "$TMP/build.log"; exit 1; fi

echo "== RED FIRST: the same service with its network NOT internal"
DCRED up -d render >/dev/null 2>&1
sleep 3
red=$(DCRED exec -T render node -e "$WEB" https://example.com 2>&1 | tail -1)
case "$red" in reached*) ok "with internal: false the render container DOES reach the internet ($red) — the check can see it";;
  *) bad "red first failed: even with internal: false the internet was not reached ($red) — the egress check would prove nothing";; esac
DCRED down -v --remove-orphans >/dev/null 2>&1

echo "== the real definition"
DC up -d render apistub outsider dbstub >/dev/null 2>&1
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(DC ps -q render)" 2>/dev/null)" = healthy ] && break; sleep 1
done
same "the render service is up and healthy" "$(docker inspect -f '{{.State.Health.Status}}' "$(DC ps -q render)" 2>/dev/null)" healthy
R="$(DC ps -q render)"

echo "== 1. no internet"
got=$(DC exec -T render node -e "$WEB" https://example.com 2>&1 | tail -1)
case "$got" in refused*) ok "the render container cannot reach the internet by name ($got)";; *) bad "it reached the internet" "$got";; esac
got=$(DC exec -T render node -e "$TCP" 1.1.1.1 443 2>&1 | tail -1)
[ "$got" != open ] && ok "…nor by address (1.1.1.1:443: $got)" || bad "it reached 1.1.1.1:443 directly"

echo "== 2. no database"
same "control: the database stand-in answers on mailnet (from the API stand-in)" "$(DC exec -T apistub node -e "$TCP" dbstub 5432 2>&1 | tail -1)" open
got=$(DC exec -T render node -e "$TCP" dbstub 5432 2>&1 | tail -1)
[ "$got" != open ] && ok "the render container cannot reach it ($got)" || bad "the render container reached the database stand-in"
got=$(DC exec -T render node -e "$TCP" postgres 5432 2>&1 | tail -1)
[ "$got" != open ] && ok "…nor anything called postgres ($got)" || bad "the render container reached postgres:5432"

echo "== 3. reachable only from the API"
same "the API stand-in reaches it (GET /health)" "$(DC exec -T apistub node -e "$WEB" http://render:8080/health 2>&1 | tail -1)" "reached 200"
got=$(DC exec -T outsider node -e "$WEB" http://render:8080/health 2>&1 | tail -1)
case "$got" in reached*) bad "a container on mailnet (Caddy, web, mail) reached it" "$got";; *) ok "a container that is not the API cannot reach it ($got)";; esac
same "no port is published on the host" "$(docker port "$R" 2>/dev/null | wc -l)" 0
same "its only network is rendernet" "$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$R" | xargs)" "${P}_rendernet"
same "rendernet is internal" "$(docker network inspect -f '{{.Internal}}' "${P}_rendernet")" true

echo "== 4. no secrets, no mounts"
names=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$R" | sed 's/=.*//' | grep -v '^$' | sort | xargs)
echo "        environment names: $names"
bad_names=$(echo "$names" | tr ' ' '\n' | grep -iE 'KEY|SECRET|PASS|TOKEN|CONNECTION|JWT|DKIM|SALT|CREDENTIAL' | xargs)
[ -z "$bad_names" ] && ok "no secret in its environment (names above; values never printed)" || bad "secret-like names in its environment" "$bad_names"
same "no volumes or bind mounts (only the /tmp tmpfs)" "$(docker inspect -f '{{len .Mounts}}' "$R")" 0
same "no Docker socket" "$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$R" | grep -c docker.sock)" 0

echo "== 5. non-root, read-only, no privileges"
same "runs as a non-root user" "$(DC exec -T render id -u 2>&1 | tr -d '\r')" 1000
same "the root filesystem is read-only (writing its own code fails)" \
  "$(DC exec -T render sh -c 'touch /app/apps/render/src/x 2>/dev/null && echo written || echo refused' | tr -d '\r')" refused
same "…and / too" "$(DC exec -T render sh -c 'touch /x 2>/dev/null && echo written || echo refused' | tr -d '\r')" refused
same "only /tmp is writable (a small tmpfs)" "$(DC exec -T render sh -c 'touch /tmp/x && echo written' | tr -d '\r')" written
same "the filesystem is marked read-only" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$R")" true
same "every capability dropped" "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$R")" '["ALL"]'
same "none added back" "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$R")" null
case "$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$R")" in *no-new-privileges:true*) ok "no privilege escalation (no-new-privileges)";; *) bad "no-new-privileges is not set";; esac

echo "== 6. memory, CPU and process limits"
same "memory limit 512 MB" "$(docker inspect -f '{{.HostConfig.Memory}}' "$R")" 536870912
same "CPU limit 1" "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$R")" 1000000000
same "process limit 64" "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$R")" 64

echo "== 7. it renders, and the 10-second limit holds"
# The payloads are made by the image itself, from the committed fixtures.
MAKE='import * as Y from "yjs"; import { getSchema } from "@tiptap/core"; import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap"; import { documentExtensions } from "../web/components/docs/schema.ts"; import { readFileSync } from "node:fs"; const j0 = JSON.parse(readFileSync("/fx/" + process.argv[1], "utf8")); const n = Number(process.argv[2] || 1); const j = { ...j0, content: Array.from({ length: n }, () => j0.content).flat() }; const s = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(getSchema(documentExtensions()), j, "default")); process.stdout.write(JSON.stringify({ updates: [Buffer.from(s).toString("base64")] }));'
# "big" = the Google Docs fixture twenty times over: the render must be far
# past the lowered limit on ANY machine. One copy took ~400 ms on a busy laptop
# (30 Sept) but 130-190 ms on an idle one (1 Oct), and the unit test with the
# same document then failed 5 runs in 5. Twenty copies: ~2.5 s on that laptop.
for spec in nested-lists:nested-lists:1 google-docs-paste:big:20; do
  IFS=: read -r f out n <<<"$spec"
  DC run --rm --no-deps -T -v "$ROOT/tests/docs-render/fixtures:/fx:ro" --entrypoint node render \
    --no-warnings --import ./src/register.mjs --input-type=module -e "$MAKE" "$f.json" "$n" > "$TMP/$out.json" 2>/dev/null
  docker cp "$TMP/$out.json" "$(DC ps -q apistub)":/tmp/"$out".json >/dev/null
done
POST='const [url,f]=process.argv.slice(1);fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json();console.log(r.status+" "+(b.html?"html":b.error||""))},e=>console.log("error "+e.message))'
same "the API stand-in gets a document's file back (200)" \
  "$(DC exec -T apistub node -e "$POST" http://render:8080/render/doc /tmp/nested-lists.json 2>&1 | tail -1)" "200 html"
same "the service's limit is 10 s" "$(DC exec -T apistub node -e 'fetch("http://render:8080/health").then(r=>r.json()).then(b=>console.log(b.limitMs))' 2>&1 | tail -1)" 10000
# The limit, enforced inside the hardened container: the SAME definition,
# with the limit lowered (it can only be lowered) so a large document outruns it.
# 250 ms: far below "big" (twenty copies of the large fixture), far above a
# small one. 40 ms (the laptop unit test's first value) also failed the SMALL
# render on one CPU in a fresh worker — a test tolerance, not the service.
DC run -d --no-deps --name "${P}-render-limit" -e RENDER_TIMEOUT_MS=250 -e RENDER_WORKERS=1 render >/dev/null 2>&1
for _ in $(seq 1 60); do DC exec -T apistub node -e "$WEB" "http://${P}-render-limit:8080/health" >/dev/null 2>&1 && break; sleep 1; done
same "a render past the limit is stopped (504), in the hardened container" \
  "$(DC exec -T apistub node -e "$POST" "http://${P}-render-limit:8080/render/doc" /tmp/big.json 2>&1 | tail -1)" "504 render timed out"
same "…and the next render still works (the worker was replaced)" \
  "$(DC exec -T apistub node -e "$POST" "http://${P}-render-limit:8080/render/doc" /tmp/nested-lists.json 2>&1 | tail -1)" "200 html"
docker rm -f "${P}-render-limit" >/dev/null 2>&1
DC run -d --no-deps --name "${P}-render-limit" -e RENDER_TIMEOUT_MS=600000 render >/dev/null 2>&1
for _ in $(seq 1 60); do DC exec -T apistub node -e "$WEB" "http://${P}-render-limit:8080/health" >/dev/null 2>&1 && break; sleep 1; done
same "the limit cannot be RAISED past 10 s (asked for 600000)" \
  "$(DC exec -T apistub node -e "fetch('http://${P}-render-limit:8080/health').then(r=>r.json()).then(b=>console.log(b.limitMs))" 2>&1 | tail -1)" 10000

echo
echo "  passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
