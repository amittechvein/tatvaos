# For Core — the three mail checks for `infra/scripts/verify-live.sh`

Written to drop into your script. It keeps its structure, its exit conventions
and the service-count check; these are the three that need mail knowledge.

Uses `step` / `ok` / `bad` / `note` and `$COMPOSE` exactly as `deploy.sh`
defines them (lines 20–26 and 37), so the two compose without translation.

**Both contract points are now settled — recorded here so the file stops
asking a question that has been answered:**

1. **`MAIL_HOST`** — read `MAIL_DOMAIN` from `infra/docker/.env`, and **fail
   loudly if it does not resolve**. An unset hostname must never silently
   become an empty check; that is the whole class of bug this file exists
   inside. `verify-live.sh` stays runnable standalone, because a verification
   script you can only reach through a deploy is one nobody runs when they are
   worried.
2. **`bad` increments the shared `FAILURES` counter**, same convention as
   `deploy.sh`, and `verify-live.sh` exits non-zero when it is non-empty.
3. **Shebang: `#!/usr/bin/env bash`**, matching `deploy.sh` and
   `verify-migrations.sh`. Not optional here — under `sh` (dash) both `local`
   and `/dev/tcp` break, and `/dev/tcp` breaks in the direction that reports
   success.

Every check below fails **closed**. Not one of them can report health when it
could not perform the test — that is the whole point, and it is the thing the
first draft of the queue check got wrong.

---

## 1. IMAP answers, and its certificate is real

```bash
check_imap() {
    step "IMAP (mail edge, port 993)"

    # ONE connection, two questions. Not -quiet: the verify line is half of
    # what we came for, and -quiet suppresses it.
    local out
    out=$(timeout 10 openssl s_client -connect "$MAIL_HOST:993" \
              -servername "$MAIL_HOST" </dev/null 2>&1 || true)

    if [ -z "$out" ]; then
        # Timeout, refused, DNS failure - all of them arrive here as silence.
        # Silence is a FAILURE, never a pass. An empty result and a healthy
        # result must never take the same branch.
        bad "Could not reach $MAIL_HOST:993 at all - no response to test."
        return 1
    fi

    if printf '%s\n' "$out" | grep -q '^\* OK'; then
        ok "IMAP greeting received."
    else
        bad "No IMAP greeting on $MAIL_HOST:993 - Dovecot is not serving."
        note "Check: docker compose ps dovecot, then its logs."
        return 1
    fi

    # A wrong or expired certificate does not break this script, it breaks
    # every phone in the customer's building - silently, one client at a time.
    if printf '%s\n' "$out" | grep -q 'Verify return code: 0 (ok)'; then
        ok "IMAP certificate verifies."
    else
        bad "IMAP certificate does NOT verify - mail clients will refuse to connect."
        note "$(printf '%s\n' "$out" | grep -m1 'Verify return code:' || echo 'no verify line returned')"
        return 1
    fi
}
```

**What this proves, and what it does not.** A `* OK` on 993 proves the IMAP
listener answers. It does **not** prove delivery. LMTP is port 24, container
-internal and unpublished, so a Dovecot that starts with a broken LMTP config
passes this check while mail queues behind it. The night of 27 August the
failure was total and this would have caught it; a subtler one it will not.
**The check for delivery is the queue, below.**

---

## 2. SMTP answers on both submission paths

```bash
check_smtp() {
    step "SMTP (ports 25 and 587)"

    local port banner failed=0
    for port in 25 587; do
        banner=""
        # bash's /dev/tcp rather than nc or swaks: no package to install, and
        # a missing tool must not become a skipped check.
        if exec 3<>"/dev/tcp/$MAIL_HOST/$port" 2>/dev/null; then
            IFS= read -r -t 10 banner <&3 || true
            printf 'QUIT\r\n' >&3 2>/dev/null || true
            exec 3<&- 3>&- 2>/dev/null || true
        fi

        case "$banner" in
            220*) ok "Port $port answered: ${banner%%$'\r'*}" ;;
            "")   bad "Port $port did not answer - Postfix is not listening."; failed=1 ;;
            *)    bad "Port $port answered, but not with 220: ${banner%%$'\r'*}"; failed=1 ;;
        esac
    done

    return $failed
}
```

25 is inbound from the world, 587 is where the customer's own clients submit.
They fail independently and for different reasons, so they are reported
independently — "SMTP is up" would be true and useless when 587 alone is down.

---

## 3. The queue — the check that would have caught 27 August on its own

**Rewritten to use `postqueue -j`.** Version 1 parsed the human-readable
`postqueue -p`, which meant assuming the queue-ID alphabet and parsing a date
string with no year in it. Both assumptions were wrong in different ways (see
the corrections at the end). `-j` prints one JSON object per message with
`arrival_time` already an epoch integer, so there is no alphabet to assume and
no date to parse — **both of the earlier bugs become unreachable rather than
fixed**. Postfix has had it since 3.1; bookworm ships 3.7. If a version ever
lacks it, `postqueue` errors and that lands in the "could not read" branch.

