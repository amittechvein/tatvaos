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
# The small payload, made once.
DC run --rm --no-deps -T -v "$ROOT/tests/docs-render/fixtures:/fx:ro" --entrypoint node render \
  --no-warnings --import ./src/register.mjs --input-type=module -e "$MAKE" "nested-lists.json" 1 > "$TMP/nested-lists.json" 2>/dev/null
docker cp "$TMP/nested-lists.json" "$(DC ps -q apistub)":/tmp/nested-lists.json >/dev/null
POST='const [url,f]=process.argv.slice(1);fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json();console.log(r.status+" "+(b.html?"html":b.error||""))},e=>console.log("error "+e.message))'
same "the API stand-in gets a document's file back (200)" \
  "$(DC exec -T apistub node -e "$POST" http://render:8080/render/doc /tmp/nested-lists.json 2>&1 | tail -1)" "200 html"
same "the service's limit is 10 s" "$(DC exec -T apistub node -e 'fetch("http://render:8080/health").then(r=>r.json()).then(b=>console.log(b.limitMs))' 2>&1 | tail -1)" 10000

# Sheets (docs/SHEETS_SERVER_RENDER_DESIGN.md): the same container builds a
# spreadsheet's .xlsx from its stored state. The committed fixture IS the
# stored state, so the payload needs no building.
node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({updates:[f.state]}))' \
  "$ROOT/tests/sheets-render/fixtures/hindi-text.json" > "$TMP/sheet.json"
docker cp "$TMP/sheet.json" "$(DC ps -q apistub)":/tmp/sheet.json >/dev/null
SHEETPOST='const [url,f]=process.argv.slice(1);fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json();console.log(r.status+" "+(b.xlsx&&Buffer.from(b.xlsx,"base64").subarray(0,2).toString()==="PK"?"xlsx":b.error||""))},e=>console.log("error "+e.message))'
same "the API stand-in gets a spreadsheet's .xlsx back (200, a zip)" \
  "$(DC exec -T apistub node -e "$SHEETPOST" http://render:8080/render/sheet /tmp/sheet.json 2>&1 | tail -1)" "200 xlsx"
# TODAY() reads the process's zone. 2 Oct 2026 19:00 UTC is 3 Oct 00:30 in India:
# the 3rd here, the 2nd if the image fell back to UTC (no tzdata in Alpine).
# Checked by date and offset (-330 minutes = +05:30), not by the zone's NAME:
# Node's ICU data reports Asia/Kolkata by its older alias, Asia/Calcutta
# (found 3 Oct 2026 by this check's first run in CI).
same "the clock is India time (19:00 UTC on 2 Oct is the 3rd, offset +05:30)" \
  "$(DC exec -T render node -e 'const d=new Date(Date.UTC(2026,9,2,19,0));console.log(d.getDate()+" "+d.getTimezoneOffset())' 2>&1 | tr -d '\r' | tail -1)" "3 -330"
# The largest gate workbook's size, 20,000 cells, inside the limits (1 CPU, 512 MB).
# Made by the image itself, through the editor's own model.
SHEETMAKE='import * as Y from "yjs"; import { SheetsModel } from "../web/lib/sheets/model.ts"; const d = new Y.Doc(); const m = new SheetsModel(d); m.ensureSeeded(); const e = []; for (let r = 0; r < 1000; r++) { for (let c = 0; c < 19; c++) e.push({ r, c, input: String(r * 19 + c) }); e.push({ r, c: 19, input: "=SUM(A" + (r + 1) + ":S" + (r + 1) + ")" }); } m.setInputs(m.sheetIds()[0], e); process.stdout.write(JSON.stringify({ updates: [Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64")] }));'
DC run --rm --no-deps -T --entrypoint node render \
  --no-warnings --import ./src/register.mjs --input-type=module -e "$SHEETMAKE" > "$TMP/sheet-large.json" 2>/dev/null
