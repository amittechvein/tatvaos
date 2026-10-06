#!/usr/bin/env bash
#
# Compiles apps/web/lib/replyRecipients.ts and runs recipients.check.js on it.
#
# Same arrangement as tests/mail-search-chips: the web app has no test runner
# of its own, so this borrows the tsc already installed for typecheck.
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
"$tsc" "$root/apps/web/lib/replyRecipients.ts" \
    --outDir "$here/.built" --module commonjs --target es2020 --skipLibCheck

node "$here/recipients.check.js"
