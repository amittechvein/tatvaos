# Promoting 172.105.57.198 from staging to production

**Status:** DNS is done. This is what remains.

The box that has been serving `staging.tatvaos.com` becomes production. Two
things about that are worth saying plainly before the commands:

1. **There is no staging afterwards.** Until a second Linode exists, every
   change is tested in front of whoever is using the product. The local stack
   in `local/` is the only rehearsal, and it does not exercise real DNS, real
   TLS or real SMTP — which is where most deploy problems live.

2. **Outbound mail stops being contained.** Today Postfix relays everything to
   Mailpit and nothing escapes. The production overlay sets
   `RELAY_TO_MAILPIT=false`, and from that moment a bug that sends mail sends
   it to real people. That is the point of production, but it is a one-way
   door for any given message.

---

## Where DNS stands

Checked against Google Public DNS. All correct unless marked.

| Record | Value | |
|---|---|---|
| `core.tatvaos.com` A | `172.105.57.198` | good |
| `mail.tatvaos.com` A | `172.105.57.198` | good — moved off Bluehost |
| `mx.tatvaos.com` A | `172.105.57.198` | good |
| `staging.tatvaos.com` A | `172.105.57.198` | same box; now redirects to Core |
| SPF `tatvaos.com` | `v=spf1 include:_spf.tatvaos.com -all` | good |
| SPF `_spf.tatvaos.com` | `v=spf1 ip4:172.105.57.198 -all` | good |
| DKIM `tv2026a._domainkey` | 2048-bit RSA published | good |
| DMARC `_dmarc` | `p=none; rua=mailto:dmarc@tatvaos.com` | good for now |
| MX `tatvaos.com` | `10 mx.tatvaos.com` | good |
| PTR for 172.105.57.198 | `mx.tatvaos.com` | set; propagating |

### All DNS is now in place

`nslookup 172.105.57.198` returns `mx.tatvaos.com`, which is the answer that
matters — the PTR is set. Google Public DNS was still serving
`linodeusercontent.com` at the time of writing, because Linode's reverse zone
is served by several authoritative nameservers and they update at different
times. The TTL is 300 seconds, so it converges on its own; no action needed.

Before opening the SMTP ticket, confirm it has finished spreading:

```powershell
nslookup 172.105.57.198 8.8.8.8
nslookup 172.105.57.198 1.1.1.1
```

Both must say `mx.tatvaos.com`. Linode support will check from their side, and
a half-propagated PTR is the kind of thing that gets a ticket bounced back with
a day's delay attached.

**Why this record carries so much weight.** A valid SPF and a published DKIM
key get you nothing if the reverse lookup says `linodeusercontent.com`. Gmail
and Outlook both check that the PTR resolves forward to the same IP as the HELO
name — so `mx.tatvaos.com` → `172.105.57.198` → `mx.tatvaos.com` has to close
the loop. It now does.

---

## 1 · Check Bluehost before anything else

`tatvaos.com`'s MX has always been `10 mail.tatvaos.com`. Repointing that A
record from Bluehost to Linode moved mail delivery **without changing the MX
record** — so if mailboxes existed there, mail to `@tatvaos.com` is bouncing
right now and has been since the change.

Log into Bluehost cPanel → **Email Accounts**. If any account has messages in
it, stop and put `mail.tatvaos.com` back to `162.214.80.55` until TatvaOS Mail
is actually accepting mail on port 25, then cut over deliberately.

If the list is empty, nothing was lost. Continue.

---

## 2 · Linode Cloud Manager — done

Recorded for the next domain, since both are easy to get wrong:

**Reverse DNS.** Linodes → your Linode → **Network** → **IP Addresses** → the
`⋯` menu on the specific IPv4 → **Edit RDNS** → `mx.tatvaos.com`. It is set
per-address, so on a Linode with several IPv4s it has to be the one mail leaves
from.

**MX record.** Domains → `tatvaos.com` → MX:

| Field | Value |
|---|---|
| Mail server | `mx.tatvaos.com` |
| Priority | `10` |
| Subdomain | *(blank)* |

The priority goes in the priority field. Typing `10 mx.tatvaos.com` into the
host field creates a record for a host literally named `10mx` — the exact
mistake found on `trineetra.com`, where a wildcard record hid it for a while.

---

## 3 · Push the code

**Machine:** Windows PowerShell · **Directory:** `C:\Users\amitd\Downloads\tatvaOS`

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git add -A
git commit -m "Core/Mail production hostnames, multi-account switching, departments UI"
git push origin main
```

---

## 4 · On the server — back up first

**Machine:** the Linode, over SSH · **Directory:** `/srv/tatvaos-testing`

```bash
ssh deploy@172.105.57.198
cd /srv/tatvaos-testing

