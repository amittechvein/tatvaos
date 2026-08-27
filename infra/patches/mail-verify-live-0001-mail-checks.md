# For Core — the three mail checks for `infra/scripts/verify-live.sh`

Written to drop into your script. It keeps its structure, its exit conventions
and the service-count check; these are the three that need mail knowledge.

Uses `step` / `ok` / `bad` / `note` and `$COMPOSE` exactly as `deploy.sh`
defines them (lines 20–26 and 37), so the two compose without translation.

**Two contract points for you to settle, because they belong to the script and
not to this block:**

1. `MAIL_HOST`. These need the mail edge's public name. `verify-live.sh` must
   be runnable standalone, so it cannot rely on a variable a deploy happened to
   export. Suggest reading `MAIL_DOMAIN` out of `infra/docker/.env` with a
   fallback, and failing loudly if neither resolves — an unset hostname must not
   silently become an empty check.
2. Whether `bad` increments a shared `FAILURES` counter here as it does in
   `deploy.sh`. These call `bad` and `return 1`; wire the counting your way.

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

```bash
check_queue() {
    step "Mail queue"

    local out rc=0
    out=$($COMPOSE exec -T postfix postqueue -p 2>&1) || rc=$?

    # FAIL CLOSED. If the container is gone or exec errored we could not
    # perform the test, and "could not read the queue" must never arrive at
    # the same number as "the queue is empty". The first draft of this check
    # piped straight into grep -c with `|| true`, which reported depth=0 -
    # a healthy empty queue - precisely when the mail server was dead.
    if [ "$rc" -ne 0 ]; then
        bad "Could not read the mail queue (exit $rc) - Postfix is not answering."
        note "${out%%$'\n'*}"
        return 1
    fi

    if printf '%s\n' "$out" | grep -q 'Mail queue is empty'; then
        ok "Queue empty."
        return 0
    fi

    local depth
    depth=$(printf '%s\n' "$out" | awk '$1 ~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]+[*!]?$/' | wc -l | tr -d ' ')

    # AGE, NOT DEPTH, DECIDES.
    #
    # One depth sample cannot tell five messages in flight from five stuck,
    # and a threshold on it is a guess that goes stale the day this box gets
    # busy. Arrival time answers the real question with one sample: on a box
    # whose normal queue is empty, a message older than ten minutes is
    # delivery stuck, whatever the count. A busy queue that is moving never
    # trips it.
    local now oldest=0 secs t
    now=$(date +%s)

    # postqueue prints: <id> <size> <dow> <mon> <day> <time> <sender>
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        secs=$(date -d "$t" +%s 2>/dev/null) || continue
        # Keep the EARLIEST. oldest=0 means "nothing parsed yet", which is why
        # it is also the sentinel the failure branch below tests for.
        if [ "$oldest" -eq 0 ] || [ "$secs" -lt "$oldest" ]; then
            oldest=$secs
        fi
    done < <(printf '%s\n' "$out" \
             | awk '$1 ~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]+[*!]?$/ { print $3, $4, $5, $6 }')

    # Queued messages exist but not one arrival time parsed: the output is in
    # a shape we do not understand, which is a failure to test, not a pass.
    if [ "$oldest" -eq 0 ]; then
        bad "$depth message(s) queued and no arrival time could be read - queue output not understood."
        return 1
    fi

    local age=$(( now - oldest ))
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

**Note on `date -d`.** `postqueue` prints no year, so `date` assumes the current
one. Across a New Year boundary a message queued on 31 December reads as a year
in the future and the age goes negative — which fails the `-gt 600` test and
reports healthy. It is one night a year, on messages already stuck, and fixing
it properly means asking Postfix for epoch times rather than parsing its
human-readable output. **Stated rather than left for someone to find**; worth
an open thread, not worth a clever workaround in a health check.

---

**Note on the awk pattern.** It spells out five hex characters rather than
using `{5,}`. Interval expressions are not in POSIX awk and **mawk does not
support them** — Debian and Ubuntu ship mawk as `/usr/bin/awk`, which is what a
production box has. The first draft used `{5,}`, matched nothing at all, and
therefore reported "no arrival time could be read" on every run. It failed
closed, which is why the failure was survivable — but a check that always fails
is a check that gets deleted, so this is not a style point.

I found that by running it, not by reading it. See below.

---

## The test I actually ran

Six fixtures against the parsing logic. Two of them fail on purpose, and the
last two are the ones worth keeping — a check nobody has seen fail is not a
check.

```
== A: empty ==                [ ok ] Queue empty.                          rc=0
== B: exec failed ==          [FAIL] Could not read the mail queue (exit 1) rc=1
== C: one fresh ==            [ ok ] Queue moving (oldest 30s).            rc=0
== D: one old (stuck) ==      [FAIL] queued 2700s - stuck                  rc=1
== E: mixed, oldest wins ==   [FAIL] queued 2700s - stuck (2 queued)       rc=1
== F: garbage rows ==         [FAIL] 1 queued, no arrival time parsed      rc=1
```

Fixtures, if you want to re-run them after wiring it in — `$hdr` is
`postqueue`'s real header line, `$fresh` is `date -d '-30 seconds' '+%a %b %e
%H:%M:%S'`, `$old` the same at `-45 minutes`:

- **A** `Mail queue is empty`
- **B** `Error: No such container`, rc 1
- **C** one entry, `$fresh`
- **D** one entry marked active (`9F8E7D6C5B4*`), `$old`
- **E** both C and D, proving the earliest wins and not the first
- **F** an id row whose arrival column is not a date

**E is the one that caught a real bug.** My first version of the "keep the
earliest" comparison had the test inverted and `oldest` stayed at its `0`
sentinel forever, so every non-empty queue took the unparseable branch. Same
failure signature as the mawk problem and a completely different cause, which
is exactly why the fixture set is worth keeping rather than the conclusion.

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
