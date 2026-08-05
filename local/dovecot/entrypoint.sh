#!/bin/bash
#
# Dovecot container entrypoint.
#
# Exists for one reason: dovecot-sql.conf.ext carries the mail-edge database
# password, and the copy in source control says 'dev_mail_pw' because the local
# stack needs a knowable value. Shipping that to a server would mean a
# production database whose mail-edge role password is published in the repo.
#
# The file is bind-mounted read-only, so it cannot be edited in place. The
# mount moved to /etc/dovecot/dovecot-sql.conf.ext.tmpl and this renders the
# real file next to it at start. dovecot.conf keeps pointing at the original
# path and does not need to know.
#
# Rendered at START, never baked into the image — an image layer holding the
# production password would be readable by anyone who could pull it.

set -uo pipefail

TMPL=/etc/dovecot/dovecot-sql.conf.ext.tmpl
OUT=/etc/dovecot/dovecot-sql.conf.ext

if [ -f "$TMPL" ]; then
    MAILEDGE_PW="${MAILEDGE_DB_PASSWORD:-}"

    if [ -z "$MAILEDGE_PW" ]; then
        if [ "${TATVAOS_ENV:-local}" = "local" ]; then
            echo "[dovecot] MAILEDGE_DB_PASSWORD unset — using the development password"
            MAILEDGE_PW=dev_mail_pw
        else
            echo "[dovecot] FATAL: MAILEDGE_DB_PASSWORD is not set and this is not local."
            echo "[dovecot] Refusing to start with the development password on ${TATVAOS_ENV:-unknown}."
            exit 1
        fi
    fi

    # LITERAL substitution — index/substr, not sed and not awk's gsub.
    #
    # Both interpret the REPLACEMENT text: sed treats / & \ specially, and
    # awk's gsub treats & as "the text that matched". A password containing &
    # would be rendered wrong, silently, and Dovecot would then reject every
    # login — which reads to a user as "my password stopped working" rather
    # than as a config bug.
    MAILEDGE_PW="$MAILEDGE_PW" awk '
    BEGIN { pw = ENVIRON["MAILEDGE_PW"]; tok = "dev_mail_pw"; n = length(tok) }
    {
        out = ""; line = $0
        while ((i = index(line, tok)) > 0) {
            out = out substr(line, 1, i - 1) pw
            line = substr(line, i + n)
        }
        print out line
    }' "$TMPL" > "$OUT"

    # Dovecot refuses to start if this is group- or world-readable, and it is
    # right to. It holds a database password.
    chmod 600 "$OUT"
    chown root:root "$OUT" 2>/dev/null || true

    if grep -qs 'dev_mail_pw' "$OUT" && [ "${TATVAOS_ENV:-local}" != "local" ]; then
        echo "[dovecot] FATAL: the rendered config still contains dev_mail_pw"
        exit 1
    fi

    echo "[dovecot] rendered dovecot-sql.conf.ext"
fi

# Wait for Postgres. depends_on only guarantees the container started, and
# Dovecot will come up and then fail every authentication if lookups fail —
# which reads to a user as "my password stopped working".
echo "[dovecot] waiting for postgres"
for i in $(seq 1 30); do
    if (echo > /dev/tcp/postgres/5432) 2>/dev/null; then
        echo "[dovecot] postgres reachable"
        break
    fi
    [ "$i" -eq 30 ] && echo "[dovecot] WARNING: postgres never became reachable"
    sleep 2
done

echo "[dovecot] starting in foreground"
exec dovecot -F
