#!/usr/bin/env bash
# =============================================================================
#  verify-space-share-privacy.sh — you cannot read the guest list
# =============================================================================
#
#  WHAT THIS PROVES
#
#  Amit's ruling, 30 Aug 2026: an item's share list is personal data about the
#  people on it. A file shared with thirty parents carries, in that list, the
#  names and addresses of twenty-nine other families who never agreed to be
#  visible to each other.
#
#  So GET /api/space/{files,folders}/{id}/shares must answer differently
#  depending on who asks:
#
#    · the uploader (and organisation admins) — everyone, and their level;
#    · anybody else — that it is shared, and their OWN access, and nothing
#      whatever about the others.
#
#  This drives the real API with two real sign-ins and asserts exactly that.
#
#  WHAT WOULD PROVE IT WRONG — because a check nobody can fail is not a check.
#  The scenario is built so the assertion depended on the bug: person B is
#  given **edit**, which is precisely the level that could read the whole list
#  before this change. Run this script against the code as it stood on 29
#  August and step 6 fails, naming person C. That is not a hypothetical
#  calibration; it is why the shape of the test is what it is.
#
#  It also refuses rather than passing when it cannot tell: if C never appears
#  in the uploader's own view (step 5), then C's absence from B's view proves
#  nothing at all, and the script says so and stops.
#
#  PASSWORDS ARE NEVER ARGUMENTS. They are read with echo off and unset
#  immediately. A password on a command line is in the shell history, in the
#  process list, and in the transcript somebody pastes afterwards — rule 5.
#
#  USAGE — from the repo root:
#
#      bash infra/scripts/verify-space-share-privacy.sh <site-hostname>
#
#  You will be asked for three addresses in the same organisation, and for
#  two of the passwords:
#
#      UPLOADER  — creates the test folder. Any ordinary account.
#      PERSON B  — will be given EDIT and must sign in. Any ordinary account.
#      PERSON C  — given VIEW. Never signs in; no password needed. C is the
#                  person whose privacy is the subject of the test.
#
#  It creates one folder named share-privacy-test-*, and trashes and purges it
#  on the way out however it exits. Nothing else is written.
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/../.." 2>/dev/null || true

SITE="${1:-}"
if [[ -z "$SITE" ]]; then
    echo "usage: $0 <site-hostname>      e.g. $0 tatvaos.example.in" >&2
    exit 2
fi
API="https://${SITE}/api"

