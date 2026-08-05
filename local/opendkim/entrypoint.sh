#!/bin/bash
# ============================================================================
#  OpenDKIM — signs outbound mail with a per-domain key
# ============================================================================
#
#  THE KEY DIRECTORY IS THE SOURCE OF TRUTH.
#
#  The API writes /dkim/<fqdn>.<selector>.key when a domain is added, and this
#  container builds OpenDKIM's KeyTable and SigningTable by scanning for those
#  files. There is deliberately no manifest, no database query and no shared
#  config file: a second list of what should be signed is a second thing that
#  can disagree with the first, and the failure mode of that disagreement is
#  mail going out unsigned with nothing logged anywhere.
#
#  OpenDKIM reads its tables once at startup, so the directory is rescanned on
#  a timer and the daemon reloaded when the set of keys changes. Adding a
#  customer domain therefore takes effect within a minute without a deploy.
#
#  WHY NOT QUERY POSTGRES DIRECTLY: OpenDKIM can read tables over ODBC, but
#  that would need the private keys in a table the signer can read — and the
#  whole reason core.dkim_keys carries no grant to the mail-edge role is that
#  the internet-facing components should not be able to read a tenant's key.
#  A file the API places is a narrower path than a database connection.
# ============================================================================

set -uo pipefail

KEYDIR=${DKIM_KEY_DIR:-/dkim}
RUNDIR=/run/opendkim
# Keys are COPIED here rather than signed from in place.
#
# The API writes them as its own non-root user with mode 0600, and OpenDKIM
# drops to opendkim:opendkim before it reads anything — so the daemon could not
# open them where they lie. This entrypoint still runs as root, and root can
# read a file owned by someone else. Copying once at that moment is the whole
# trick, and it keeps every key at 0600 with no world-readable step anywhere.
PRIVDIR=$RUNDIR/keys
CONF=/etc/opendkim.conf
KEYTABLE=$RUNDIR/KeyTable
SIGNTABLE=$RUNDIR/SigningTable
TRUSTED=$RUNDIR/TrustedHosts

mkdir -p "$RUNDIR" "$PRIVDIR"
chown -R opendkim:opendkim "$RUNDIR" 2>/dev/null || true
chmod 700 "$PRIVDIR"

# ---------------------------------------------------------------------------
#  Who may ask us to sign.
#
#  Only our own containers. OpenDKIM signs whatever an internal host submits,
#  so a wider list here would let anything that could reach port 8891 have
#  mail signed as any of our customers.
# ---------------------------------------------------------------------------
cat > "$TRUSTED" <<EOF
127.0.0.1
localhost
::1
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
EOF

cat > "$CONF" <<EOF
Syslog                  yes
SyslogSuccess           yes
LogWhy                  no
UMask                   007
Socket                  inet:8891

# sv = sign outbound AND verify inbound. Verification costs almost nothing and
# gives Rspamd a header to score against when it arrives.
Mode                    sv

SubDomains              no
AutoRestart             yes
AutoRestartRate         10/1h

# relaxed/simple: relaxed header canonicalisation survives the whitespace and
# header-folding changes that mailing lists and forwarders introduce. simple
# body canonicalisation is stricter but bodies are usually passed through
# unchanged. relaxed/relaxed would be more forgiving still; this pair is what
# most large senders use.
Canonicalization        relaxed/simple

# From is the header DMARC aligns on, so over-signing it stops anyone adding a
# second From to a signed message and having the signature still validate.
OversignHeaders         From

# Do NOT sign a message that arrived already signed by someone else, and do
# not let an internal host sign as a domain we hold no key for.
KeyTable                file:$KEYTABLE
SigningTable            refile:$SIGNTABLE
InternalHosts           refile:$TRUSTED
ExternalIgnoreList      refile:$TRUSTED

UserID                  opendkim:opendkim
PidFile                 $RUNDIR/opendkim.pid
EOF

