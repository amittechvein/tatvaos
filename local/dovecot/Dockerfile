# Dovecot with PostgreSQL auth.
# Debian bookworm ships Dovecot 2.3.x - the config syntax here targets 2.3.
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        dovecot-core \
        dovecot-imapd \
        dovecot-lmtpd \
        dovecot-pgsql \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Single system user owns every virtual mailbox. Separation between tenants is
# by directory (/var/mail/vhosts/<domain>/<user>), not by Unix uid - which is
# exactly how Google Workspace-style hosting works. The security boundary is
# the application and the database, not the filesystem.
RUN groupadd -g 5000 vmail \
 && useradd  -u 5000 -g vmail -d /var/mail/vhosts -s /usr/sbin/nologin vmail \
 && mkdir -p /var/mail/vhosts \
 && chown -R vmail:vmail /var/mail/vhosts

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 143 24

# The entrypoint renders dovecot-sql.conf.ext from a template so the mail-edge
# database password comes from the environment rather than from source control.
ENTRYPOINT ["/entrypoint.sh"]