docker cp "$TMP/sheet-large.json" "$(DC ps -q apistub)":/tmp/sheet-large.json >/dev/null
SHEETTIMED='const [url,f]=process.argv.slice(1);const b=require("fs").readFileSync(f);const t=Date.now();fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:b}).then(async r=>{await r.text();console.log(r.status+" "+(Date.now()-t))},e=>console.log("error "+e.message))'
read -r sl_status sl_ms <<<"$(DC exec -T apistub node -e "$SHEETTIMED" http://render:8080/render/sheet /tmp/sheet-large.json 2>&1 | tail -1)"
if [ "$sl_status" = 200 ] && [ -n "$sl_ms" ] && [ "$sl_ms" -lt 10000 ] 2>/dev/null; then ok "a 20,000-cell spreadsheet builds inside the limit (${sl_ms} ms)"
else bad "a 20,000-cell spreadsheet builds inside the limit" "got [${sl_status:-nothing} ${sl_ms:-}]"; fi
# The limit, enforced inside the hardened container: the SAME definition,
# with the limit lowered (it can only be lowered) so a large document outruns it.
# 250 ms: far above a small render. 40 ms (the laptop unit test's first value)
# also failed the SMALL render on one CPU in a fresh worker — a test
# tolerance, not the service.
#
# THE LARGE DOCUMENT IS SIZED ON THIS MACHINE (Mr. Singh, 1 Oct 2026). A fixed
# size measured the machine twice over: one copy of the Google Docs fixture was
# ~400 ms on a busy laptop but 130-190 ms on an idle one (the unit test then
# failed 5 runs in 5), and twenty copies — 2.5 s on that laptop — took MORE
# than the normal 10 s on CI's runner in this one-CPU container (504 at
# 10084 ms). So: 1, 2, 4 ... 64 copies, each timed through the normal service
# (10 s limit, the faster of two renders), until one takes at least TWICE the
# 250 ms test limit. That one is used. The run FAILS, saying which, if a size
# outruns even the normal limit first, or 64 copies are still too fast.
# RENDER_TEST_COPIES pins one size, only to show the failure.
TIMED='const [url,f]=process.argv.slice(1);const b=require("fs").readFileSync(f);(async()=>{let best=Infinity,st=0;for(let i=0;i<2;i++){const t=Date.now();const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:b});await r.text();st=r.status;best=Math.min(best,Date.now()-t)}console.log(st+" "+best)})().catch(e=>console.log("error "+e.message))'
BIG=""; cal_log=""
for n in ${RENDER_TEST_COPIES:-1 2 4 8 16 32 64}; do
  DC run --rm --no-deps -T -v "$ROOT/tests/docs-render/fixtures:/fx:ro" --entrypoint node render \
    --no-warnings --import ./src/register.mjs --input-type=module -e "$MAKE" "google-docs-paste.json" "$n" > "$TMP/big-$n.json" 2>/dev/null
  docker cp "$TMP/big-$n.json" "$(DC ps -q apistub)":/tmp/big-"$n".json >/dev/null
  read -r cal_status cal_ms <<<"$(DC exec -T apistub node -e "$TIMED" http://render:8080/render/doc /tmp/big-"$n".json 2>&1 | tail -1)"
  cal_log="$cal_log ${n}x=${cal_status:-none}/${cal_ms:-?}ms"
  if [ "$cal_status" != 200 ]; then
    bad "calibration: the large document could not be sized on this machine" \
        "$n copies answered ${cal_status:-nothing} under the NORMAL limit before any size took 500 ms (tried:$cal_log)"
    break
  fi
  if [ "${cal_ms:-0}" -ge 500 ] 2>/dev/null; then BIG="/tmp/big-$n.json"; break; fi
done
if [ -n "$BIG" ]; then
  ok "calibration: the large document is sized for this machine — $cal_log (needs >= 500 ms, twice the limit)"
elif [ "$cal_status" = 200 ]; then
  bad "calibration: the document is too small for this machine" \
      "no size took 500 ms (twice the 250 ms limit): $cal_log"
fi
DC run -d --no-deps --name "${P}-render-limit" -e RENDER_TIMEOUT_MS=250 -e RENDER_WORKERS=1 render >/dev/null 2>&1
for _ in $(seq 1 60); do DC exec -T apistub node -e "$WEB" "http://${P}-render-limit:8080/health" >/dev/null 2>&1 && break; sleep 1; done
if [ -n "$BIG" ]; then
  same "a render past the limit is stopped (504), in the hardened container" \
    "$(DC exec -T apistub node -e "$POST" "http://${P}-render-limit:8080/render/doc" "$BIG" 2>&1 | tail -1)" "504 render timed out"
else
  bad "a render past the limit is stopped (504), in the hardened container" "not run: no calibrated document (above)"
fi
same "…and the next render still works (the worker was replaced)" \
  "$(DC exec -T apistub node -e "$POST" "http://${P}-render-limit:8080/render/doc" /tmp/nested-lists.json 2>&1 | tail -1)" "200 html"
docker rm -f "${P}-render-limit" >/dev/null 2>&1
DC run -d --no-deps --name "${P}-render-limit" -e RENDER_TIMEOUT_MS=600000 render >/dev/null 2>&1
for _ in $(seq 1 60); do DC exec -T apistub node -e "$WEB" "http://${P}-render-limit:8080/health" >/dev/null 2>&1 && break; sleep 1; done
same "the limit cannot be RAISED past 10 s (asked for 600000)" \
  "$(DC exec -T apistub node -e "fetch('http://${P}-render-limit:8080/health').then(r=>r.json()).then(b=>console.log(b.limitMs))" 2>&1 | tail -1)" 10000

