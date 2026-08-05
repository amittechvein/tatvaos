#!/bin/bash
#
# Postfix container entrypoint.
#
# Renders three things at start, so ONE set of config files serves local, CI,
# staging and production:
#
#   main.cf          from main.cf.tmpl — myhostname, mydomain, relayhost
#   sql/*.cf         from sql-src/*.cf — the mail-edge database password
#
# master.cf is mounted read-only and used as-is; nothing in it varies.
#
# Rendering rather than keeping a second copy per environment is deliberate.
# There WERE two copies, they drifted, and the deployed one was the broken one
# — pointing at pre-restructure table names and at a Mailpit container that
# does not exist outside development.

set -uo pipefail

echo "[postfix] preparing"

# ---------------------------------------------------------------------------
#  Render the SQL lookup files with the real database password.
#
#  The .cf files in source control carry 'dev_mail_pw' because the local stack
#  needs a knowable value. Shipping that to a server would mean a production
#  database whose mail-edge role password is published in a public-ish repo.
#
#  They cannot be edited in place: they are bind-mounted read-only. So the
#  mount moved to /etc/postfix/sql-src and this renders the real files into
#  /etc/postfix/sql, which is writable and inside the container only. main.cf
#  keeps pointing at /etc/postfix/sql and does not need to know.
#
#  Rendered at START, never baked into the image — an image layer containing
#  the production password would be readable by anyone who could pull it.
# ---------------------------------------------------------------------------
SQL_SRC=/etc/postfix/sql-src
SQL_OUT=/etc/postfix/sql

# ---------------------------------------------------------------------------
#  ONE main.cf, rendered per environment.
#
#  It used to be two files — local/postfix/main.cf and infra/postfix/main.cf —
#  and they drifted. The deployed copy still hardcoded
#
#      myhostname = mail.techvein.local
#      relayhost  = [mailpit]:1025
#
#  so a production box would have announced itself as a .local name and tried
#  to relay every message to a container that does not exist there. Meanwhile
#  RELAY_TO_MAILPIT was set in the production overlay and read by nothing at
#  all: a containment switch wired to no wire.
#
#  Now there is one template and these three variables:
#
#    MAIL_HOSTNAME     what Postfix announces in HELO. MUST match the PTR.
#    RELAY_TO_MAILPIT  true  -> everything to Mailpit, nothing escapes
#                      false -> real delivery
#    RELAY_HOST        optional smart host, e.g. while IPs warm up
# ---------------------------------------------------------------------------
MAIN_TMPL=/etc/postfix/main.cf.tmpl
MAIN_OUT=/etc/postfix/main.cf

if [ -f "$MAIN_TMPL" ]; then
    HOSTNAME_VALUE="${MAIL_HOSTNAME:-mail.techvein.local}"

    if [ "${RELAY_TO_MAILPIT:-true}" = "true" ]; then
        RELAY_VALUE="[mailpit]:1025"
        echo "[postfix] CONTAINED — everything relays to Mailpit, nothing leaves this machine"
    elif [ -n "${RELAY_HOST:-}" ]; then
        RELAY_VALUE="[${RELAY_HOST}]"
        echo "[postfix] relaying through ${RELAY_HOST}"
    else
        # Empty relayhost means Postfix delivers directly by MX lookup.
        RELAY_VALUE=""
        echo "[postfix] DIRECT DELIVERY — outbound mail reaches real inboxes"
    fi

    # Default: everything after the first label of the HELO name.
    # mx.tatvaos.com -> tatvaos.com
    DOMAIN_VALUE="${MAIL_DOMAIN_NAME:-${HOSTNAME_VALUE#*.}}"

    MAIL_HOSTNAME="$HOSTNAME_VALUE" MAIL_DOMAIN_VALUE="$DOMAIN_VALUE" \
    RELAY_VALUE="$RELAY_VALUE" awk '
        BEGIN { hn = ENVIRON["MAIL_HOSTNAME"]
                dn = ENVIRON["MAIL_DOMAIN_VALUE"]
                rv = ENVIRON["RELAY_VALUE"] }
        # mydomain and myorigin stamp locally-generated mail — bounces and
        # postmaster notices. Left at techvein.local they would leave a
        # public server addressed from a domain that does not exist.
        /^myhostname[[:space:]]*=/ { print "myhostname = " hn; next }
        /^mydomain[[:space:]]*=/   { print "mydomain   = " dn; next }
        /^relayhost[[:space:]]*=/  { print "relayhost = " rv;  next }
        { print }
    ' "$MAIN_TMPL" > "$MAIN_OUT"

    echo "[postfix] myhostname = $HOSTNAME_VALUE   mydomain = $DOMAIN_VALUE"

    # A .local HELO on a public MX gets mail refused by most receivers, and the
    # cause is invisible from our side — it shows up as their bounce, days
    # later. Refuse to start instead.
    case "${TATVAOS_ENV:-local}" in
        local) ;;
        *) case "$HOSTNAME_VALUE" in
               *.local|localhost|"")
                   echo "[postfix] FATAL: myhostname is '$HOSTNAME_VALUE' on ${TATVAOS_ENV}."
                   echo "[postfix] Set MAIL_HOSTNAME to the name the PTR record resolves to."
                   exit 1 ;;
           esac ;;
    esac
