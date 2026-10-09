#!/usr/bin/env bash
# ============================================================================
#  /render/pdf switch-on measurements, in the HARDENED container
#  (docs/DOCS_PDF_DESIGN.md §10). Case 0 only, as the design orders it:
#
#    0. ONE PDF request with many pictures. Real-sized photographs: how many
#       before /tmp is full, the peak memory, and what the request is told.
#       "If one request can do it, the concurrent numbers measure the wrong
#       thing first."
#
#  Measured, not reasoned: every number below is READ from the container's
#  own cgroup on the host (memory.peak, pids.peak, memory.events) and from
#  its /tmp through /proc/<pid>/root, never from inside it, so measuring
#  adds no process and no file to what is measured. The container is
#  restarted before every case so each peak is that case's alone; the first
#  reading after the restart is printed, so a peak that did NOT reset shows.
#
#  Photos: Docs stores pictures up to 5 MB each with no pixel limit
#  (DocsEndpoints.MaxImageBytes), so the realistic worst case is a phone
#  photo: a 12-megapixel JPEG of 4-5 MB. The render image cannot make one,
#  so they are made outside and passed in as a folder of photo-N.jpg.
#
#  Same engine rules as container-test.sh: the Docker ENGINE inside WSL,
#  never Docker Desktop (refused); started here if it was not running and
#  stopped again on the way out. Run from the repository root:
#
#    wsl -u root -e bash tests/docs-render/measure-pdf.sh <photos-dir> [first-n | concurrent]
#
#  Exit 0 = measured (whatever the numbers); 1 = could not measure; 2 = refused.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$ROOT/infra/docker/docker-compose.base.yml"
STUBS="$ROOT/tests/docs-render/container-test.compose.yml"
P=renderprobe
TMP="$(mktemp -d)"
PHOTOS="${1:-}"
# Second argument: a number = case 0 from that n (a re-run of the cases a
# stopped run missed); "concurrent" = cases 2 and 3 (several PDFs at once,
# and a Docs save sent while they run). Default: case 0 from n = 1.
MODE="${2:-1}"
case "$MODE" in
  concurrent) FROM_N=1 ;;
  *[!0-9]*|'') echo "second argument: a number (case 0 from n) or 'concurrent'"; exit 1 ;;
  *) FROM_N="$MODE"; MODE=case0 ;;
esac
[ -n "$PHOTOS" ] && [ -f "$PHOTOS/photo-1.jpg" ] || { echo "usage: measure-pdf.sh <dir holding photo-1.jpg ... photo-N.jpg>"; exit 1; }
NPHOTOS=$(ls "$PHOTOS"/photo-*.jpg | wc -l)

# The base file refuses to be read without its required settings; placeholders
# only (container-test.sh proves none reaches the render service).
for v in $(grep -oE '\$\{[A-Z0-9_]+' "$BASE" | sed -E 's/\$\{//' | sort -u); do
  [ -n "${!v:-}" ] || export "$v=placeholder-for-render-test"
done

STARTED=0
if ! docker info >/dev/null 2>&1; then
  { systemctl start docker 2>/dev/null || service docker start; } >/dev/null 2>&1
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { echo "the Docker engine did not start"; exit 1; }
  STARTED=1
fi
DAEMON_OS="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)"
case "$DAEMON_OS" in
  *"Docker Desktop"*)
    echo "REFUSED: the daemon answering is Docker Desktop ('$DAEMON_OS'), not the Docker engine in WSL."
    [ "$STARTED" = 1 ] && { systemctl stop docker.service docker.socket 2>/dev/null || service docker stop; } >/dev/null 2>&1
    rm -rf "$TMP"; exit 2 ;;
esac
echo "  (daemon: $DAEMON_OS; kernel $(uname -r))"
DC() { docker compose -p "$P" -f "$BASE" -f "$STUBS" "$@"; }
cleanup() {
  rm -f "$TMP/sampling"
  DC down -v --remove-orphans >/dev/null 2>&1
  if [ "$STARTED" = 1 ]; then
    { systemctl stop docker.service docker.socket 2>/dev/null || service docker stop; } >/dev/null 2>&1
    echo "  (the Docker engine was started for this run and is stopped again: $(pgrep -x dockerd >/dev/null && echo STILL RUNNING || echo stopped))"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== build the image and start it with its production limits"
DC build render >"$TMP/build.log" 2>&1 || { echo "the image did not build"; tail -15 "$TMP/build.log"; exit 1; }
DC up -d render apistub >/dev/null 2>&1

healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(DC ps -q render)" 2>/dev/null)" = healthy ] && return 0; sleep 1
  done; return 1
}
cgroup_of() {
  local id; id=$(docker inspect -f '{{.Id}}' "$1")
  for c in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
    [ -d "$c" ] && { echo "$c"; return 0; }
  done; return 1
}
healthy || { echo "the render service never became healthy"; exit 1; }
R="$(DC ps -q render)"
CG="$(cgroup_of "$R")" || { echo "cannot find the container's cgroup on the host"; exit 1; }
for f in memory.peak pids.peak memory.events memory.max pids.max; do
  [ -r "$CG/$f" ] || { echo "the cgroup has no $f (kernel too old?) - cannot measure"; exit 1; }
