#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  connect-pip-test.sh — the Picture-in-Picture grid, tested.
#
#  The floating window builds its DOM by hand, because React's event system
#  does not survive being re-parented into another window. Hand-built DOM
#  means hand-written reconciliation, and that is where two invisible bugs
#  live: rebuilding the grid (every video restarts — a flicker here, a stall
#  on a bad connection) and dropping a tile without detaching its track (the
#  SDK keeps decoding video nobody can see).
#
#  Neither shows up on a fast machine. tests/connect-pip compiles the REAL
#  lib/pip.ts and drives it against a fake DOM, asserting the order of
#  attach/detach calls and the set of tracks still held.
#
#      bash infra/scripts/connect-pip-test.sh
#
#  Needs node and the web app's own TypeScript — so, the build machine. On
#  Windows the two commands at the bottom of this file work as they are.
#
#  Exit 0 = every assertion held.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$root/tests/connect-pip"
src="$root/apps/web/lib/pip.ts"
out="$test_dir/build"

[[ -f "$src" ]]              || { echo "  lib/pip.ts is not at $src" >&2; exit 2; }
[[ -f "$test_dir/run.mjs" ]] || { echo "  the test is not at $test_dir" >&2; exit 2; }

command -v node >/dev/null 2>&1 || { echo "  node is not on this machine — run this on your build machine" >&2; exit 2; }

tsc="$root/apps/web/node_modules/.bin/tsc"
if [[ ! -x "$tsc" ]]; then
    echo "  TypeScript is not installed. Run 'npm install' in apps/web first." >&2
    exit 2
fi

rm -rf "$out"

# Compiled OUT OF the app's tsconfig on purpose: this is one self-contained
# file with no imports, and pulling in the Next.js config would drag in path
# aliases and JSX settings that have nothing to do with it.
#
#   Equivalent on Windows, from apps/web:
#     node_modules\.bin\tsc lib\pip.ts --outDir ..\..\tests\connect-pip\build ^
#          --target es2022 --module es2022 --moduleResolution bundler ^
#          --lib es2022,dom --strict --skipLibCheck
#     node ..\..\tests\connect-pip\run.mjs
tmp="$(mktemp -d)"
cp "$src" "$tmp/pip.ts"
( cd "$tmp" && "$tsc" pip.ts --outDir "$out" \
    --target es2022 --module es2022 --moduleResolution bundler \
    --lib es2022,dom --strict --skipLibCheck )
status=$?
rm -rf "$tmp"

if [[ $status -ne 0 || ! -f "$out/pip.js" ]]; then
    echo "  lib/pip.ts did not compile — fix that first; the test cannot say anything useful." >&2
    exit 1
fi

node "$test_dir/run.mjs"
status=$?
rm -rf "$out"
exit $status
