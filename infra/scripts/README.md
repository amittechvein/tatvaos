# infra/scripts — Phase 0 server scripts

Run **on the Linode**, not on your workstation.

| Script | When | What |
|---|---|---|
| `check-dns.sh` | Before anything else | Verifies A, PTR, MX, SPF, DKIM, DMARC and blocklist status. Run until fully green |
| `provision-mail-server.sh` | Once, as root | Fresh Ubuntu 24.04 → hardened, DKIM-signing mail server |
| `deliverability-test.sh` | After the SMTP unblock | **The Phase 0 gate.** Sends to seed inboxes and produces a results template |

## Order

```bash
# 1. From anywhere — DNS must be right before the IP sends anything.
#    First impressions from a new address are the ones receivers weigh most.
./check-dns.sh tatvaos.com 172.105.57.198

# 2. On the Linode, as root
scp infra/dkim/tv2026a.key root@172.105.57.198:/root/
scp infra/scripts/*.sh     root@172.105.57.198:/root/
ssh root@172.105.57.198
mkdir -p /etc/opendkim/keys/tatvaos.com
mv /root/tv2026a.key /etc/opendkim/keys/tatvaos.com/tv2026a.private
./provision-mail-server.sh

# 3. Once Linode lifts the SMTP block
export SEED_GMAIL=you@gmail.com
export SEED_OUTLOOK=you@outlook.com
export SEED_YAHOO=you@yahoo.com
./deliverability-test.sh
```

## What Phase 0 deliberately does not install

Postfix and OpenDKIM only. No Dovecot, no Postgres, no Rspamd, no ClamAV.

Phase 0 answers one question — *does mail from this IP reach a Gmail inbox* — and that needs an MTA with correct DNS and nothing else. The 1 GB instance would not hold the rest anyway; ClamAV alone wants 1–2 GB for signatures.

OpenDKIM rather than Rspamd for the same reason: ~15 MB against ~400 MB, and signing is all that is required here. Rspamd arrives in Phase 1 for inbound scoring, on a larger instance.

## The result is the deliverable

`deliverability-test.sh` writes a dated template to `results/`. Filling it in by hand is the point — a message landing in Spam is not a failed test, it is **the finding**, and it is the one that decides own-IP versus relay-first (architecture §17.1).