# Everything, including roles and the mail store metadata.
docker compose \
  -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.testing.yml \
  --env-file infra/docker/.env \
  exec -T postgres pg_dumpall -U postgres > ~/staging-final-$(date +%F).sql

ls -lh ~/staging-final-*.sql
```

Do not continue until that file has a sensible size. It is the only copy of
the verified `trineetra.com` domain and the tenants created during testing.

**The DKIM private key is in this checkout** at `infra/dkim/tv2026a.key`, and
it is gitignored — it exists nowhere else. The public half is already published
in DNS as `tv2026a._domainkey`. Losing it means every signature fails until a
new key is generated and published.

```bash
cp infra/dkim/tv2026a.key ~/tv2026a.key.backup
chmod 600 ~/tv2026a.key.backup
```

---

## 5 · Move the checkout

Safe to rename. `docker-compose.base.yml` pins `name: tatvaos`, so the Compose
project — and therefore the volume names — do not follow the directory. The
database and the mail store survive the move. (Take the dump anyway; it is the
only backup, and it is the first time this path has been exercised.)

```bash
cd /srv/tatvaos-testing

# Stop cleanly. Volumes are NOT removed — the old data stays on disk under
# tatvaos-testing_* until you delete it deliberately.
docker compose \
  -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.testing.yml \
  --env-file infra/docker/.env down

cd /srv
sudo mv tatvaos-testing tatvaos-production
cd tatvaos-production

git fetch --all --prune
git reset --hard origin/main

# The guard deploy.sh checks. Without updating it the deploy refuses to run,
# which is the guard working.
echo production > .environment
```

---

## 6 · Fill in the production environment file

```bash
cd /srv/tatvaos-production
cp infra/docker/.env infra/docker/.env.staging-backup   # keep the old secrets
cp infra/docker/.env.production.example infra/docker/.env
nano infra/docker/.env
```

Reuse the passwords from `.env.staging-backup` **only if** you are restoring
the old database — the roles inside the dump were created with those. If you
are starting clean, generate new ones:

```bash
openssl rand -base64 32
```

What must be right:

| Key | Value |
|---|---|
| `SITE_DOMAIN` | `core.tatvaos.com` |
| `PUBLIC_API_URL` | `https://core.tatvaos.com/api` |
| `JWT_ISSUER` | `https://core.tatvaos.com` |
| `MAIL_DOMAIN` | `mail.tatvaos.com` |
| `AUTH_COOKIE_DOMAIN` | `.tatvaos.com` |
| `BOOTSTRAP_ADMIN_EMAIL` | `amit@techvein.com` |
| `BOOTSTRAP_ADMIN_PASSWORD` | a long one, used once, then changed |
| `TATVAOS_ENV` | `production` |
| `MAILEDGE_DB_PASSWORD` | a fresh `openssl rand -base64 32` |
| `MAIL_HOSTNAME` | `mx.tatvaos.com` — must equal the PTR |
| `RELAY_HOST` | empty, unless warming up through a smart host |

`MAILEDGE_DB_PASSWORD` is new. Postfix and Dovecot used to read `dev_mail_pw`
out of files committed to the repo; they now render their config from this
variable at container start, and the schema rotates the `tatvaos_mailedge` role
from the same value so both halves move together. Leave it unset and those two
containers refuse to start — deliberately, because starting on a published
password while reporting healthy is the worse outcome.

`TATVAOS_ENV=production` is what arms that refusal. With it set to `local` (the
default) they fall back to the development password, which is right on a laptop
and wrong everywhere else.

`AUTH_COOKIE_DOMAIN` is what makes one sign-in cover both hosts. Without it the
session cookie is host-only, you sign into Core, and Mail asks you to sign in
again. Leave it empty for any domain where a host is not ours — the refresh
cookie is sent to every host under it.

---

## 7 · Deploy

```bash
cd /srv/tatvaos-production
./infra/scripts/deploy.sh production
```

It will ask you to type `production`. It takes its own backup first and stops
if that fails.

Then, only if you want the old data back:

```bash
docker compose \
  -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.production.yml \
  --env-file infra/docker/.env \
  exec -T postgres psql -U postgres < ~/staging-final-*.sql
```

Restoring brings the test tenants back with it. A clean start plus re-adding
`tatvaos.com` and `trineetra.com` is usually the better trade — re-verification
is one click now that every DNS record is already published.

---

## 8 · Check it before trusting it

