# TatvaOS Mail — Local Development Stack

A complete, self-contained mail platform running on your machine. Real Postfix, real Dovecot, real PostgreSQL with real tenant isolation — and **no ability to reach the internet**.

This is Sprint 0.1–0.3 of the delivery plan, minus the parts that require a public IP.

---

## Quick start

```bash
# inside WSL, from this directory
docker compose up -d --build          # first run: ~3 minutes
./scripts/test-mail.sh                # proves the loop works
./scripts/test-isolation.sh           # proves tenants cannot see each other
```

Then open **http://localhost:8025** — every outbound message lands there.

---

## What is running

| Service | Host port | Purpose |
|---|---|---|
| **postfix** | `2525` (SMTP), `5870` (submission) | MTA. Virtual domains, mailboxes and aliases all resolved from PostgreSQL |
| **dovecot** | `1143` (IMAP) | Mail store and IMAP server. Authenticates against PostgreSQL |
| **postgres** | `5432` | Schema, tenants, RLS |
| **redis** | `6379` | Cache and job queue |
| **mailpit** | `8025` (web UI) | Catches all outbound. The reason nothing escapes |
| rspamd | `11334` | Optional: `docker compose --profile spam up -d` |
| adminer | `8080` | Optional: `docker compose --profile tools up -d` |

---

## Nothing can reach the real internet

Three independent safeguards, because one is not enough when the failure mode is emailing strangers from a test script:

1. `relayhost = [mailpit]:1025` in `postfix/main.cf` — every outbound message goes to Mailpit, which is a dead end with a web UI.
2. All seed domains end in `.local`, which cannot resolve publicly.
3. `reject_unauth_destination` — Postfix refuses to relay for any domain it does not own, so the stack is not an open relay even if someone points a client at it.

**Removing the `relayhost` line is what makes test messages go to real people.** It is one line, and it is the one line to leave alone until Phase 4.

---

## The design point worth understanding

The interesting part of this stack is not that it delivers mail. It is *where the tenant boundary sits*.

**The MTA is inherently cross-tenant.** An SMTP connection arrives with no authentication and no tenant context. Postfix must answer "does this recipient exist *anywhere* on the platform?" before it can reply `250` or `550`. You cannot scope that question to one tenant, because you do not yet know which tenant it is.

So the schema splits in two:

| | Tables | RLS? | Mail edge access |
|---|---|---|---|
| **Routing** | `domains`, `mailboxes`, `aliases`, `tenants` | No | `SELECT` |
| **Content** | `messages`, `folders`, `attachments`, `audit_logs` | Enabled **and forced** | **None** |

And two database roles express it:

- **`tatvaos_app`** — the API. RLS applies. Sees only the tenant in `app.tenant_id`.
- **`tatvaos_mailedge`** — Postfix and Dovecot. `SELECT` on routing tables only.

The consequence: **a fully compromised mail edge leaks the address list, not the mail.** That is the correct blast radius, and it is a deliberate design choice rather than an accident of which grants happened to get written. `test-isolation.sh` asserts both halves — that the mail edge *can* read `mailboxes` (or Postfix rejects everything) and *cannot* read `messages`.

---

## Test accounts

Two tenants, so isolation can actually be demonstrated. One tenant proves nothing.

| Address | Tenant | Notes |
|---|---|---|
| `amit@techvein.local` | Techvein | Aliases: `ceo@`, `director@` |
| `hr@techvein.local` | Techvein | |
| `support@techvein.local` | Techvein | Shared mailbox |
| `principal@abcschool.local` | ABC School | Different tenant |

Password for all: **`devpass123`**

> Local dev hashes are SHA512-CRYPT because every Dovecot build supports it. **Production uses Argon2id** — see architecture §9. Do not carry this scheme forward.

---

## Connect Thunderbird

| Setting | Value |
|---|---|
| Email | `amit@techvein.local` |
| Password | `devpass123` |
| Incoming | IMAP, `localhost`, port **1143**, **no encryption**, normal password |
| Outgoing | SMTP, `localhost`, port **5870**, **no encryption**, no authentication |

Thunderbird will warn about the missing encryption. That is correct — accept it for local dev only. Production terminates TLS on 993/465 and sets `disable_plaintext_auth = yes`.

---

## Everyday commands

```bash
# send a test message
swaks --server localhost:2525 \
      --from someone@example.com --to amit@techvein.local \
      --header "Subject: hello" --body "test"

# watch mail flow in real time
docker compose logs -f postfix dovecot

# psql as the app role, scoped to Techvein
docker exec -it tv-postgres psql -U tatvaos_app -d tatvaos_mail \
  -c "SET app.tenant_id='11111111-1111-1111-1111-111111111111'; SELECT subject FROM messages;"

# what does Postfix think of an address?
docker exec tv-postfix postmap -q "amit@techvein.local" pgsql:/etc/postfix/sql/virtual-mailboxes.cf
docker exec tv-postfix postmap -q "ceo@techvein.local"  pgsql:/etc/postfix/sql/virtual-aliases.cf

# test auth without a client
docker exec tv-dovecot doveadm auth test amit@techvein.local devpass123

# what is actually on disk
docker exec tv-dovecot find /var/mail/vhosts -type f -name "*."

# reset everything, including the database
docker compose down -v && docker compose up -d --build
```

---

## Editing the schema

`postgres/init/*.sql` runs **once**, on an empty data directory only. Editing those files does nothing to a database that already exists.

```bash
docker compose down -v      # -v drops the volume; without it, nothing changes
docker compose up -d
```

This is the single most common source of "my schema change did nothing".

Once the .NET API exists, EF Core migrations take over and these files become seed-only.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Relay access denied` | Recipient domain is not in `domains`, or `is_active = false` |
| `User unknown` | Address not in `mailboxes`, or tenant suspended. Correct behaviour — verify with `postmap -q` |
| Mail accepted but no maildir | Dovecot LMTP unreachable. `docker compose logs dovecot` |
| IMAP auth fails | Check the hash has its `{SHA512-CRYPT}` prefix |
| Schema edit ignored | You did not `down -v`. See above |
| Postfix won't start | `docker compose logs postfix` — usually a typo in `main.cf` |
| Port already in use | Something on Windows holds the port; change the host side of the mapping |

---

## What this stack deliberately does not do

Being explicit, so it does not read as an oversight:

- **Receive mail from the real internet** — needs a public IP, MX records and port 25 inbound. That is Phase 0 on a real VM, not local.
- **Send to the real internet** — see the containment section. Deliberate.
- **SPF / DKIM / DMARC verification** — needs real DNS. Sprint 0.2 on the VM.
- **TLS** — local plaintext is fine on a loopback network and keeps the config readable.
- **Quota enforcement, spam training, virus scanning** — Phase 1 and later.

---

## Where this fits

| Delivery plan | Covered here |
|---|---|
| Sprint 0.1 — infrastructure | ✅ Postfix, Dovecot, Postgres talking to each other |
| Sprint 0.3 — integration seam | ✅ Postgres-backed virtual users, LMTP handoff, reject-at-SMTP-time |
| Sprint 0.2 — deliverability | ❌ Needs a real VM with a real IP |
| Sprint 1.1 — RLS foundations | ✅ Schema, policies, isolation test suite seeded |

**Next:** point the .NET API at `localhost:5432` as `tatvaos_app`, and start Sprint 1.1. The isolation test suite in `scripts/test-isolation.sh` is the seed of `tests/isolation` — grow it with every endpoint you add, for the life of the project.
