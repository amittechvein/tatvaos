#!/usr/bin/env bash
#
# The AI meter cannot be walked around — checked, not asserted.
#
# Mr. Singh on PR 280, 25 Sept 2026: IAiGateway resolving to MeteredAiGateway
# means nothing only if OpenAiGateway itself is unreachable; "either register
# the provider so only the wrapper can construct it, or add a test that fails
# when OpenAiGateway is referenced outside the wrapper." This is both halves:
#
#   1. OpenAiGateway is named in CODE only in its own file and in
#      MeteredAiGateway.cs — so no module injects it, constructs it, or
#      registers it in DI. (Comment lines are ignored; a comment cannot
#      bypass anything.)
#   2. The wrapper is what IAiGateway resolves to, and the wrapper builds the
#      provider itself.
#
#   bash tests/ai/gateway-not-bypassable.sh      (from the repository root)
#
# Exit 0 = holds. Exit 1 = a bypass path exists; the offending lines are printed.

set -uo pipefail
cd "$(dirname "$0")/../.."

FAILED=0
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
pass() { printf '  ok    %s\n' "$1"; }

# --- 1. no code outside the two files names the provider class ------------------
hits=$(grep -rn --include='*.cs' -E '\bOpenAiGateway\b' apps/api \
        | grep -v -E '^apps/api/(bin|obj)/' \
        | grep -v -E '^apps/api/Shared/Ai/(OpenAiGateway|MeteredAiGateway)\.cs:' \
        | grep -v -E '^[^:]+:[0-9]+:\s*//' )
if [ -z "$hits" ]; then
    pass "OpenAiGateway is named in code only by itself and the wrapper"
else
    fail "OpenAiGateway is reachable outside the wrapper:"
    printf '%s\n' "$hits" | sed 's/^/          /'
fi

# --- 2. the wiring that makes the wrapper the only way in ------------------------
if grep -qE 'AddScoped<IAiGateway,\s*MeteredAiGateway>' apps/api/Program.cs; then
    pass "IAiGateway resolves to MeteredAiGateway"
else
    fail "Program.cs does not register IAiGateway as MeteredAiGateway"
fi
if grep -qE 'ActivatorUtilities\.CreateInstance<OpenAiGateway>' apps/api/Shared/Ai/MeteredAiGateway.cs; then
    pass "the wrapper constructs the provider itself"
else
    fail "MeteredAiGateway does not construct its own OpenAiGateway"
fi

exit $FAILED
