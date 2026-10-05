#!/usr/bin/env bash
# TatvaOS — only the known sign-in paths may call CompleteSignInAsync.
#
# Mr. Singh, 25 Sept 2026 (PR 281, condition one). CompleteSignInAsync is the
# tail every sign-in runs through: it resets the lockout, activates a pending
# account, issues the session and sets the cookie. Each legitimate caller
# checks a credential FIRST — a password, a mobile code, a second factor, an
# invitation token, or (dev-operator) the five development gates. PR 281 made
# it `internal` so the development door could share it rather than copy it,
# which means anything in the API assembly can now call it. A new caller that
# skipped the checks in front would issue a session for anyone, and nothing
# would look wrong. "Sign-in is where I'd least accept a comment as the
# control." So this fails on any reference outside the list below.
#
# The list is by FILE and ENCLOSING METHOD, not by count (house rule 9). A
# reference is any non-comment mention of the name — a call, a method group
# passed as a delegate, a nameof, a reflection string — attributed to the
# nearest method declaration above it in the same file.
#
# It also proves it can SEE: every listed caller must be found, and a real
# number of files must have been scanned. A guard that searched nothing would
# pass forever (memory: testing-false-greens). Removing a sign-in path
# legitimately therefore means removing its line here too, in the same PR.
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="$ROOT/apps/api"
NAME='CompleteSignInAsync'

# file:method — every place allowed to reference the name. Reason per line.
ALLOWED='
Modules/Auth/Endpoints/AuthEndpoints.cs:CompleteSignInAsync   the definition itself
Modules/Auth/Endpoints/AuthEndpoints.cs:LoginAsync            password, after Argon2id verify + lockout
Modules/Auth/Endpoints/AuthEndpoints.cs:OtpVerifyAsync        mobile OTP, after the code hash matches
Modules/Auth/Endpoints/AuthEndpoints.cs:MfaVerifyAsync        second factor, after the TOTP challenge
Modules/Auth/Endpoints/AuthEndpoints.cs:AcceptInvitationAsync invitation, after the single-use token
Modules/Auth/Endpoints/DevOperatorSignIn.cs:SignInAsync       development only, after DevOperatorGate
'

fails=0
bad() { printf '  ✗ %s\n' "$1"; fails=$((fails+1)); }
ok()  { printf '  ✓ %s\n' "$1"; }

cd "$API" || { bad "no apps/api at $API"; exit 1; }
n=$(find . -name '*.cs' -not -path './bin/*' -not -path './obj/*' | wc -l | tr -d ' ')
[ "${n:-0}" -ge 100 ] && ok "scanned $n C# files" \
                      || bad "scanned only ${n:-0} C# files — the search is not looking where the code is"

# Every non-comment reference, as file:enclosing-method. One grep for the
# files that mention the name at all, then one awk per such file.
found=""
for f in $(grep -rlF --include='*.cs' --exclude-dir=bin --exclude-dir=obj -- "$NAME" . | sed 's|^\./||'); do
    found="$found
$(awk -v name="$NAME" -v file="$f" '
        # A method declaration: an access modifier, then a name followed by "(".
        /^[[:space:]]*(public|private|internal|protected)[^=;]*[A-Za-z0-9_]+[[:space:]]*\(/ {
            line = $0
            sub(/\(.*/, "", line)
            n = split(line, parts, /[^A-Za-z0-9_]+/)
            method = parts[n]
        }
        /^[[:space:]]*\/\// { next }            # comment lines may name it, and do
        index($0, name) > 0 { print file ":" (method == "" ? "<outside any method>" : method) }
    ' "$f")"
done
found=$(printf '%s\n' "$found" | grep -v '^$' | sort -u)

allowed_keys=$(printf '%s\n' "$ALLOWED" | awk 'NF { print $1 }' | sort -u)

# Anything referenced from outside the list is the failure this exists for.
while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    printf '%s\n' "$allowed_keys" | grep -qxF -- "$ref" \
        || bad "$ref references $NAME — not a known sign-in path. It must check a credential first; add it here, with its reason, only after review."
done <<< "$found"

# And the list must be SEEN, or the scan above proved nothing.
while IFS= read -r key; do
    [ -z "$key" ] && continue
    printf '%s\n' "$found" | grep -qxF -- "$key" \
        && ok "found $key" \
        || bad "$key is on the list but was not found — the search is blind, or the path was removed without updating this list"
done <<< "$allowed_keys"

if [ "$fails" -eq 0 ]; then
    ok "$NAME is referenced only from the known sign-in paths"
    exit 0
fi
printf '\n  %d finding(s). A session could be issued without a credential being checked.\n' "$fails"
exit 1
