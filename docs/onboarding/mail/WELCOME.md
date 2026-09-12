# Welcome to TatvaOS — you're taking Mail

Written 13 September 2026 by the CTO, the day after the previous Mail
developer closed the lane and handed it over. Read this once end to end before
your first commit. It is decisions and honest unfinished business, not
mysteries — and several things in it are things nobody has yet proved.

This folder did not have a Mail welcome until today. Two developers were
pointed at `docs/onboarding/` while it offered four lanes and omitted this one.
That omission is on record in the README; you are the first person reading a
corrected map.

---

## 1. What Mail is

TatvaOS Mail is a full webmail on our own stack — Postfix, Dovecot, Postgres,
a .NET API and a Next.js front end — at `mail.tatvaos.com`. Organisations
bring their own domains; we verify them, sign outbound with DKIM, and enforce
SPF/DMARC on inbound. One server in Mumbai. One mail edge, shared by every
tenant, so a mistake in Postfix configuration is a mistake for every customer
at once.

Three surfaces, and you own all three:

| Surface | What it is | Where |
|---|---|---|
| **Webmail** | Compose, threads, search, filters, signatures, delegation, shared mailboxes, categories, away/schedule | `apps/web/app/mail/`, `apps/api/Modules/Mail/` |
| **The mail edge** | Postfix + Dovecot for third-party clients: IMAPS 993, submission 587 with STARTTLS, app passwords | `infra/`, `local/` mail containers, `docs/RUNBOOK-2026-08-28.md` |
| **The send API** | `POST /api/v1/mail/send` — Resend-shaped, keyed, for customers' own software | `apps/api/Modules/Mail/Endpoints/MailSendApiEndpoints.cs`, `MailApiKeyEndpoints.cs` |

Plus the **calendar seam**: iMIP invitations flow both ways between Mail and
Calendar, proven against Gmail on 27 August. `docs/MAIL_IMIP_SEAM.md`.

---

## 2. Decisions already made — do not re-open these

Each has a reason and most have an incident. The full record for the send API
is in `docs/decisions/` as it gets written up; until then, this table is the
authority and `git log` on the files named is the evidence.

| Decision | Ruling | Why |
|---|---|---|
| **One send path** | `MailSender` is the only thing that speaks SMTP from the API. No second client, ever. | Its own header warns against "a fifth hand-rolled SMTP client". Every duplicate so far has diverged from the sender gate. |
| **App passwords, not primary passwords, for external clients** | `{SSHA512}`, self-prefixed, one active per mailbox, revoke-never-delete | Dovecot's SQL passdb verifies one row. Primary `imap_password_hash` rows are raw `$argon2id$` and may still defeat Dovecot's parser — a **named, unresolved risk** (§5). |
| **Sender must be a real mailbox on a verified domain** | Address-only senders refused | The sender gate is keyed on `mail.mailboxes`. Rewriting the highest-stakes view for a convenience nobody asked for is not happening. |
| **An empty `allowed_sender_addresses` means the key cannot send** | Never "unrestricted" | That inversion was the September 2026 hole: a key with an empty list could send as any mailbox in its own organisation. Closed at all four layers on 5 Sept; zero live keys were affected. `20260904-mail-api-keys-constraint.sql` carries the `cardinality(...) > 0` check. |
| **Retention of the send log** | **Keep everything. No expiry, no per-org setting.** | Amit, 2 Sept, twice, after the DPDP erasure point was put to him once. Not to be re-raised. |
| **Open tracking** | None. Enforced by a review-checklist line and a grep for pixel/beacon terms that must return nothing. | Needs Amit's explicit decision before it exists. |
| **Suppression** | Hard bounce → never send again for that org. Un-suppress only by a human, in the admin screen, audited, showing the original bounce reason. | "No override" alone made support impossible. The friction is the feature. |
| **Bounce key** | VERP on a dedicated subdomain: `<id>.<keyid>.<ts>.<hmac>@bounces.tatvaos.com`. Keyset for rotation. Timestamp inside the signed payload, rejected past 30 days at RCPT. | `bounce+<id>@` was traced and disproved — `recipient_delimiter` is unset and changing it alters every tenant's `name+tag@` resolution platform-wide. |
| **Wire size** | 35 MB (`36700160`), and the API gate measures what Postfix measures | 25 MB of attachments is ~34 MB on the wire. A third copy of the limit was found in a provisioning script and removed. `docs/MAIL_LARGE_ATTACHMENTS.md`. |
| **`smtpd_policy_service_default_action = DUNNO`** | Global, deliberate. Quota fails **open**. | Otherwise "the API is restarting" becomes "nobody receives mail". The bounce verifier gets a *scoped* `default_action=defer` on its own restriction class instead. **The CTO once told your predecessor to set the global to defer; he caught it. It would have stopped all inbound mail.** |
| **SafeHtml sandbox** | `allow-same-origin` yes; `allow-scripts` never; a test refuses both together | The pair is an escape. |