PASSED=0; FAILED=0
ok()   { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad()  { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
info() { echo "        · $1"; }
head2(){ printf '\n  %s\n  %s\n' "$1" "$(printf '%.0s-' $(seq 1 62))"; }

jstr()   { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
jbool()  { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\(true\|false\)" | head -1 | sed 's/.*:[[:space:]]*//'; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

call() {   # call METHOD URL TOKEN [JSON]
    local method="$1" url="$2" tok="$3" data="${4:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 25 -H "Authorization: Bearer $tok")
    [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}

# Prints the token on stdout and RETURNS non-zero on failure.
#
# It must return rather than exit: this is called as TOK=$(login ...), and a
# command substitution runs in a subshell, where exit kills only the subshell.
# The first version of this script called exit here, so a failed sign-in
# printed FAIL and the script carried on with an empty token and announced
# "person B signed in" on the very next line. Every caller below therefore
# checks the return status AND the token, and neither is optional.
login() {
    local email="$1" pass r tok
    printf '  password for %s (not shown): ' "$email" >&2
    stty -echo 2>/dev/null; read -r pass; stty echo 2>/dev/null; echo >&2
    r=$(printf '{"email":"%s","password":"%s"}' "$email" "$pass" |
        curl -s -X POST -w '\n%{http_code}' --max-time 25 \
             -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
    unset pass
    tok=$(body "$r" | jstr accessToken)
    if [[ "$(status "$r")" != "200" || -z "$tok" ]]; then
        echo "  FAIL  sign-in for $email returned $(status "$r")" >&2
        case "$(body "$r")" in
            *mfaRequired*) echo "        That account has MFA on; use one without it here." >&2 ;;
            *)             echo "        $(body "$r" | head -c 200)" >&2 ;;
        esac
        return 1
    fi
    printf '%s' "$tok"
}

lookup() { # lookup TOKEN EMAIL -> prints user id, or empty
    local tok="$1" email="$2" r
    r=$(call GET "$API/space/directory?q=$(printf '%s' "$email" | sed 's/@/%40/')" "$tok")
    [[ "$(status "$r")" = "200" ]] || return 1
    # the one entry whose email matches exactly
    body "$r" | tr '{' '\n' | grep -F "\"email\":\"$email\"" | jstr id
}

# Terminals that bracket pastes wrap them in \e[200~ ... \e[201~, and an
# arrow key pressed while correcting a paste arrives as \e[D. Both end up
# INSIDE the variable and produce a mangled address that still looks right on
# screen. Turn bracketed paste off, then strip anything that is not part of an
# address, then show back exactly what was captured.
printf '\033[?2004l'

askmail() {
    local prompt="$1" v
    printf '  %s' "$prompt" >&2
    read -r v
    printf '%s' "$v" | tr -d '[:cntrl:]' | sed 's/\[20[01]~//g; s/\[[0-9]*[A-Za-z]//g; s/[[:space:]]//g'
}

head2 "who is taking part"
E_UP=$(askmail 'UPLOADER email: ')
E_B=$(askmail  'PERSON B email (will be given EDIT, must sign in): ')
E_C=$(askmail  'PERSON C email (given VIEW, never signs in): ')

for e in "$E_UP" "$E_B" "$E_C"; do
    case "$e" in
        *@*.*) : ;;
        *) echo "  '$e' does not look like an email address."; exit 2 ;;
    esac
done

echo
echo "  Read back — check every character, a pasted address can lose one:"
echo "    uploader : $E_UP"
echo "    person B : $E_B"
echo "    person C : $E_C"
printf '  Correct? [y/N] '
read -r yn
case "$yn" in [Yy]*) : ;; *) echo "  stopped."; exit 2 ;; esac
if [[ "$E_UP" = "$E_B" || "$E_UP" = "$E_C" || "$E_B" = "$E_C" ]]; then
    echo "  REFUSED  the three addresses must be three different people."
    echo "           With fewer, B's own row and C's row are the same row and"
    echo "           the test cannot distinguish privacy from coincidence."
    exit 2
fi

head2 "signing in"
TOK_UP=$(login "$E_UP") || exit 1
[[ -n "$TOK_UP" ]] || { bad "no token for the uploader"; exit 1; }
ok "uploader signed in"

TOK_B=$(login "$E_B") || exit 1
[[ -n "$TOK_B" ]] || { bad "no token for person B"; exit 1; }
ok "person B signed in"

ID_B=$(lookup "$TOK_UP" "$E_B") || true
ID_C=$(lookup "$TOK_UP" "$E_C") || true
[[ -n "$ID_B" && -n "$ID_C" ]] || {
    bad "could not find B and/or C in the organisation directory"
    info "both must be active or pending users in the same organisation"
    exit 1
}
ok "found both people in the directory"

# ---------------------------------------------------------------------------
head2 "building the scenario"
FOLDER=""
cleanup() {
    [[ -z "$FOLDER" ]] && return
    call DELETE "$API/space/folders/$FOLDER" "$TOK_UP" >/dev/null 2>&1
    call DELETE "$API/space/folders/$FOLDER/permanent" "$TOK_UP" >/dev/null 2>&1
    echo "  (test folder removed)"
}
trap cleanup EXIT

