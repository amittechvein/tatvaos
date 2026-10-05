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

# ---------------------------------------------------------------------------
# Submission posture — see master.cf. Local keeps the open-inside/closed-
# outside dev shape; anything else gets authenticated TLS submission, and
# REFUSES TO START without the certificate rather than falling back to the
# posture that left port 587 useless and 25/587 without TLS.
# ---------------------------------------------------------------------------
if [ "${TATVAOS_ENV:-local}" != "local" ]; then
    CRT=/certs/fullchain.pem
    KEY=/certs/privkey.pem
    if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
        echo "[postfix] FATAL: no TLS certificate at $CRT / $KEY."
        echo "[postfix] deploy.sh syncs it from Caddy into the mailcerts volume."
        exit 1
    fi
    postconf -e "smtpd_tls_cert_file=$CRT"
    postconf -e "smtpd_tls_key_file=$KEY"
    postconf -e "smtpd_tls_security_level=may"
    postconf -e "submission_tls_security_level=encrypt"
    postconf -e "submission_sasl_auth_enable=yes"
    postconf -e "submission_client_restrictions=permit_sasl_authenticated,reject"
    postconf -e "submission_recipient_restrictions=permit_sasl_authenticated,reject_unauth_destination,reject"
    echo "[postfix] submission: authenticated TLS posture applied"
fi
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

# ---------------------------------------------------------------------------
#  Port 587 sender ownership (PR 380): WARN or ENFORCE, one setting for both
#  halves - Postfix's envelope check and the From-line filter.
#
#  warn (the default, Amit 2 Oct 2026): nothing is refused; every message that
#  would be is recorded in /var/log/tatvaos/sender-ownership.jsonl, which is on
#  the maillogs volume and so survives deploys. enforce: both are refused.
#  Anything else is a typo, and a typo here must not silently pick a mode.
# ---------------------------------------------------------------------------
OWNERSHIP="${TATVAOS_SENDER_OWNERSHIP:-warn}"
case "$OWNERSHIP" in
    warn)    postconf -e "submission_sender_login_check=warn_if_reject reject_authenticated_sender_login_mismatch" ;;
    enforce) postconf -e "submission_sender_login_check=reject_authenticated_sender_login_mismatch" ;;
    *)       echo "[postfix] FATAL: TATVAOS_SENDER_OWNERSHIP='$OWNERSHIP' - must be warn or enforce"; exit 1 ;;
esac
echo "$OWNERSHIP" > /etc/postfix/sender-ownership-mode
# The filter writes its record here AFTER dropping to the postfix user, so
# the directory is postfix's; the restart bookkeeping below stays root's.
mkdir -p /var/log/tatvaos && chown postfix:postfix /var/log/tatvaos && chmod 750 /var/log/tatvaos
echo "[postfix]   587 senders -> ownership checked, mode: $OWNERSHIP"
[ -n "${TATVAOS_ALERT_TO:-}" ] || echo "[postfix]   WARNING: TATVAOS_ALERT_TO is not set - a crashing From-line filter would alert nobody"

# The From-line filter. Restarted if it exits; while it is down Postfix lets
# mail through (default_action=accept in main.cf) and the envelope check,
# which is Postfix's own, still holds.
#
# A crash must be VISIBLE (Mr. Singh, 3 Oct): every restart is logged and
# counted in a file on the maillogs volume (it survives the container), and
# more than three in an hour mails TATVAOS_ALERT_TO - the disk alert's way:
# this container's own sendmail, From alerts@tatvaos.com - at most once an
# hour, so a crash loop is one mail, not hundreds.
RESTARTS=/var/log/tatvaos/sender-milter-restarts
ALERTED=/var/log/tatvaos/sender-milter-alerted
milter_alert() {  # $1 restarts in the last hour
    printf 'From: TatvaOS server <%s>\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
        "${TATVAOS_ALERT_FROM:-alerts@tatvaos.com}" "$TATVAOS_ALERT_TO" \
        "[TatvaOS] sender-milter restarted $1 times in an hour on ${MAIL_HOSTNAME:-$(hostname)}" \
        "The port 587 From-line filter (sender-milter.py, in the postfix container) has exited and been restarted $1 times in the last hour.

Mail is still flowing: the filter fails open, and Postfix's own envelope check still refuses (or, in warn mode, records) senders the signed-in mailbox does not own. While it is down, From: lines are NOT checked and NOT recorded.

Look: docker logs tatvaos-postfix-1 2>&1 | grep sender-milter | tail -20
This alert is sent at most once an hour." \
        | sendmail -t -f "${TATVAOS_ALERT_FROM:-alerts@tatvaos.com}"
}
( while true; do
      python3 /usr/local/lib/tatvaos/sender-milter.py
      rc=$?
      now=$(date +%s)
      echo "$now" >> "$RESTARTS"
      tail -n 100 "$RESTARTS" > "$RESTARTS.tmp" && mv "$RESTARTS.tmp" "$RESTARTS"
      recent=$(awk -v since=$((now - 3600)) '$1 >= since' "$RESTARTS" | wc -l)
      echo "[sender-milter] exited ($rc) - restart ${recent} in the last hour; restarting in 2 s"
      if [ "$recent" -gt 3 ]; then
          last=$(cat "$ALERTED" 2>/dev/null || echo 0)
          if [ $((now - ${last:-0})) -ge 3600 ]; then
              if [ -z "${TATVAOS_ALERT_TO:-}" ]; then
                  echo "[sender-milter] ALERT: ${recent} restarts in an hour - TATVAOS_ALERT_TO is not set, NOBODY WAS MAILED"
              elif milter_alert "$recent"; then
                  echo "$now" > "$ALERTED"
                  echo "[sender-milter] ALERT mailed: ${recent} restarts in an hour"
              else
                  echo "[sender-milter] ALERT could not be handed to sendmail - ${recent} restarts in an hour"
              fi
          fi
      fi
      sleep 2
  done ) &

# If start-fg dies, show why rather than silently restarting forever
postfix start-fg
rc=$?
echo "[postfix] start-fg exited with code $rc"
echo "[postfix] --- last words ---"
postconf -n 2>&1 | head -40 | sed 's/^/[postfix]   /'
exit "$rc"
