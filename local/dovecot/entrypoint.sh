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

    # The SQL lookups run in Dovecot's auth-worker, which drops to the
    # unprivileged internal user (dovecot) — and THAT user must be able to read
    # this file, or the connect string comes back empty and Postgres answers
    # every lookup with "fe_sendauth: no password supplied".
    #
    # 600 root:root — the obvious "it holds a password" choice, and what this
    # file shipped with — is exactly what silently broke LMTP delivery in
    # production: the domain resolved, Postfix handed the message to Dovecot,
    # and Dovecot deferred it with a 451 internal error because its own auth
    # worker could not read the password to look the recipient up. Nothing
    # caught it because nothing had ever delivered a message until the first
    # real one arrived.
    #
    # 640, owner root, group = the internal user's group. Out of the world's
    # reach, readable by the one process that needs it. This is the permission
    # Dovecot's own documentation recommends for this file.
    DOVE_GROUP=$(id -gn "$(doveconf -h default_internal_user 2>/dev/null || echo dovecot)" 2>/dev/null || echo dovecot)
    chown "root:${DOVE_GROUP}" "$OUT" 2>/dev/null || true
    chmod 640 "$OUT"

    if grep -qs 'dev_mail_pw' "$OUT" && [ "${TATVAOS_ENV:-local}" != "local" ]; then
        echo "[dovecot] FATAL: the rendered config still contains dev_mail_pw"
        exit 1
    fi

    echo "[dovecot] rendered dovecot-sql.conf.ext"
fi

# The app-password store renders identically — same token, same literal
# substitution, same permissions, same refuse-dev-password-outside-local
# gate. A second store with a subtly different render path would be a second
# place for the & -in-password bug to live.
TMPL2=/etc/dovecot/dovecot-sql-app.conf.ext.tmpl
OUT2=/etc/dovecot/dovecot-sql-app.conf.ext
if [ -f "$TMPL2" ]; then
    MAILEDGE_PW="${MAILEDGE_DB_PASSWORD:-dev_mail_pw}" awk '
    BEGIN { pw = ENVIRON["MAILEDGE_PW"]; tok = "dev_mail_pw"; n = length(tok) }
    {
        out = ""; line = $0
        while ((i = index(line, tok)) > 0) {
            out = out substr(line, 1, i - 1) pw
            line = substr(line, i + n)
        }
        print out line
    }' "$TMPL2" > "$OUT2"
    DOVE_GROUP=$(id -gn "$(doveconf -h default_internal_user 2>/dev/null || echo dovecot)" 2>/dev/null || echo dovecot)
    chown "root:${DOVE_GROUP}" "$OUT2" 2>/dev/null || true
    chmod 640 "$OUT2"
    if grep -qs 'dev_mail_pw' "$OUT2" && [ "${TATVAOS_ENV:-local}" != "local" ]; then
        echo "[dovecot] FATAL: the rendered app-password config still contains dev_mail_pw"
        exit 1
    fi
    echo "[dovecot] rendered dovecot-sql-app.conf.ext"
else
    # REFUSE, do not skip. This branch used to fall through silently, and the
    # cost is on record: local's compose never mounted the template, dovecot.conf
    # declares a passdb pointing at the rendered file, and every cold start from
    # 28 Aug to 2 Sep died with "Can't open configuration file" - five days of a
    # red mail-stack job blamed on three wrong theories before anyone was told
    # the mount was missing. A guard that skips quietly where it should refuse
    # loudly is a wish; this is the mechanism.
    if grep -qs 'dovecot-sql-app.conf.ext' /etc/dovecot/dovecot.conf; then
        echo "[dovecot] FATAL: dovecot.conf declares the app-password passdb, but"
        echo "[dovecot]        $TMPL2 is not mounted."
        echo "[dovecot]        Add to this environment's compose file, matching production:"
        echo "[dovecot]          - ./dovecot/dovecot-sql-app.conf.ext:$TMPL2:ro"
        exit 1
    fi
    echo "[dovecot] app-password template not mounted and dovecot.conf does not use it - skipping"
fi

# Wait for Postgres. depends_on only guarantees the container started, and
# Dovecot will come up and then fail every authentication if lookups fail —
# which reads to a user as "my password stopped working".
# ---------------------------------------------------------------------------
# Environment overlay — the production security that must not exist in the
# shared config file (see the note at the bottom of dovecot.conf).
#
# EVERY branch here FAILS CLOSED. A mail edge that cannot find its
# certificate must refuse to start, not fall back to the plaintext posture
# that sat on an internet-published port 143 until 28 Aug 2026.
# ---------------------------------------------------------------------------
OVR=/etc/dovecot/env-overrides.conf
if [ "${TATVAOS_ENV:-local}" != "local" ]; then
    CRT=/certs/fullchain.pem
    KEY=/certs/privkey.pem
    if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
        echo "[dovecot] FATAL: no TLS certificate at $CRT / $KEY."
        echo "[dovecot] deploy.sh syncs it from Caddy into the mailcerts volume;"
        echo "[dovecot] refusing to serve mail without TLS on ${TATVAOS_ENV}."
        exit 1
    fi

    # The stored hashes are raw $argon2id$ with no {SCHEME} prefix (the API's
    # Argon2PasswordHasher writes them), so the FALLBACK scheme must be
    # ARGON2ID here — with SHA512-CRYPT as the fallback, every real user's
    # IMAP login verified against the wrong algorithm and could never have
    # succeeded. Proven supported before use, because a Dovecot built without
    # libsodium would fail every login with the same symptom.
    if ! doveadm pw -s ARGON2ID -p probe >/dev/null 2>&1; then
        echo "[dovecot] FATAL: this Dovecot build does not support ARGON2ID."
        exit 1
    fi
    sed -i 's/^default_pass_scheme = SHA512-CRYPT/default_pass_scheme = ARGON2ID/' "$OUT"

    cat > "$OVR" <<'EOF'
# GENERATED by entrypoint.sh — production/staging only. Do not edit; it is
# rewritten on every container start.
ssl = yes
ssl_cert = </certs/fullchain.pem
ssl_key = </certs/privkey.pem
ssl_min_protocol = TLSv1.2
ssl_prefer_server_ciphers = yes

# Auth only ever over TLS. On 143 this means STARTTLS first; 993 is TLS from
# the first byte. The dev-only `no` in the base file is what put cleartext
# passwords on the open internet.
disable_plaintext_auth = yes

service imap-login {
    inet_listener imaps {
        port = 993
    }
}

# Postfix's submission port authenticates against THIS listener, over the
# compose network only — the port is not published. One password store for
# IMAP and SMTP, which is what a third-party mail client expects.
service auth {
    inet_listener postfix-sasl {
        port = 12345
    }
}
EOF
    echo "[dovecot] wrote production overlay (TLS + SASL listener)"
else
    rm -f "$OVR"
fi

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
