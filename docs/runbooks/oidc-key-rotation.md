# Runbook — rotating the OpenID Connect signing key

*Decision 0004. Every 90 days, or immediately if the key may have been seen by
anyone. Written 17 Sept 2026; exercised on the local stack the same day by
`tests/oidc/stage2-discovery.sh`, and on production on 17 Sept 2026, before the first customer
connects (recorded below — a runbook nobody has executed is not a runbook).*

## What rotation does

The API keeps its RSA keys as PEM files in the `oidckeys` volume, mounted at
`/oidc` in the API container and nowhere else. The newest active signing key
signs every ID token. Rotation writes a new active key, marks the previous
one **retired**, and keeps the retired one **published** in the key set for
one day so an ID token signed a moment before the rotation still verifies (ID
tokens live five minutes). After that day the API deletes the retired file on
its next start.

Nothing long-lived is signed, so nothing long-lived breaks. Relying parties
fetch the key set again when they meet a `kid` they do not know.

## Steps, on the server, as the deploy user

1. See what is published now:

   ```bash
   curl -s https://core.tatvaos.com/api/oauth/jwks | python3 -c "import sys,json; print([k['kid'] for k in json.load(sys.stdin)['keys']])"
   ```

2. Rotate. This runs the API binary once, in its own container, against the
   same volume, and prints only the two key ids:

   ```bash
   cd /srv/tatvaos-production
   docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml run --rm --no-deps api dotnet TatvaOS.Api.dll --oidc-rotate
   ```

   Expected: `oidc: new signing key <kid> is active; <old kid> retired, published for one more day.`

3. Restart the API so it loads the new key:

   ```bash
   docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml restart api
   ```

4. Prove it, from the laptop. Both kids present, the new one first:

   ```bash
   curl -s https://core.tatvaos.com/api/oauth/jwks | python3 -c "import sys,json; print([k['kid'] for k in json.load(sys.stdin)['keys']])"
   ```

   and the API's own startup line names the new key:

   ```bash
   ssh deploy@172.105.57.198 'docker logs tatvaos-api-1 2>&1 | grep "oidc: issuer" | tail -1'
   ```

5. Record it here.

## What must never happen during this

- The private key is never printed, copied to a laptop, pasted anywhere, or
  backed up. `--oidc-rotate` prints kids only; `backup.sh` skips the volume on
  purpose and says so.
- Do not delete the retired file by hand. The API deletes it after its day;
  deleting it early breaks any ID token signed in the last five minutes.
- Do not rotate the `enc-*.pem` key. It is OpenIddict's own payload
  encryption key, never published; a token it cannot open fails closed and
  every outstanding refresh token would be refused at once.

## If the key is compromised

Rotate as above, then delete the retired file immediately (`rm /oidc/sig-*.retired-*.pem`
inside the container, then restart). Every ID token signed with the old key
stops verifying at once; that is the point. Tell the CTO.

## Record of rotations

| Date | Where | Old kid | New kid | By |
|---|---|---|---|---|
| 2026-09-17 | local stack, via the stage 2 test | (per run) | (per run) | developer |
| 2026-09-17 09:35 UTC | production, first rotation, before any customer connects (steps 1-4 as written; API back on health in ~10 s; both kids published, new one first) | hopz3hlnfTpa3P2y | 4Z9b4haC-jJ4T9Fu | Core session, on the CTO's post-deploy list for c1ec4b5 |

**What the 17 Sept production row did and did not test (CTO, 17 Sept).** It
rehearsed the mechanism: the file layout, the one-off container, the
restart, the key set publishing both kids with the new one first. It did
NOT test the interesting case, a key that relying parties have already
fetched and cached, because there were no relying parties yet — the
retired key was minutes old and nobody had ever asked for it. The first
rotation after the first customer connects is the one that proves the
one-day overlap works; read this row as proof of the runbook's steps, not
of that.
