#!/usr/bin/env bash
#
# TatvaOS Mail — Phase 0 mail server provisioning
#
# Turns a fresh Ubuntu 24.04 Linode into a hardened, DKIM-signing outbound
# mail server. Phase 0 only — Postfix and OpenDKIM, nothing else. Dovecot,
# Postgres and Rspamd arrive in Phase 1, on a larger instance.
#
#   sudo ./provision-mail-server.sh
#
# Idempotent. Re-running repairs rather than duplicates.

set -uo pipefail

MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.tatvaos.com}"
MAIL_DOMAIN="${MAIL_DOMAIN:-tatvaos.com}"
DKIM_SELECTOR="${DKIM_SELECTOR:-tv2026a}"
ADMIN_EMAIL="${ADMIN_EMAIL:-postmaster@tatvaos.com}"

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); X=$(c $'\033[0m')

step() { printf '\n%s>> %s%s\n' "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
skip() { printf '   %s[have]%s %s\n' "$D" "$X" "$1"; }
warn() { printf '   %s[warn]%s %s\n' "$Y" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; }

[ "$(id -u)" -eq 0 ] || { bad "run with sudo"; exit 1; }

printf '\n%s  TatvaOS Mail — Phase 0 provisioning%s\n' "$C" "$X"
printf '   host:     %s\n'  "$MAIL_HOSTNAME"
printf '   domain:   %s\n'  "$MAIL_DOMAIN"
printf '   selector: %s\n\n' "$DKIM_SELECTOR"

# ---------------------------------------------------------------------------
step "1/9  Hostname"
# Postfix announces this in EHLO. It MUST match the PTR record or receivers
# treat the mismatch as a spam signal.
if [ "$(hostname -f 2>/dev/null)" = "$MAIL_HOSTNAME" ]; then
    skip "already $MAIL_HOSTNAME"
else
    hostnamectl set-hostname "$MAIL_HOSTNAME"
    IP=$(hostname -I | awk '{print $1}')
    grep -q "$MAIL_HOSTNAME" /etc/hosts || \
        echo "$IP $MAIL_HOSTNAME ${MAIL_HOSTNAME%%.*}" >> /etc/hosts
    ok "set to $MAIL_HOSTNAME"
fi

# ---------------------------------------------------------------------------
step "2/9  Swap"
# 1 GB instance. Swap turns an OOM kill into slowness, which is recoverable.
if swapon --show | grep -q '/swapfile'; then
    skip "swap active"
else
    fallocate -l 2G /swapfile && chmod 600 /swapfile
    mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "2 GB swap"
fi

# ---------------------------------------------------------------------------
step "3/9  Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Preseed so Postfix does not open an interactive dialog mid-script
debconf-set-selections <<< "postfix postfix/mailname string $MAIL_HOSTNAME"
debconf-set-selections <<< "postfix postfix/main_mailer_type string 'Internet Site'"
apt-get install -y -qq \
    postfix opendkim opendkim-tools \
    ufw fail2ban unattended-upgrades \
    swaks dnsutils mailutils curl ca-certificates >/dev/null 2>&1 \
    && ok "installed" || bad "package install failed"

# ---------------------------------------------------------------------------
step "4/9  Firewall"
if ufw status | grep -q 'Status: active'; then
    skip "ufw already active"
else
    ufw --force reset >/dev/null 2>&1
    ufw default deny incoming  >/dev/null
    ufw default allow outgoing >/dev/null
    ufw allow 22/tcp  >/dev/null   # ssh
    ufw allow 25/tcp  >/dev/null   # inbound smtp
    ufw allow 587/tcp >/dev/null   # submission
    ufw allow 80/tcp  >/dev/null   # certbot http-01
    ufw allow 443/tcp >/dev/null
    ufw --force enable >/dev/null
    ok "22, 25, 587, 80, 443 open; everything else denied"
fi

systemctl enable --now fail2ban >/dev/null 2>&1 && ok "fail2ban running"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 \
    && ok "unattended security upgrades on"

# ---------------------------------------------------------------------------
step "5/9  OpenDKIM"
# Chosen over Rspamd for Phase 0: ~15 MB rather than ~400 MB, and signing is
# the only thing needed here. Rspamd arrives in Phase 1 for inbound scoring.
mkdir -p /etc/opendkim/keys/$MAIL_DOMAIN

if [ -f "/etc/opendkim/keys/$MAIL_DOMAIN/$DKIM_SELECTOR.private" ]; then
    skip "DKIM key already present"
else
    warn "DKIM private key not installed yet"
    printf '          Copy it from the repo, then re-run:\n'
    printf '            scp infra/dkim/%s.key root@<ip>:/etc/opendkim/keys/%s/%s.private\n' \
           "$DKIM_SELECTOR" "$MAIL_DOMAIN" "$DKIM_SELECTOR"
fi

cat > /etc/opendkim.conf <<EOF
Syslog                  yes
UMask                   007
Mode                    sv
SubDomains              no
AutoRestart             yes
AutoRestartRate         10/1h
Canonicalization        relaxed/simple
OversignHeaders         From
Socket                  inet:8891@localhost
PidFile                 /run/opendkim/opendkim.pid
UserID                  opendkim
KeyTable                /etc/opendkim/key.table
SigningTable            refile:/etc/opendkim/signing.table
ExternalIgnoreList      /etc/opendkim/trusted.hosts
InternalHosts           /etc/opendkim/trusted.hosts
EOF

echo "${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN} ${MAIL_DOMAIN}:${DKIM_SELECTOR}:/etc/opendkim/keys/${MAIL_DOMAIN}/${DKIM_SELECTOR}.private" \
    > /etc/opendkim/key.table
echo "*@${MAIL_DOMAIN} ${DKIM_SELECTOR}._domainkey.${MAIL_DOMAIN}" \
    > /etc/opendkim/signing.table
printf '127.0.0.1\nlocalhost\n%s\n' "$MAIL_HOSTNAME" > /etc/opendkim/trusted.hosts

chown -R opendkim:opendkim /etc/opendkim
chmod 600 /etc/opendkim/keys/$MAIL_DOMAIN/*.private 2>/dev/null || true
mkdir -p /run/opendkim && chown opendkim:opendkim /run/opendkim
ok "opendkim configured"

# ---------------------------------------------------------------------------
step "6/9  Postfix"
# Comments live on their OWN lines. Postfix has no trailing-comment syntax -
# everything after '=' is the value. See docs/runbooks/01.
cat > /etc/postfix/main.cf <<EOF
compatibility_level = 3.6

myhostname = $MAIL_HOSTNAME
mydomain = $MAIL_DOMAIN
myorigin = \$mydomain
mydestination = \$myhostname, localhost.\$mydomain, localhost

inet_interfaces = all
inet_protocols = ipv4

# Phase 0 sends only. Phase 1 replaces this with virtual domains from Postgres.

# THIS LIST TRUSTS NOBODY. Port 25 accepts mail FOR us, never FROM us.
# Beginning it with permit_mynetworks is how you create an open relay.
smtpd_recipient_restrictions =
    reject_unauth_destination
    reject_unlisted_recipient
    permit

smtpd_helo_required = yes
mynetworks = 127.0.0.0/8 [::1]/128
disable_vrfy_command = yes

# DKIM signing via OpenDKIM milter
milter_default_action = accept
milter_protocol = 6
smtpd_milters = inet:localhost:8891
non_smtpd_milters = inet:localhost:8891

# Opportunistic TLS outbound. Receivers score this, and it costs nothing.
smtp_tls_security_level = may
smtp_tls_loglevel = 1
smtp_tls_CApath = /etc/ssl/certs
smtpd_tls_security_level = may
smtpd_tls_cert_file = /etc/ssl/certs/ssl-cert-snakeoil.pem
smtpd_tls_key_file = /etc/ssl/private/ssl-cert-snakeoil.key
smtpd_tls_loglevel = 1

# 25 MB, the same limit Gmail enforces
message_size_limit = 26214400

biff = no
append_dot_mydomain = no
readme_directory = no
smtputf8_enable = yes
EOF

postfix check 2>&1 | sed 's/^/   /' || warn "postfix check reported issues"
ok "main.cf written"

# ---------------------------------------------------------------------------
step "7/9  TLS certificate"
# A real certificate materially improves inbound TLS and mail-tester scoring.
if [ -f "/etc/letsencrypt/live/$MAIL_HOSTNAME/fullchain.pem" ]; then
    skip "certificate already present"
elif command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot >/dev/null 2>&1; then
    if certbot certonly --standalone --non-interactive --agree-tos \
        -m "$ADMIN_EMAIL" -d "$MAIL_HOSTNAME" >/dev/null 2>&1; then
        postconf -e "smtpd_tls_cert_file=/etc/letsencrypt/live/$MAIL_HOSTNAME/fullchain.pem"
        postconf -e "smtpd_tls_key_file=/etc/letsencrypt/live/$MAIL_HOSTNAME/privkey.pem"
        ok "Let's Encrypt certificate issued"
    else
        warn "certbot failed - continuing with the self-signed cert"
        warn "usually means port 80 is closed or DNS has not propagated"
    fi
fi

# ---------------------------------------------------------------------------
step "8/9  Start services"
systemctl enable opendkim postfix >/dev/null 2>&1
systemctl restart opendkim && ok "opendkim running" || bad "opendkim failed to start"
systemctl restart postfix  && ok "postfix running"  || bad "postfix failed to start"

# ---------------------------------------------------------------------------
step "9/9  Self-check"

pass=0; fail=0
chk() { if eval "$2" >/dev/null 2>&1; then ok "$1"; pass=$((pass+1)); else bad "$1"; fail=$((fail+1)); fi; }

chk "hostname matches"        "[ \"\$(hostname -f)\" = \"$MAIL_HOSTNAME\" ]"
chk "postfix listening on 25" "ss -ltn | grep -q ':25 '"
chk "opendkim on 8891"        "ss -ltn | grep -q ':8891 '"
chk "DKIM key readable"       "[ -r /etc/opendkim/keys/$MAIL_DOMAIN/$DKIM_SELECTOR.private ]"
chk "PTR forward-confirms"    "[ \"\$(dig -x \$(hostname -I | awk '{print \$1}') +short | sed 's/\.$//')\" = \"$MAIL_HOSTNAME\" ]"

printf '\n   outbound port 25: '
if timeout 8 bash -c "(echo > /dev/tcp/gmail-smtp-in.l.google.com/25)" 2>/dev/null; then
    printf '%sOPEN%s\n' "$G" "$X"; pass=$((pass+1))
else
    printf '%sBLOCKED%s\n' "$R" "$X"
    printf '   %sLinode has not lifted the SMTP restriction yet. Everything else is\n' "$D"
    printf '   ready — re-run the self-check once they respond.%s\n' "$X"
    fail=$((fail+1))
fi

printf '\n%s%s%s\n' "$C" "==================================================" "$X"
printf '   checks passed: %s%d%s   failed: %s%d%s\n\n' "$G" "$pass" "$X" \
       "$([ $fail -gt 0 ] && echo "$R" || echo "$D")" "$fail" "$X"

if [ "$fail" -eq 0 ]; then
    printf '   Server is ready. Run the deliverability test:\n'
    printf '     %s./deliverability-test.sh%s\n\n' "$D" "$X"
else
    printf '   Fix the failures above, then re-run this script.\n\n'
fi