done
echo "        limits read from the cgroup: memory.max=$(cat "$CG/memory.max") pids.max=$(cat "$CG/pids.max")"
echo "        /tmp: $(docker exec "$R" df -k /tmp | tail -1 | awk '{print $2" KB total"}')"

# ---- payloads: n photos in one document, made by the image from the editor's own schema
MAKE='import * as Y from "yjs"; import { getSchema } from "@tiptap/core"; import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap"; import { documentExtensions } from "../web/components/docs/schema.ts"; import { readFileSync } from "node:fs"; const n = Number(process.argv[1]); const pictures = {}; const content = [{ type: "paragraph", content: [{ type: "text", text: "School newsletter" }] }]; for (let i = 1; i <= n; i++) { const src = "/api/docs/00000000-0000-4000-8000-000000000001/images/" + i; pictures[src] = readFileSync("/ph/photo-" + i + ".jpg").toString("base64"); content.push({ type: "paragraph", content: [{ type: "image", attrs: { src, alt: null, title: null, width: "600", height: null } }] }); content.push({ type: "paragraph", content: [{ type: "text", text: "Caption for photograph " + i }] }); } const s = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(getSchema(documentExtensions()), { type: "doc", content }, "default")); process.stdout.write(JSON.stringify({ updates: [Buffer.from(s).toString("base64")], pictures }));'
ANSWER='const [url,f]=process.argv.slice(1);const t=Date.now();fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync(f)}).then(async r=>{const b=await r.json().catch(()=>({}));const pdf=b.pdf?Buffer.from(b.pdf,"base64"):null;console.log([r.status,b.reason||(pdf&&pdf.subarray(0,4).toString()==="%PDF"?"pdf":b.error||"-"),Date.now()-t,pdf?pdf.length:0].join(" "))},e=>console.log(["error",e.cause?.code||e.message,Date.now()-t,0].join(" ")))'

# A document save, the thing that must survive whatever a PDF does.
DOCMAKE='import * as Y from "yjs"; import { getSchema } from "@tiptap/core"; import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap"; import { documentExtensions } from "../web/components/docs/schema.ts"; import { readFileSync } from "node:fs"; const j = JSON.parse(readFileSync("/fx/nested-lists.json", "utf8")); process.stdout.write(JSON.stringify({ updates: [Buffer.from(Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(getSchema(documentExtensions()), j, "default"))).toString("base64")] }));'
DC run --rm --no-deps -T -v "$ROOT/tests/docs-render/fixtures:/fx:ro" --entrypoint node render \
  --no-warnings --import ./src/register.mjs --input-type=module -e "$DOCMAKE" > "$TMP/save.json" 2>/dev/null
docker cp "$TMP/save.json" "$(DC ps -q apistub)":/tmp/save.json >/dev/null
SAVE='fetch("http://render:8080/render/doc",{method:"POST",headers:{"content-type":"application/json"},body:require("fs").readFileSync("/tmp/save.json")}).then(r=>console.log(r.status),e=>console.log("error "+(e.cause?.code||e.message)))'

fresh() {
  DC restart render >/dev/null 2>&1
  healthy || { echo "the render service did not come back"; exit 1; }
  R="$(DC ps -q render)"; CG="$(cgroup_of "$R")"; PID="$(docker inspect -f '{{.State.Pid}}' "$R")"
  START="$(docker inspect -f '{{.State.StartedAt}}' "$R")"
}
# /tmp's high-water mark, read from the host every 50 ms while a case runs.
sample_tmp() {
  local max=0 v
  while [ -f "$TMP/sampling" ]; do
    v=$(du -sk "/proc/$PID/root/tmp" 2>/dev/null | cut -f1)
    [ "${v:-0}" -gt "$max" ] && { max=$v; echo "$max" > "$TMP/tmpmax"; }
    sleep 0.05
  done
}
kb2mb() { awk -v k="$1" 'BEGIN{printf "%.1f", k/1024}'; }
b2mb()  { awk -v b="$1" 'BEGIN{printf "%.1f", b/1048576}'; }