NAME="share-privacy-test-$(date +%Y%m%d-%H%M%S)"
r=$(call POST "$API/space/folders" "$TOK_UP" "$(printf '{"name":"%s","scope":"organisational"}' "$NAME")")
FOLDER=$(body "$r" | jstr id)
[[ "$(status "$r")" =~ ^20 && -n "$FOLDER" ]] || {
    bad "could not create the organisational test folder (HTTP $(status "$r"))"
    info "$(body "$r")"; exit 1; }
ok "organisation-owned folder created"

r=$(call PUT "$API/space/folders/$FOLDER/shares" "$TOK_UP" "$(printf '{"userId":"%s","permission":"edit"}' "$ID_B")")
[[ "$(status "$r")" =~ ^20 ]] || { bad "could not share with B (HTTP $(status "$r"))"; exit 1; }
ok "shared with B at EDIT — the level that could read the whole list before"

r=$(call PUT "$API/space/folders/$FOLDER/shares" "$TOK_UP" "$(printf '{"userId":"%s","permission":"view"}' "$ID_C")")
[[ "$(status "$r")" =~ ^20 ]] || { bad "could not share with C (HTTP $(status "$r"))"; exit 1; }
ok "shared with C at VIEW"

# ---------------------------------------------------------------------------
head2 "5. the uploader sees everyone"
r=$(call GET "$API/space/folders/$FOLDER/shares" "$TOK_UP")
UP_BODY=$(body "$r")
if [[ "$(status "$r")" != "200" ]]; then
    bad "the uploader could not read the share list (HTTP $(status "$r"))"; exit 1
fi
UP_SEES_C=$(grep -cF "$ID_C" <<<"$UP_BODY")
UP_FLAG=$(jbool canSeeEveryone <<<"$UP_BODY")
if [[ "$UP_SEES_C" -eq 0 ]]; then
    bad "C does not appear even for the UPLOADER."
    info "Then C's absence from B's view below would prove nothing, so this"
    info "script refuses to report a pass it has not earned."
    exit 1
fi
ok "uploader sees C"
[[ "$UP_FLAG" = "true" ]] && ok "uploader is told the list is complete (canSeeEveryone true)" \
                          || bad "uploader got canSeeEveryone='$UP_FLAG', expected true"

# ---------------------------------------------------------------------------
head2 "6. person B sees only themselves — THE ASSERTION"
r=$(call GET "$API/space/folders/$FOLDER/shares" "$TOK_B")
B_STATUS=$(status "$r"); B_BODY=$(body "$r")

if [[ "$B_STATUS" != "200" ]]; then
    bad "B got HTTP $B_STATUS reading the share list; expected 200 with a partial list"
    info "the ruling is that B sees their own access, not that B is refused"
else
    if grep -qF "$ID_C" <<<"$B_BODY"; then
        bad "PRIVACY: B can see C. The ruling is not implemented."
        info "C's id appears in the response B receives:"
        echo "$B_BODY" | tr ',' '\n' | grep -F "$ID_C" | sed 's/^/          /'
    else
        ok "C does not appear in B's view"
    fi

    grep -qF "$ID_B" <<<"$B_BODY" \
        && ok "B does see their own access" \
        || bad "B cannot see even their own access — narrowed too far"

    B_FLAG=$(jbool canSeeEveryone <<<"$B_BODY")
    [[ "$B_FLAG" = "false" ]] \
        && ok "B is told the list is partial (canSeeEveryone false)" \
        || bad "B got canSeeEveryone='$B_FLAG', expected false — a partial list that claims to be whole"

    if grep -qiE '"(count|total|shareCount|others)"' <<<"$B_BODY"; then
        bad "the response to B carries a count. How many others is a fact about them."
    else
        ok "no count of other recipients is disclosed"
    fi
fi

# ---------------------------------------------------------------------------
head2 "verdict"
if [[ "$FAILED" -eq 0 ]]; then
    echo "  $PASSED checks passed. The share list is closed by default."
    exit 0
fi
echo "  $FAILED of $((PASSED+FAILED)) checks FAILED."
exit 1
