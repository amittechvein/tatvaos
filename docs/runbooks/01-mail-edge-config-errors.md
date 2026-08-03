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