if [ "$MODE" = case0 ]; then
echo
echo "== case 0: ONE PDF request with n phone photos (4000x3000 JPEG, $(b2mb "$(stat -c %s "$PHOTOS/photo-1.jpg")") MB each)"
printf '  %-3s %-9s %-7s %-20s %-7s %-9s %-9s %-6s %-9s %-4s %-9s %-7s %s\n' \
  n body_MB status answer ms pdf_MB mem_peak pids tmp_peak oom restarted save log
for n in $(seq "$FROM_N" "$NPHOTOS"); do
  DC run --rm --no-deps -T -v "$PHOTOS:/ph:ro" --entrypoint node render \
    --no-warnings --import ./src/register.mjs --input-type=module -e "$MAKE" "$n" > "$TMP/case0-$n.json" 2>/dev/null
  body=$(stat -c %s "$TMP/case0-$n.json")
  docker cp "$TMP/case0-$n.json" "$(DC ps -q apistub)":/tmp/case0.json >/dev/null
  fresh
  base_mem=$(cat "$CG/memory.peak"); base_pids=$(cat "$CG/pids.peak")
  echo 0 > "$TMP/tmpmax"; touch "$TMP/sampling"; sample_tmp & sampler=$!
  read -r status answer ms pdfbytes <<<"$(DC exec -T apistub node -e "$ANSWER" http://render:8080/render/pdf /tmp/case0.json 2>&1 | tail -1)"
  rm -f "$TMP/sampling"; wait "$sampler" 2>/dev/null
  R2="$(DC ps -q render)"
  restarted=no; [ "$(docker inspect -f '{{.State.StartedAt}}' "$R2")" != "$START" ] && restarted=YES
  oom=$(awk '$1=="oom_kill"{print $2}' "$CG/memory.events" 2>/dev/null)
  [ "$(docker inspect -f '{{.State.OOMKilled}}' "$R2")" = true ] && oom="${oom:-?}+CONTAINER"
  mem=$(cat "$CG/memory.peak" 2>/dev/null || echo 0); pids=$(cat "$CG/pids.peak" 2>/dev/null || echo 0)
  save=$(DC exec -T apistub node -e "$SAVE" 2>&1 | tail -1)
  line=$(DC logs --no-color --since "$START" render 2>&1 | grep -E 'pdf (200|FAILED|4|5)' | tail -1 | sed -E 's/^[^|]*\| *//' | cut -c1-110)
  printf '  %-3s %-9s %-7s %-20s %-7s %-9s %-9s %-6s %-9s %-4s %-9s %-7s %s\n' \
    "$n" "$(b2mb "$body")" "$status" "$answer" "$ms" "$(b2mb "${pdfbytes:-0}")" "$(b2mb "$mem")" "$pids" "$(kb2mb "$(cat "$TMP/tmpmax")")" "${oom:-?}" "$restarted" "$save" "$line"
  echo "      (after the restart, before the request: mem_peak $(b2mb "$base_mem") MB, pids $base_pids)"
done

fi

if [ "$MODE" = concurrent ]; then
# ---------------------------------------------------------------------------
#  Cases 2 and 3 (docs/DOCS_PDF_DESIGN.md §10): k PDFs at once, k = 2, 5, 10,
#  and a Docs save sent 300 ms into them. Two kinds of request, because case
#  0 showed only a ONE-photo PDF reaches Typst today:
#    1-photo   reaches Typst: k Typst processes at once (memory, processes,
#              /tmp shared between them)
#    8-photo   the largest body the service accepts (46.9 MB): memory, the
#              exposure case 0 pointed at (384 MB for ONE of them)
#  pids.peak cannot be used (start-up already sets it; case 0's correction),
#  so pids.current and memory.current are SAMPLED every 10 ms from the host,
#  and the sampler is calibrated first on processes started on purpose.
#  memory.peak (kernel-kept, resets with the restart) is the memory number.
#  After each case: the server's thread count at rest against before (a
#  killed worker that was never replaced would leave it lower) and any
#  "worker error" line in the log.
# ---------------------------------------------------------------------------
watch_start() {
  rm -f "$TMP/maxes"; touch "$TMP/sampling"
  ( pm=0; mm=0
    while [ -f "$TMP/sampling" ]; do
      read -r p < "$CG/pids.current" 2>/dev/null || break
      read -r m < "$CG/memory.current" 2>/dev/null || break
      c=0; [ "$p" -gt "$pm" ] && { pm=$p; c=1; }; [ "$m" -gt "$mm" ] && { mm=$m; c=1; }
      [ "$c" = 1 ] && echo "$pm $mm" > "$TMP/maxes"
      sleep 0.01
    done ) & SAMPLER=$!
}
watch_stop() { rm -f "$TMP/sampling"; wait "$SAMPLER" 2>/dev/null; read -r PMAX MMAX < "$TMP/maxes" 2>/dev/null || { PMAX='?'; MMAX=0; }; }
threads() { awk '/^Threads:/{print $2}' "/proc/$PID/status" 2>/dev/null || echo '?'; }

