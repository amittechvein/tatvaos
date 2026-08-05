# OpenDKIM — outbound signing only.
#
# Chosen over Rspamd for this job: about 15 MB rather than 400, and signing is
# the only thing needed here. Rspamd arrives separately for inbound scoring,
# where its size buys something.
FROM debian:bookworm-slim

# openssl  — generates the throwaway development keys, and is what you reach
#            for when checking a signature by hand.
# procps   — pkill, used to signal a reload when the key set changes.
#
# Comments sit above the RUN rather than inside it. Some Dockerfile parsers
# accept a comment between continuation lines and some do not, and a build
# that fails only on the CI runner is not worth the tidier layout.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        opendkim \
        opendkim-tools \
        openssl \
        procps \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Postfix reaches the milter over the Docker network rather than a Unix socket,
# because a socket would mean sharing a writable volume between the two
# containers purely to pass a file handle.
EXPOSE 8891

ENTRYPOINT ["/entrypoint.sh"]