```bash
curl -s https://core.tatvaos.com/health          # {"status":"ok"}
curl -s https://core.tatvaos.com/health/db       # 200
curl -sI https://mail.tatvaos.com/ | head -1     # 308 to /mail/f-inbox
curl -sI https://staging.tatvaos.com/ | head -1  # 308 to core

# HELO name must be mx.tatvaos.com
docker compose -f infra/docker/docker-compose.base.yml \
               -f infra/docker/docker-compose.production.yml \
               --env-file infra/docker/.env \
               exec postfix postconf myhostname

# The mail edge must NOT be using the development password.
docker compose -f infra/docker/docker-compose.base.yml \
               -f infra/docker/docker-compose.production.yml \
               --env-file infra/docker/.env \
               exec postfix grep -c dev_mail_pw /etc/postfix/sql/virtual-domains.cf
# Expect 0. A 1 means the render did not happen and the role rotation did,
# so every recipient lookup is about to fail.

# And the containment relay must be GONE. Any output here is a problem.
docker compose -f infra/docker/docker-compose.base.yml \
               -f infra/docker/docker-compose.production.yml \
               --env-file infra/docker/.env \
               exec postfix postconf relayhost | grep -i mailpit
```

That last check is the one to run twice. `relayhost = [mailpit]:1025` is what
has been stopping test mail from reaching real people. It must be absent in
production — and it must never be removed from the local and testing configs.

---

## 9 · The SMTP unblock ticket

Linode blocks outbound port 25 on new accounts. Nothing sends until they lift
it, and they will not lift it before the PTR is set.

Open a support ticket and include:

- The Linode's IP and the reverse DNS now set to `mx.tatvaos.com`
- What the service is: a multi-tenant business email platform for Indian
  organisations, sending only on behalf of customers who own their domains
- **The abuse control**, which is the part that gets the ticket approved: a
  tenant cannot send to an external address until they have proved ownership
  of the sending domain *and* pointed its MX at us. It is enforced in Postfix
  by the `mail.senders_allowed_external` view, not in application code, so it
  cannot be bypassed by a bug in the API.
- SPF, DKIM and DMARC are all published and can be verified from outside.

That last claim has to stay true. Weakening the outbound gate makes the answer
we gave Linode untrue, which is a much worse problem than a blocked port.

---

## What was found while preparing this

Three things in the deployed mail config would have broken production. All are
fixed; recorded because the shape of the mistake will recur.

**The deployed config was a second copy, and it had drifted.** `infra/postfix/`
and `infra/dovecot/` held their own versions of the SQL lookup files. Those
still queried `domains`, `mailboxes`, `tenants` — the pre-restructure names.
Everything has lived in `core.*` and `mail.*` for a while, and no `search_path`
is set for `tatvaos_mailedge`, so every recipient lookup on a server would have
failed with "relation does not exist" and all inbound mail would have been
rejected. CI builds `local/`, so it passed 17/17 the whole time.

**Dovecot's deployed query had a security hole.** It selected
`m.password_hash`, a column renamed to `imap_password_hash`, and it omitted the
`u.status = 'active'` check entirely. A person suspended in Core would still
have authenticated to IMAP — which is precisely the promise that putting
identity in Core is supposed to buy.

**`RELAY_TO_MAILPIT` was connected to nothing.** Both copies of `main.cf`
hardcoded `relayhost = [mailpit]:1025` and `myhostname = mail.techvein.local`.
The production overlay set `RELAY_TO_MAILPIT: "false"`, no code read it, and
production would have announced itself as a `.local` host and deferred every
message to a container that does not exist there.

There is now one `main.cf`, one `master.cf`, one set of lookup files and one
Dovecot config, all under `local/`, all built and exercised by CI. The values
that legitimately differ per environment are rewritten at container start.
Postfix refuses to start if `myhostname` is still a `.local` name outside
development, and refuses to start if the mail-edge password is missing.

**The lesson, for the fourth time:** two copies of one thing, the fix lands in
one, and the tested one is the other. It has now happened with the isolation
scripts, the theme accent, the Postfix configs and the Dovecot query. When
something must differ per environment, template the difference — do not fork
the file.

---

## Still open

- The outbound gate has **never been asserted in a test**. It is the control
  the SMTP ticket rests on, and a gate nobody tested is a gate that might be
  off. Write the test before the first customer sends.
- `dmarc@tatvaos.com` receives the DMARC aggregate reports. It needs to be a
  real mailbox or the reports bounce and the monitoring is decorative.
- DMARC is `p=none`, which observes and enforces nothing. Move to
  `p=quarantine` once the reports show a week of clean authentication.
