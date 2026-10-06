# Port 587 let a signed-in user send as any address

**Status: fix built, PR 380, approved by Mr. Singh with conditions; ships in
WARN mode first (Amit, 2 Oct 2026). Whether anyone has used the hole is NOT
YET KNOWN: there are no logs to say. The warn-mode record answers it from the
deploy onward.** No message content was read for this record.

## The finding

Port 587 is where mail apps (Thunderbird, Outlook, phones) send. Production
required a sign-in there, and then **let the signed-in user put any address
in MAIL FROM and any address in the From: line.** Nothing compared the
address claimed with the person signed in:
- `smtpd_sender_login_maps` was empty;
- no `*_login_mismatch` restriction existed;
- the only sender rule was the outbound gate, which judges the address
  CLAIMED.

So:
- **one organisation's account could send as another organisation's
  mailbox**, or as any address on the internet;
- **an unverified organisation could get past the outbound gate** by
  claiming a verified one's address (the gate decision 0013 builds on);
- **our DKIM signer signs by the From domain** (OpenDKIM's SigningTable, keyed
  by domain; InternalHosts = our Postfix), so a forged From: of a domain we
  host would very likely have carried **that domain's real signature**. Read
  from the configuration; the local stack has no keys to prove it.

| | |
|---|---|
| Found | 1 Oct 2026, reading the submission config while building PR 373 (the bounce-envelope gate): "port 587 has no sender-login check" |
| Proven | 2 Oct 2026, on the local stack at `main` `6d33a13` with production's 587 rules applied (the entrypoints' non-local lines, minus the certificate) |
| Introduced | when 587 was given SASL (the submission posture in `local/postfix/entrypoint.sh`); the restriction was never added alongside it |

## The proof (local stack, 2 Oct 2026)

Signed in as `principal@abcschool.local` (ABC School):

| MAIL FROM / From: | Before |
|---|---|
| itself | 250 queued (correct) |
| `amit@techvein.local`, another organisation | **250 queued** |
| `ceo@bank.example`, nobody we host | **250 queued** |
| envelope itself, header **From: amit@techvein.local** | **250 queued** |

The controls held: no sign-in got `554 5.7.1 Access denied`, and a wrong
password got `535 5.7.8`. So the acceptances are real, not a misconfigured
test.

## The fix (PR 380)

- **Envelope:** `smtpd_sender_login_maps` → `sql/sender-login-maps.cf` →
  `mail.sender_logins(sender)`, a new definer function. EXECUTE is for the
  mail edge only, and the mail edge still cannot read
  `mail.mailbox_permissions`. It returns who may use an address:
  - the mailbox itself;
  - people with `send_as` / `send_on_behalf` / `full` on a shared mailbox;
  - an alias's target.

  `reject_authenticated_sender_login_mismatch` runs before the outbound gate,
  for signed-in sessions only. The API's 10587 has its own list.
- **From: line:** `local/postfix/sender-milter.py`, a milter inside the
  Postfix container, used on port 587 only. It asks the same function for
  every address in From:. Postfix cannot compare a header with the sign-in,
  so this needed a different mechanism (Mr. Singh: "say so and keep both in
  this PR").
- **Warn first** (`TATVAOS_SENDER_OWNERSHIP=warn`, the default): nothing is
  refused. Every message that would be is recorded in
  `/var/log/tatvaos/sender-ownership.jsonl`, on the `maillogs` volume, which
  survives deploys. Each line holds kind, class, organisation ids and a
  12-character hash of the sign-in, **never an address**. `enforce` refuses
  both: 553 for the envelope, 550 for From:.

Test: `local/scripts/test-mail.sh`, section "Port 587", which is the CI Mail
stack job's script.

| Run | Tree | Result |
|---|---|---|
| red | `1e63fca` (envelope test alone, on `main` `b73eb44`) | 39 / 4 failed: the four impersonation cases |
| green | `ab878c3` (envelope fix) | 43 / 0 |
| red | `fe79525` (+ From: and warn tests) | 47 / 10 failed: forged From: ACCEPTED, warn mode nonexistent |
| green | `ef23a04` (filter + warn mode) | 57 / 0 |

Also, on a throwaway database: all migrations applied twice, the isolation
suite holds, and the function is a pinned definer that only the mail edge
may call.

## Has anyone used it?

**Not known, and it cannot be known for the past.** Mr. Singh's condition 1
asked for a 30-day count, from the production mail log, of 587 submissions
whose sender the signed-in mailbox would not own. **That log does not
exist.**
- Postfix and Dovecot log only to their container's output
  (`maillog_file = /dev/stdout`).
- Docker discards that output when a container is re-created, which every
  deploy does. On 2 Oct the oldest Postfix line was from 11:03 UTC that day.
- The `maillogs` volume held only installation logs from August.

So, by Amit's choice (option A, 2 Oct): **ship in warn mode, read the record
after about a week, add any missing shared-mailbox permissions, then switch
to enforce.**

The record's classes tell the cases apart:
- `same_org_shared_no_right`: a shared mailbox used without a permission row.
  Add it.
- `same_org_other`: a colleague's address.
- `other_org` / `not_hosted`: what this fix stops.

**To fill in after the week of warn mode:** counts by class and by
organisation, and the decision to enforce.

## Related

- **Decision 0013** (internal-only departments) and **PR 373** (the bounce
  envelope gate) work on the same outbound gate. This fix puts an ownership
  check in front of that gate, so the address it judges is one the sender
  may claim.
- `docs/runbooks/backup-and-restore.md` is not involved. Note that the
  `maillogs` volume is not backed up, so this record lives only on the
  server.

## Owed

- [ ] PR 380 merged after Mr. Singh's read; its own deploy (not bundled).
- [ ] After about 7 days of warn mode: counts by class and organisation (here), permissions added, then `TATVAOS_SENDER_OWNERSHIP=enforce` and a deploy.
- [ ] Whether the record needs a retention limit (one short line per would-be refusal; expected tiny).