echo "== 8. a PDF whose pictures do not fit in /tmp gets a refusal a person can act on"
# docs/DOCS_PDF_DESIGN.md §10 (Mr. Singh, 7 Oct 2026): /tmp is a 16 MB tmpfs,
# the body limit 48 MB, so ONE document with enough photographs fills it.
# Before this, the write threw a plain ENOSPC and the answer was the generic
# "The PDF could not be built". Proven HERE because only this container's /tmp
# is really 16 MB. Pictures are real PNGs of random pixels, stored (deflate
# level 0) so each is ~3 MB on disk whatever compresses. 2 of them fit: that
# is the calibration — pictures as such are not refused. 7 do not.
PDFMAKE='import * as Y from "yjs"; import { getSchema } from "@tiptap/core"; import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap"; import { documentExtensions } from "../web/components/docs/schema.ts"; import zlib from "node:zlib"; import { randomBytes } from "node:crypto"; const n = Number(process.argv[1]); const side = 1000; const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); }; const png = () => { const ih = Buffer.alloc(13); ih.writeUInt32BE(side, 0); ih.writeUInt32BE(side, 4); ih[8] = 8; ih[9] = 2; const row = side * 3 + 1; const raw = Buffer.alloc(row * side); for (let y = 0; y < side; y++) randomBytes(side * 3).copy(raw, y * row + 1); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]); }; const pictures = {}; const content = [{ type: "paragraph", content: [{ type: "text", text: "Newsletter" }] }]; for (let i = 1; i <= n; i++) { const src = "/api/docs/00000000-0000-4000-8000-000000000001/images/" + i; pictures[src] = png().toString("base64"); content.push({ type: "paragraph", content: [{ type: "image", attrs: { src, alt: null, title: null, width: "320", height: null } }] }); } const s = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(getSchema(documentExtensions()), { type: "doc", content }, "default")); process.stdout.write(JSON.stringify({ updates: [Buffer.from(s).toString("base64")], pictures }));'
for n in 2 7; do
  DC run --rm --no-deps -T --entrypoint node render \
    --no-warnings --import ./src/register.mjs --input-type=module -e "$PDFMAKE" "$n" > "$TMP/pdf-$n.json" 2>/dev/null
  docker cp "$TMP/pdf-$n.json" "$(DC ps -q apistub)":/tmp/pdf-"$n".json >/dev/null
  echo "        payload with $n pictures: $(wc -c < "$TMP/pdf-$n.json") bytes"
done
PDFPOST='const [url,f]=process.argv.slice(1);fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json();console.log(r.status+" "+(b.pdf&&Buffer.from(b.pdf,"base64").subarray(0,4).toString()==="%PDF"?"pdf":(b.reason||b.error||"")))},e=>console.log("error "+e.message))'
PDFSAYS='const [url,f]=process.argv.slice(1);fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json();console.log(String(b.error))},e=>console.log("error "+e.message))'
same "2 large pictures fit: the PDF is built (200) — the calibration" \
  "$(DC exec -T apistub node -e "$PDFPOST" http://render:8080/render/pdf /tmp/pdf-2.json 2>&1 | tail -1)" "200 pdf"
same "7 do not fit in the 16 MB /tmp: refused with its own reason (413)" \
  "$(DC exec -T apistub node -e "$PDFPOST" http://render:8080/render/pdf /tmp/pdf-7.json 2>&1 | tail -1)" "413 pictures_too_large"
same "…and told what to do, in the person's words" \
  "$(DC exec -T apistub node -e "$PDFSAYS" http://render:8080/render/pdf /tmp/pdf-7.json 2>&1 | tail -1)" \
  "This document has too many pictures, or pictures too large, to make a PDF. Remove some and try again."
same "no PDF job folder is left in /tmp (the room is given back)" \
  "$(DC exec -T render sh -c 'ls -d /tmp/pdf-* 2>/dev/null | wc -l' | tr -d '\r ')" 0
# Read into a variable, then grep a here-string, never a pipe: piping long
# text into grep gave false reds AND false greens under pipefail elsewhere in
# tests/ (fixed by PRs 389 and 392 the same way).
render_log="$(DC logs --no-color render 2>&1)"
same "the log names the reason and where /tmp filled (twice: two refusals above)" \
  "$(grep -c -F -- "pdf FAILED pictures_too_large" <<<"$render_log")" 2
same "…at the picture writes, not elsewhere" \
  "$(grep -c -F -- "stage=write pictures=7" <<<"$render_log")" 2
same "a document save still works afterwards" \
  "$(DC exec -T apistub node -e "$POST" http://render:8080/render/doc /tmp/nested-lists.json 2>&1 | tail -1)" "200 html"

echo
echo "  passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
