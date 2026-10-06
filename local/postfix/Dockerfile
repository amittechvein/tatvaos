# Postfix with PostgreSQL lookup support.
# Debian bookworm ships Postfix 3.7 - stable and well documented.
FROM debian:bookworm-slim

# python3 + python3-psycopg2: the From-line filter for port 587
# (sender-milter.py, PR 380). Debian's own packages, so nothing is fetched
# from outside the distribution at build time.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        postfix \
        postfix-pgsql \
        ca-certificates \
        rsyslog \
        python3 \
        python3-psycopg2 \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY sender-milter.py /usr/local/lib/tatvaos/sender-milter.py
RUN chmod +x /entrypoint.sh

EXPOSE 25 587

ENTRYPOINT ["/entrypoint.sh"]