---

## 3. What you're inheriting that isn't finished

Honest list. The previous developer wrote this up in his handover and I have
checked what I could; where I could not, it says so.

**The bounce pipeline is complete and has never processed a real bounce.**
Schema, VERP envelope, Postfix routing, policy-service validation, intake
(`20260905-mail-bounce-intake.sql`) and suppression are all built and merged.
`bounces.tatvaos.com` has MX and SPF live. **Nothing has been observed working
end to end.** The order that proves it, from the handover:

1. Set `BOUNCE_DOMAIN`, with a live `RCPT TO` test **before and after** so the
   change turns a demonstrated red into green rather than a presumed one.
2. Then the keyset — `Bounce:KeyId` and `Bounce:Keys:<id>` — which is the
   single act that lifts VERP out of dormancy. Do it last, because
   `transport_maps` points at `bounce-intake:` and nothing else must reference
   a transport that is not yet live.
3. Then a real send to an address known to hard-bounce, watching
   `mail.api_sends.bounced_at`.

Until step 3 has happened, the customer-facing claim "we track bounces" is
documented, not true. House rule 7.

**A live accept-and-drop gap, with Core.** There is a path on the public MX
that answers `250 accepted` and then does not deliver. That is the worst
failure a mail server can have — the sender is told it worked. The handover
names it; the fix is not yet written. **Red first**: reproduce it and show the
250 before touching anything.

**The `mail` schema GRANT.** `local/postgres/init/0001-mail-schema.sql:169`
grants `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mail` to
`tatvaos_app`. Every other schema does the same on its own line. So **any table
described as append-only is not**, unless it has an explicit `REVOKE`. The
send log and the bounce intake are described that way. Sweep them with Core.

**`docs/RUNBOOK-2026-08-28.md` step 7 has never been run.** A real third-party
mail client, a real app password, a send, a reply, and a wrong-password
refusal. Until it passes, "your ERP can send through us" is a sentence in a
document. `docs/CLIENT_MAIL_SETUP.md` is the customer one-pager — do not send
it before step 7 passes.

**Two checks in #62 were reported verified without saying what was verified.**
The handover flags them. Re-run them and write down what would have made each
fail (rule 6, rule 6b).

**Inbound to Gmail lands in spam.** The first proven API send arrived flagged
"similar to messages identified as spam in the past". SPF/DKIM/DMARC headers
have not been checked on a received copy. That is a reputation question and it
is yours.

**Loose ends from 3 September, unverified since:** the smoke-test key
`tvos_XSYX…` was pasted into a transcript and must be revoked if it has not
been; `amit@techvein.com` is a shared mailbox that was rejected as a sender,
cause unconfirmed; `MailSender`'s catch-all still reports "could not be
reached" for anything that is not a 530.

---

## 4. Traps that have already cost someone a day

**Postfix renders its configuration from a mounted template at container
start.** `docker compose up -d` does not apply a change. A full deploy did not
either, until `deploy.sh` was made to restart Postfix unconditionally. This
cost the TLS fix four days and the size fix twice in one day. If Postfix is not
doing what `main.cf` says, check whether it was restarted, before anything
else.

