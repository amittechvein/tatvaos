#!/usr/bin/env bash
#
# Runs tests/migration-mail-tls against a Dovecot in its PRODUCTION mode.
#
# Starts tv-dovecot-prodtls from the local stack's Dovecot image, on its
# network and mail volume, then applies the production overlay copied
# VERBATIM out of local/dovecot/entrypoint.sh (ssl = yes,
# disable_plaintext_auth = yes) - the image's entrypoint itself refuses the
# development database password outside "local", so the overlay is applied
# after start and Dovecot reloaded. A throwaway CA signs a certificate for
# mail.tatvaos.test; the migration master login is turned on in that
# container only. Everything is removed at the end, pass or fail.
#
# Needs the local stack (docker compose in local/) and openssl.
# Exit 0 pass, 1 fail, 2 could not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
C=tv-dovecot-prodtls; PORT="${TLS_TEST_PORT:-2143}"; NAME=mail.tatvaos.test
T="$(mktemp -d)"; chmod 700 "$T"; mkdir -p "$T/certs"
cleanup() { docker rm -f "$C" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT

IMG=$(docker inspect tv-dovecot --format '{{.Config.Image}}' 2>/dev/null) || { echo "  tv-dovecot is not running - start the local stack"; exit 2; }
NET=$(docker inspect tv-dovecot --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
VOL=$(docker inspect tv-dovecot --format '{{range .Mounts}}{{if eq .Destination "/var/mail/vhosts"}}{{.Name}}{{end}}{{end}}')

( cd "$T/certs" \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Migration TLS test CA" -keyout ca.key -out ca.pem \
  && openssl req -newkey rsa:2048 -nodes -subj "/CN=$NAME" -keyout privkey.pem -out s.csr \
  && printf "subjectAltName=DNS:%s\n" "$NAME" > ext \
  && openssl x509 -req -in s.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile ext -out fullchain.pem \
  && chmod 644 *.pem ) >/dev/null 2>&1 || { echo "  could not make the test certificate"; exit 2; }
awk "/cat > \"\\\$OVR\" <<'EOF'/{f=1;next} /^EOF\$/{f=0} f" "$HERE/local/dovecot/entrypoint.sh" > "$T/overlay.conf"
grep -q "disable_plaintext_auth = yes" "$T/overlay.conf" || { echo "  could not read the production overlay from entrypoint.sh"; exit 2; }

D="$HERE/local/dovecot"
docker rm -f "$C" >/dev/null 2>&1
docker run -d --name "$C" --network "$NET" -p "$PORT:143" -e TATVAOS_ENV=local \
  -v "$D/dovecot.conf:/etc/dovecot/dovecot.conf:ro" \
  -v "$D/dovecot-sql.conf.ext:/etc/dovecot/dovecot-sql.conf.ext.tmpl:ro" \
  -v "$D/dovecot-sql-app.conf.ext:/etc/dovecot/dovecot-sql-app.conf.ext.tmpl:ro" \
  -v "$T/certs:/certs:ro" -v "$VOL:/var/mail/vhosts" "$IMG" >/dev/null || exit 2
for _ in $(seq 1 30); do docker exec "$C" doveadm service status >/dev/null 2>&1 && break; sleep 1; done
sleep 3
docker cp "$T/overlay.conf" "$C:/etc/dovecot/env-overrides.conf" && docker exec "$C" doveadm reload || exit 2
sleep 2
[ "$(docker exec "$C" doveconf -h disable_plaintext_auth)" = yes ] || { echo "  the production overlay did not take"; exit 2; }
docker exec -e NETS=0.0.0.0/0 "$C" sh -c 'set -e; D=/etc/dovecot/migration; mkdir -p $D
  head -c 33 /dev/urandom | base64 | tr -d "=+/\n" > $D/master.password
  h=$(doveadm pw -s SHA512-CRYPT -p "$(cat $D/master.password)")
  printf "migration:%s::::::allow_nets=%s\n" "$h" "$NETS" > $D/master.passwd
  chown root:dovecot $D/master.passwd; chmod 640 $D/master.passwd; doveadm reload' || exit 2
docker exec "$C" cat /etc/dovecot/migration/master.password > "$T/master"; chmod 600 "$T/master"

printf "  tree under test: %s%s\n" "$(git -C "$HERE" rev-parse HEAD)" \
    "$(git -C "$HERE" diff --quiet HEAD || echo ' (+ UNCOMMITTED CHANGES - not a proof of any commit)')"
TLS_PORT="$PORT" MASTER_FILE="$T/master" CA_FILE="$T/certs/ca.pem" TLS_NAME="$NAME" \
  dotnet run --project "$HERE/tests/migration-mail-tls"
