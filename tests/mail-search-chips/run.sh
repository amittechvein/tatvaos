#!/usr/bin/env bash
#
# Compiles apps/web/lib/mailSearchTokens.ts and runs chips.check.js on it.
#
# The web app has no test runner of its own (no jest, no vitest), so rather
# than adding one for a single pure module this borrows the tsc that is
# already installed for `pnpm --filter @tatvaos/web typecheck`.
#
# Exit: 0 all passed, 1 a check failed, 2 the tools are not there.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tsc="$root/apps/web/node_modules/.bin/tsc"

if [ ! -x "$tsc" ]; then
    echo "  SKIPPED: $tsc not found — run 'pnpm install' first." >&2
    exit 2
fi

rm -rf "$here/.built"
"$tsc" "$root/apps/web/lib/mailSearchTokens.ts" \
    --outDir "$here/.built" --module commonjs --target es2020 --skipLibCheck

node "$here/chips.check.js"