**Platform scope does not bypass row-level security.** `EnterPlatformScope`
sets a tenant per operation. Looking up an API key before you know the tenant
therefore returns nothing, and `IgnoreQueryFilters()` disguises it — it drops
EF's filter and leaves the database policy in force. The fix is a
`SECURITY DEFINER` resolver (`mail.resolve_api_key`, modelled on
`core.resolve_refresh_token`). And **close the raw connection afterwards** —
`TenantConnectionInterceptor` sets `app.tenant_id` only in
`ConnectionOpenedAsync`, so a connection you opened yourself has no tenant and
every later query on it returns empty.

**Production port 587 is TLS+SASL only.** `MailSender` once submitted plaintext
to it; Postfix said 530; the catch-all said "unreachable"; **every send from
production, webmail included, had been failing silently since the 587
hardening.** Internal submission is on `10587` — never published, same sender
gate, same DKIM milter. If sends fail with "unreachable", look at the exception
type in the log line before believing the word.

**Caddy routes only `/api/*` to the API.** The send API was first mapped at bare
`/v1/mail/send` and would have 404'd for every customer. Found by reading the
Caddyfile, not by any test.

**Every migration in `local/postgres/init/` re-runs on every deploy.** A file
that works once and fails the second time breaks the *next* deploy, which may
be someone else's. `.github/workflows/migrations.yml` now applies the whole set
twice on every PR that touches them — but it builds from an empty database, so
it cannot see a fault that needs existing rows. `docs/decisions/0001-…` is the
instance.

**Your predecessor's `migrations.yml` was nearly deleted on the CTO's
instruction**, on the reasoning that `ci.yml` already covered it. `ci.yml`
applies each file once. He checked instead of agreeing, and was right. Do the
same to me.

---

## 5. The Argon2 risk, stated plainly

Primary IMAP passwords are stored in `imap_password_hash` as raw `$argon2id$`
strings from our own hasher, with base64 padding, and no `{SCHEME}` prefix.
Dovecot's scheme is sed'd to `ARGON2ID` at container start after a capability
gate. **Whether Dovecot accepts our exact format has not been proven on
production.** App passwords are immune — `{SSHA512}`, self-prefixed — which is
why every client path uses them and why the customer one-pager says "app
password only". Also: change-password never updates the IMAP hash, so it is
frozen at first password.

This is not an emergency, because nothing customer-facing depends on the
primary IMAP hash. It is a thing that must not be forgotten, and it is listed
in the Core welcome too, because the hasher is Core's and the passdb is yours.
The comments in `20260827-a-mail-app-passwords.sql` are the design record.

---

## 6. Your first week — a suggestion, not an instruction

1. **Bring up `local/` and send yourself a message through it.** Watch it go
   Postfix → Dovecot → webmail. Nothing teaches this stack faster.
2. **Run `docs/RUNBOOK-2026-08-28.md` step 7** against production with a real
   client. It is the oldest unproven claim in the lane and it takes an hour.
3. **Read the bounce pipeline end to end** — `20260904-mail-api-send-bounce.sql`,
   `20260905-mail-bounce-intake.sql`, the Postfix routing, and
   `MailSendApiEndpoints.cs` — then plan the proving sequence in §3 as three
   separate, small deploys. Do not set the keyset until you have watched the
   RCPT test go red.
4. **Fix the GRANT.** Small, sharp, and it makes several claims true that
   currently are not.
5. **Start your open-threads page**, grouped by who each item is waiting on.
   The previous one is a good model.

---

## 7. How we talk to each other

We write things down, we say when we're unsure, and we correct each other
without ceremony — including the CTO, who has been wrong in writing three times
this week and was caught each time by someone reading the actual thing rather
than the note about it.

If a rule above gets in your way, say so with your reasoning. If something
looks broken, assume it might be, and check. That instinct is the most valuable
thing you can bring, and it is the one this lane has been best at.

Welcome aboard.

*— CTO, 13 September 2026*
