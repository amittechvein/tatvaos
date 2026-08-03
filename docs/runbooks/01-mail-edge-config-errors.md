# Runbook — Postfix or Dovecot won't start

**Symptom:** `docker compose ps` shows `tv-postfix` or `tv-dovecot` in `restarting`,
and mail is rejected for every recipient — valid ones included.

---

## Diagnose first, always

```bash
./scripts/diagnose.sh
```

Read **section 4** first. It runs `postmap -q` exactly as Postfix does. If those
lookups fail, everything above section 4 is healthy and everything below is a
symptom, not a cause.

---

## Trap 1 — Postfix has no trailing-comment syntax

```
postmap: fatal: bad numerical configuration: message_size_limit = 26214400   # 25 MB
```

In `main.cf`, **everything after `=` to end of line is the value**, `#` included.
There is no inline comment. This is the single most common Postfix config error.

Wrong:

```
message_size_limit = 26214400   # 25 MB
```

Right:

```
# 25 MB
message_size_limit = 26214400
```

Applies to `master.cf` `-o` overrides and every map file in `sql/` too.

Find them all:

```bash
grep -nE '^[[:space:]]*[a-z_]+[[:space:]]*=.*[^[:space:]][[:space:]]+#' \
     postfix/main.cf postfix/master.cf postfix/sql/*.cf
```

**Fix:** move the comment to its own line, then `docker compose restart postfix`.
Config is bind-mounted — no rebuild needed.

---

## Trap 2 — Dovecot takes one setting per line

```
doveconf: Fatal: Error in configuration file /etc/dovecot/dovecot.conf line 55: Garbage after '{'
```

Semicolons are **not** statement separators in Dovecot config.

Wrong:

```
mailbox Drafts { special_use = \Drafts; auto = subscribe }
```

Right:

```
mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
}
```

The line number in the error is accurate — go straight to it.

---

## Trap 3 — the error is hidden

If a container restarts with no useful log, the entrypoint is swallowing it.
Never write:

```bash
postfix check || echo "WARNING: check reported issues"
```

That reports *that* something broke, not *what*. Print the real output:

```bash
postfix check 2>&1 | sed 's/^/[postfix]   /'
```

Hiding an error costs more time than the error does.

---

## Why "everything rejected" points at the database

Postfix evaluates `smtpd_recipient_restrictions` in order:

```
permit_mynetworks
permit_sasl_authenticated
reject_unauth_destination     <-- needs virtual_mailbox_domains to resolve
reject_unlisted_recipient
```

If the PostgreSQL lookup fails, Postfix cannot know `techvein.local` is ours, so
`reject_unauth_destination` fires and **every** message is refused. The "unknown
recipient rejected" and "foreign domain rejected" tests then pass for the wrong
reason — everything is being rejected. Treat all-pass on the negative tests plus
all-fail on the positive ones as a lookup failure, not a mail-flow problem.

---

## A local socket is not a network test

```bash
docker exec tv-postgres psql -U tatvaos_mailedge   # local socket, 'trust' auth
```

This never exercises the password. Postfix connects over TCP, which does:

```bash
docker exec tv-postfix bash -c \
  'PGPASSWORD=dev_mail_pw psql -h postgres -U tatvaos_mailedge -d tatvaos_mail -c "SELECT 1"'
```

---

## Trap 4 — `permit_mynetworks` on port 25 is an open relay

Symptom, from `test-mail.sh`:

```
[FAIL] relay to a foreign domain ACCEPTED - you have an open relay
```

Postfix evaluates `smtpd_recipient_restrictions` left to right and **stops at the
first verdict**. A list beginning with `permit_mynetworks` therefore never reaches
`reject_unauth_destination` for any client inside `mynetworks`.

The trap on Docker: the bridge gateway is `172.18.0.1`, which falls inside
`172.16.0.0/12`. Every connection from the host looked like a trusted internal
client, so Postfix relayed to any domain in the world.

**The rule:** port 25 accepts mail *for* you and never *from* you. Client trust
belongs on the submission port (587), which exists precisely to relay outbound,
and nowhere else.

Port 25:

```
smtpd_recipient_restrictions =
    reject_unauth_destination
    reject_unlisted_recipient
    permit
```

Port 587, in `master.cf`:

```
-o smtpd_recipient_restrictions=permit_mynetworks,reject_unauth_destination,reject
```

**Production:** replace `permit_mynetworks` on 587 with `permit_sasl_authenticated`
and narrow `mynetworks` to loopback. A private-range CIDR is not authentication.

### Why this one matters more than the rest

An open relay on a public IP is found by automated scanners within hours, used to
send spam within minutes of that, and lands the range on Spamhaus shortly after.
Delisting is slow and IP reputation is the hardest thing to rebuild — see
architecture §12. This is the single most expensive misconfiguration in the file.

### Check it deliberately

```bash
swaks --server localhost:2525 --from t@example.com --to someone@notourdomain.com
```

Anything other than a `554` rejection is a defect. `test-mail.sh` asserts this on
every run; keep that assertion for the life of the project.