# ---------------------------------------------------------------------------
#  Build the tables from whatever keys are present.
#
#  Prints a count rather than the filenames: the list of customer domains is
#  not something to scatter through container logs.
# ---------------------------------------------------------------------------
build_tables() {
    : > "$KEYTABLE"
    : > "$SIGNTABLE"
    local n=0

    rm -f "$PRIVDIR"/*.key 2>/dev/null || true

    for f in "$KEYDIR"/*.key; do
        [ -e "$f" ] || continue

        local base fqdn selector
        base=$(basename "$f" .key)          # example.com.tv2026a
        selector=${base##*.}                # tv2026a
        fqdn=${base%.*}                     # example.com

        # A file that does not split into both parts is not one of ours.
        # Skipping quietly would be worse than saying so — it is the shape a
        # partially written or hand-copied key takes.
        if [ -z "$fqdn" ] || [ -z "$selector" ] || [ "$fqdn" = "$base" ]; then
            echo "[opendkim] ignoring $(basename "$f"): expected <domain>.<selector>.key"
            continue
        fi

        # Copy while we are still root, then hand it to the daemon's user.
        local priv="$PRIVDIR/$base.key"
        if ! cp "$f" "$priv" 2>/dev/null; then
            echo "[opendkim] could not read $(basename "$f") — skipping"
            continue
        fi
        chown opendkim:opendkim "$priv" 2>/dev/null || true
        chmod 600 "$priv"

        # KeyTable:     name  domain:selector:/path/to/key
        # SigningTable: pattern  name
        #
        # The pattern is *@domain, so every address at that domain signs with
        # that domain's key. Subdomains are NOT matched — hence SubDomains no
        # above. Signing mail from a subdomain with the parent's key produces a
        # valid signature that DMARC still rejects for misalignment, and that
        # is far harder to diagnose than no signature at all.
        printf '%s %s:%s:%s\n' "$base" "$fqdn" "$selector" "$priv" >> "$KEYTABLE"
        printf '*@%s %s\n' "$fqdn" "$base" >> "$SIGNTABLE"
        n=$((n + 1))
    done

    chown opendkim:opendkim "$KEYTABLE" "$SIGNTABLE" 2>/dev/null || true
    chmod 640 "$KEYTABLE" "$SIGNTABLE" 2>/dev/null || true
    echo "$n"
}

# ---------------------------------------------------------------------------
#  Development keys.
#
#  The local stack has no API container, so nothing materialises keys there and
#  CI would test a signer with nothing to sign with — which would pass happily
#  while proving nothing. Generate throwaway keys for the seeded domains, but
#  ONLY when TATVAOS_ENV is local.
#
#  Guarded rather than unconditional on purpose: a server that quietly invented
#  its own key would sign with something no DNS record matches, and every
#  signature would fail verification while the logs looked healthy.
# ---------------------------------------------------------------------------
if [ "${TATVAOS_ENV:-local}" = "local" ]; then
    for dev in techvein.local abcschool.local; do
        target="$KEYDIR/${dev}.tv2026a.key"
        if [ ! -f "$target" ]; then
            if openssl genrsa -out "$target" 2048 >/dev/null 2>&1; then
                chmod 600 "$target"
                echo "[opendkim] generated a DEVELOPMENT key for $dev"
            else
                # The volume is read-only in this container by design. On the
                # local stack it is writable; if it is not, say so rather than
                # leaving the operator to wonder why nothing is signed.
                echo "[opendkim] could not write a dev key for $dev (read-only volume?)"
            fi
        fi
    done
fi

count=$(build_tables)
echo "[opendkim] signing $count domain(s) from $KEYDIR"

if [ "$count" -eq 0 ]; then
    # Not fatal. A fresh install has no domains yet, and refusing to start
    # would take Postfix down with it — main.cf tolerates a missing milter,
    # but only if the milter is reachable and answering.
    echo "[opendkim] WARNING: no keys present. Outbound mail will be UNSIGNED"
    echo "[opendkim] until a domain is added in the console."
fi

# ---------------------------------------------------------------------------
#  Watch for new keys.
#
#  A customer who adds a domain should not wait for the next deploy to have
#  their mail signed. Sixty seconds is short enough that nobody notices and
#  long enough that this is free.
# ---------------------------------------------------------------------------
watch_keys() {
    local last
    last=$(cat "$KEYTABLE")
    while sleep 60; do
        build_tables >/dev/null
        local now
        now=$(cat "$KEYTABLE")
        if [ "$now" != "$last" ]; then
            last="$now"
            echo "[opendkim] key set changed — reloading"
            # SIGUSR1 makes OpenDKIM re-read its data sets without dropping
            # connections, so a message being signed right now is unaffected.
            pkill -USR1 -x opendkim 2>/dev/null || true
        fi
    done
}

watch_keys &

echo "[opendkim] starting on :8891"
exec opendkim -f -x "$CONF"