fi

# ---------------------------------------------------------------------------
#  LITERAL substitution — index/substr, not sed and not awk's gsub.
#
#  Both of those interpret the REPLACEMENT text. sed treats / & \ specially;
#  awk's gsub treats & as "the text that matched". A password of
#  'aB/9&x.Q' rendered with gsub comes out as 'aB/9dev_mail_pwx.Q' — a wrong
#  password, written confidently, with no error anywhere. Postfix then fails
#  every lookup and the symptom looks like the database is down.
#
#  Splitting on the literal token and pasting the value between the pieces
#  interprets nothing at all.
# ---------------------------------------------------------------------------
RENDER='
BEGIN { pw = ENVIRON["MAILEDGE_PW"]; tok = "dev_mail_pw"; n = length(tok) }
{
    out = ""; line = $0
    while ((i = index(line, tok)) > 0) {
        out = out substr(line, 1, i - 1) pw
        line = substr(line, i + n)
    }
    print out line
}'

if [ -d "$SQL_SRC" ]; then
    MAILEDGE_PW="${MAILEDGE_DB_PASSWORD:-}"

    if [ -z "$MAILEDGE_PW" ]; then
        # Only tolerable locally. On a server this is the difference between a
        # password and no password, so refuse rather than start and look fine.
        if [ "${TATVAOS_ENV:-local}" = "local" ]; then
            echo "[postfix] MAILEDGE_DB_PASSWORD unset — using the development password"
            MAILEDGE_PW=dev_mail_pw
        else
            echo "[postfix] FATAL: MAILEDGE_DB_PASSWORD is not set and this is not local."
            echo "[postfix] Refusing to start with the development password on ${TATVAOS_ENV:-unknown}."
            exit 1
        fi
    fi

    mkdir -p "$SQL_OUT"
    for f in "$SQL_SRC"/*.cf; do
        [ -e "$f" ] || continue
        out="$SQL_OUT/$(basename "$f")"
        MAILEDGE_PW="$MAILEDGE_PW" awk "$RENDER" "$f" > "$out"
        # World-readable lookup files hand the password to any process in the
        # container. Postfix reads these as root before dropping privilege.
        chmod 600 "$out"
    done
    echo "[postfix] rendered $(ls -1 "$SQL_OUT"/*.cf 2>/dev/null | wc -l) SQL lookup files"

    # A missed substitution means Postfix authenticates with the wrong password
    # and rejects every recipient — which looks like a database outage. Say so
    # here instead.
    if grep -qs 'dev_mail_pw' "$SQL_OUT"/*.cf && [ "${TATVAOS_ENV:-local}" != "local" ]; then
        echo "[postfix] FATAL: a rendered lookup file still contains dev_mail_pw"
        exit 1
    fi
fi

# Postfix insists on an aliases database even when purely virtual
: > /etc/aliases
newaliases 2>/dev/null || true

# Fix spool permissions (does not touch the read-only config files)
postfix set-permissions 2>/dev/null || true

# Wait for Postgres - depends_on only guarantees the container started,
# and Postfix will happily start and then reject everything if lookups fail.
echo "[postfix] waiting for postgres"
for i in $(seq 1 30); do
    if (echo > /dev/tcp/postgres/5432) 2>/dev/null; then
        echo "[postfix] postgres reachable"
        break
    fi
    [ "$i" -eq 30 ] && echo "[postfix] WARNING: postgres never became reachable"
    sleep 2
done

# Validate config and PRINT WHAT IS WRONG.
#
# The previous version swallowed the output behind "check reported issues",
# which told you something was broken but not what - useless in a restart loop.
echo "[postfix] --- postfix check ---"
if ! postfix check 2>&1 | sed 's/^/[postfix]   /'; then
    echo "[postfix] --- end check (problems above) ---"
else
    echo "[postfix] --- config OK ---"
fi

echo "[postfix] starting in foreground"
# The old version claimed "all outbound relays to mailpit" unconditionally,
# which would have been a comforting lie on a production box.
if [ "${RELAY_TO_MAILPIT:-true}" = "true" ]; then
    echo "[postfix]   outbound    -> mailpit (nothing leaves this machine)"
else
    echo "[postfix]   outbound    -> REAL DELIVERY as ${MAIL_HOSTNAME:-?}"
fi

# If start-fg dies, show why rather than silently restarting forever
postfix start-fg
rc=$?
echo "[postfix] start-fg exited with code $rc"
echo "[postfix] --- last words ---"
postconf -n 2>&1 | head -40 | sed 's/^/[postfix]   /'
exit "$rc"