echo
echo "== calibration: does the sampler see processes started on purpose?"
fresh; sleep 2
base=$(cat "$CG/pids.current")
watch_start
docker exec "$R" sh -c 'for i in 1 2 3 4 5 6 7 8; do sleep 2 & done; wait'
watch_stop
echo "        at rest: $base; with 8 sleeps started inside: sampled max $PMAX (expect at least $((base + 9)): 8 sleeps + their shell)"
[ "$PMAX" != '?' ] && [ "$PMAX" -ge $((base + 9)) ] || { echo "the sampler did not see them - the process numbers below would mean nothing"; exit 1; }

for n in 1 8; do
  DC run --rm --no-deps -T -v "$PHOTOS:/ph:ro" --entrypoint node render \
    --no-warnings --import ./src/register.mjs --input-type=module -e "$MAKE" "$n" > "$TMP/conc-$n.json" 2>/dev/null
  docker cp "$TMP/conc-$n.json" "$(DC ps -q apistub)":/tmp/conc-"$n".json >/dev/null
done
# k requests at once, the SAME body; a Docs save at +300 ms; one JSON line back.
BURST='const [url,f,k,at]=process.argv.slice(1);const body=require("fs").readFileSync(f);const t0=Date.now();const J={"content-type":"application/json"};const one=()=>{const t=Date.now();return fetch(url,{method:"POST",headers:J,body}).then(async r=>{const b=await r.json().catch(()=>({}));return{s:r.status,why:b.reason||(b.pdf?"pdf":b.error||"-"),ms:Date.now()-t}},e=>({s:"error",why:e.cause?.code||e.message,ms:Date.now()-t}))};const save=new Promise(r=>setTimeout(r,+at)).then(()=>{const t=Date.now();return fetch("http://render:8080/render/doc",{method:"POST",headers:J,body:require("fs").readFileSync("/tmp/save.json")}).then(r=>({s:r.status,ms:Date.now()-t}),e=>({s:"error "+(e.cause?.code||e.message),ms:Date.now()-t}))});Promise.all([Promise.all(Array.from({length:+k},one)),save]).then(([rs,sv])=>{const c={};for(const r of rs){const key=r.s+" "+r.why;c[key]=(c[key]||0)+1}console.log(JSON.stringify({answers:c,slowest_ms:Math.max(...rs.map(r=>r.ms)),save_during:sv,wall_ms:Date.now()-t0}))})'

echo
echo "== cases 2 and 3: k PDF requests at once, and a Docs save sent 300 ms into them"
for kind in 1 8; do
  for k in 2 5 10; do
    fresh
    # Warm: one 1-photo PDF first, so lazily started threads (libuv's pool) are
    # in the at-rest count on both sides of the case.
    DC exec -T apistub node -e "$ANSWER" http://render:8080/render/pdf /tmp/conc-1.json >/dev/null 2>&1
    sleep 2; t_before=$(threads); p_rest=$(cat "$CG/pids.current")
    watch_start
    out=$(DC exec -T apistub node -e "$BURST" http://render:8080/render/pdf /tmp/conc-"$kind".json "$k" 300 2>&1 | tail -1)
    watch_stop
    R2="$(DC ps -q render)"
    restarted=no; [ "$(docker inspect -f '{{.State.StartedAt}}' "$R2")" != "$START" ] && restarted=YES
    oom=$(awk '$1=="oom_kill"{print $2}' "$CG/memory.events" 2>/dev/null)
    [ "$(docker inspect -f '{{.State.OOMKilled}}' "$R2")" = true ] && oom="${oom:-?}+CONTAINER"
    mem=$(cat "$CG/memory.peak" 2>/dev/null || echo 0)
    sleep 3; t_after=$(threads)
    werr=$(DC logs --no-color --since "$START" render 2>&1 | grep -c -F -- "worker error")
    after=$(DC exec -T apistub node -e "$SAVE" 2>&1 | tail -1)
    echo "  ${kind}-photo x $k: mem_peak $(b2mb "$mem") MB, pids at rest $p_rest -> sampled max ${PMAX}, oom ${oom:-?}, restarted $restarted"
    echo "      answers+timing: $out"
    echo "      threads at rest $t_before -> $t_after, worker errors $werr, a save afterwards: $after"
  done
done
fi

echo
echo "  measured; numbers are the container's own (cgroup memory.peak; case 0 pids = start-up peak, see §10; concurrent pids sampled every 10 ms)"