```bash
check_queue() {
    step "Mail queue"

    local out rc=0
    out=$($COMPOSE exec -T postfix postqueue -j 2>&1) || rc=$?

    # FAIL CLOSED. A container that is gone, an exec that errored, or a
    # postqueue without -j all arrive here. "Could not perform the test" must
    # never reach the same branch as "the test passed".
    if [ "$rc" -ne 0 ]; then
        bad "Could not read the mail queue (exit $rc)."
        note "Postfix is not answering, or this version has no 'postqueue -j'."
        note "${out%%$'\n'*}"
        return 1
    fi

    # THE ONE PLACE SILENCE IS A PASS, and only because rc was 0 - which is
    # the evidence that the command ran. postqueue -j prints nothing at all
    # for an empty queue. Everywhere else in this file, no output is a
    # failure, because nothing distinguishes it from the step not running.
    if [ -z "${out//[[:space:]]/}" ]; then
        ok "Queue empty."
        return 0
    fi

    local times depth oldest now age
    times=$(printf '%s\n' "$out" \
            | grep -oE '"arrival_time":[[:space:]]*[0-9]+' \
            | grep -oE '[0-9]+$')

    # Output we cannot read is a failure to test, not a pass. No jq
    # dependency: -j emits one object per line, so a line-wise grep is enough
    # and a missing tool cannot silently become a skipped check.
    if [ -z "$times" ]; then
        bad "Queue is not empty and no arrival_time could be read - output not understood."
        return 1
    fi

    depth=$(printf '%s\n' "$times" | wc -l | tr -d ' ')
    oldest=$(printf '%s\n' "$times" | sort -n | head -1)
    now=$(date +%s)
    age=$(( now - oldest ))

    # AGE, NOT DEPTH, DECIDES.
    #
    # One depth sample cannot tell five messages in flight from five stuck,
    # and a threshold on it is a guess that goes stale the day this box gets
    # busy. On a box whose normal queue is empty, a message older than ten
    # minutes is delivery stuck, whatever the count. A busy queue that is
    # moving never trips it. Depth is reported, never judged.
    note "$depth message(s) queued, oldest ${age}s old."

    if [ "$age" -gt 600 ]; then
        bad "Mail has been queued for ${age}s - delivery is stuck, not slow."
        note "Postfix accepts and holds when Dovecot LMTP is unreachable. Nothing is lost yet."
        note "Check: docker compose ps dovecot"
        return 1
    fi

    ok "Queue moving (oldest ${age}s)."
}
```

---

## Corrections to version 1, and one to the review

**The long-queue-ID finding is right and the pattern was wrong.** With
`enable_long_queue_ids` on, Postfix emits base-52 IDs containing letters
outside `A-F`, and the hex pattern matched none of them.

**But it failed closed, not open.** I tested it rather than agreeing:

```
== G: long (base-52) queue id ==
   [FAIL] 0 queued, no arrival time parsed        rc=1
```

Zero IDs matched, so `oldest` stayed at its `0` sentinel, and the "no arrival
time could be read" branch caught it and returned 1. A full queue was never
going to report healthy.

What it *would* have done is worse in a different way: fail with the message
**"0 message(s) queued and no arrival time could be read"** — a sentence that
contradicts itself and sends whoever reads it at 2am looking at the parser
instead of the mail. Right to change it, wrong reason, and the difference
matters because "fails open" and "fails closed with a confusing message" get
fixed with different urgency.

Moot either way now: `-j` never touches the ID.

**Two bugs in version 1, both found by running it, neither by reading it:**

- `awk` interval expressions. `{5,}` is not POSIX and **mawk does not support
  it** — mawk is `/usr/bin/awk` on Debian and Ubuntu, which is what the box
  has. Matched nothing, every run reported "no arrival time could be read".
- The earliest-message comparison was inverted, so `oldest` stayed at `0`
  forever and every non-empty queue took the unparseable branch.

Different causes, identical symptom, and reading them both looked fine.

---

## The tests I actually ran

Seven fixtures against the `-j` parser. Five fail on purpose. Re-runnable after
you wire it in, which is the point of including them.

```
== A: empty (no output) ==        [ ok ] Queue empty.                            rc=0
== B: exec failed ==              [FAIL] Could not read the mail queue (exit 1)  rc=1
== C: -j unsupported ==           [FAIL] Could not read the mail queue (exit 1)  rc=1
== D: one fresh ==                [ ok ] Queue moving (oldest 30s).              rc=0
== E: one old, LONG base-52 id == [FAIL] queued 2700s - delivery is stuck        rc=1
== F: mixed, earliest wins ==     [FAIL] queued 2700s - stuck (2 queued)         rc=1
== G: json we do not understand == [FAIL] no arrival_time could be read          rc=1
```

Fixtures — `$fresh` is `date -d '-30 seconds' +%s`, `$old` is `-45 minutes`:

- **A** empty string, rc 0
- **B** `Error: No such container: postfix`, rc 1
- **C** `postqueue: fatal: usage: postqueue -j`, rc 1
- **D** `{"queue_id":"3A1B2C","arrival_time": $fresh}`
- **E** `{"queue_id":"3xVXyz2Sm5zK9j","arrival_time":$old}` — the case that
  broke version 1
- **F** D and E on two lines, proving the *earliest* wins and not the first
- **G** `{"something_else":1}`

---

## Why these three and not more

They are the checks that fail when the thing they name is broken. Ranked by
what each would have caught on the night of 27 August:

| Check | Would have caught it |
|---|---|
| Queue age | **Yes, on its own.** Mail queued for hours while every HTTP gate read 200. |
| IMAP banner | **Yes.** Dovecot was not running at all. |
| SMTP banner | No — Postfix was up throughout. It is here for the failure that goes the other way. |

And for the record, the three that were already in `deploy-production.yml`
would have caught **none** of it: `/health`, `/health/db` and
`mail.tatvaos.com/` all return 200 with Dovecot dead, because the last of them
proves an HTTP site block and nothing about mail.
