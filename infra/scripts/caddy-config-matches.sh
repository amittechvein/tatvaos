#!/usr/bin/env bash
#
# Is the Caddy that is RUNNING carrying the config that is ON DISK?
#
#   caddy-config-matches.sh '<command that prints the on-disk config as JSON>' \
#                           '<command that prints the running config as JSON>'
#
# The first command is normally `caddy adapt` in a FRESH container that
# mounts the current files; the second is the admin API of the running one
# (`wget -qO- http://localhost:2019/config/` inside it). Both documents are
# parsed, key-sorted and hashed, so ordering and whitespace do not matter and
# nothing large is printed. Exit 0 when they match, 1 when they differ, 2 when
# either could not be read or parsed.
#
# WHY THIS EXISTS — 17 Sept 2026. The Caddyfile was bind-mounted as a single
# file. `git reset --hard` in deploy.sh replaced that file with a new inode;
# the running container kept the old inode; `caddy reload` re-read the OLD
# content and Caddy logged "config is unchanged"; deploy.sh printed
# "[ok] caddy reloaded" over the top of it. The new /.well-known/ route never
# appeared and discovery answered the web app's 404 until the container was
# recreated by hand.
#
# WHY THE RUNNING CONFIG AND NOT THE FILE IN THE CONTAINER: a hash of
# /etc/caddy/Caddyfile inside the container catches that bug, but a config
# that was read and NOT applied — a reload that failed half-way, an admin
# endpoint that answered and did nothing — would still slip through. The
# admin API returns what Caddy is actually serving with. (CTO, 17 Sept 2026.)
#
# WHAT THIS DOES NOT PROVE: that the on-disk Caddyfile is the one you meant to
# deploy. It answers "is Caddy running what is on disk", nothing more.
# ---------------------------------------------------------------------------
set -uo pipefail

[ $# -eq 2 ] || { echo "usage: $0 '<adapt command>' '<running-config command>'" >&2; exit 2; }
PY="${TATVAOS_PYTHON:-python3}"

# A tiny Python normaliser: the same document with keys in any order and any
# whitespace hashes the same; a document that is not JSON fails loudly rather
# than hashing to something that will never match.
digest() {
    "$PY" -c '
import sys, json, hashlib
raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except Exception as e:
    sys.stderr.write("not JSON (%s): %r\n" % (e, raw[:120]))
    sys.exit(2)
canon = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
print(hashlib.sha256(canon).hexdigest()[:16])
'
}

err=$(mktemp)
on_disk=$(eval "$1" 2>"$err" | digest 2>>"$err"); rc1=${PIPESTATUS[0]}
if [ -z "$on_disk" ]; then
    echo "could not adapt the on-disk config (exit $rc1):"; sed 's/^/   /' "$err"; rm -f "$err"; exit 2
fi
: >"$err"
running=$(eval "$2" 2>"$err" | digest 2>>"$err"); rc2=${PIPESTATUS[0]}
if [ -z "$running" ]; then
    echo "could not read the running config from Caddy's admin endpoint (exit $rc2):"; sed 's/^/   /' "$err"; rm -f "$err"; exit 2
fi
rm -f "$err"

if [ "$on_disk" = "$running" ]; then
    echo "running config $running = on-disk config $on_disk"
    exit 0
fi
echo "running config $running DIFFERS from on-disk config $on_disk — Caddy is not serving the files on disk"
exit 1
