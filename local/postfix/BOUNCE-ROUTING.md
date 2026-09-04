# Bounce routing + intake — design for review

The bounce key (schema #25) and the VERP envelope (#28) are in. This is the
slice that makes them real: getting the bounce address delivered, validated,
and written back — and it is the live SMTP attack surface, so it is put up for
design review before any of it is built. None of the below is built yet.

## 0. Address format (updated — see §5, expiry)

    <id>.<keyid>.<ts>.<hmac>@bounces.tatvaos.com

`id` = api_sends primary key (correlation). `keyid` = which secret signed it
(rotation). `ts` = a coarse send-day stamp for expiry (§5). `hmac` signs
`id.keyid.ts`. #28's BuildBounceAddress currently emits `id.keyid.hmac`; it
gains `ts` in lockstep with the policy service (§2). Both are dormant until DNS
(§1) and `Bounce:Domain`/`Bounce:Secret` are set, so the format can change now
at no live cost — which is the whole reason to do it now.

## 1. DNS (manual — Amit, at the registrar)

Two records on the bounce subdomain. Neither touches the main domain.

- `bounces.tatvaos.com.  MX  10 mx.tatvaos.com.` — bounces come to our host.
- `bounces.tatvaos.com.  TXT  "v=spf1 a:mx.tatvaos.com -all"` — so the VERP
  envelope domain passes SPF for our sending IP. (DMARC on customer mail is
  unaffected: it aligns on the customer domain's DKIM, which Postfix already
  signs. The envelope domain only authenticates itself.)

Until these exist, `Bounce:Domain`/`Bounce:Secret` stay unset and VERP is
dormant — which is why #28 shipped safe.

## 2. SMTP-TIME validation — a policy service, not post-queue (requirement A)

Verify the HMAC DURING the SMTP conversation and reject there, so junk to a
public subdomain never enters the queue and never becomes the attack surface
`verify-live.sh`'s "queue empty" check would then flap on.

Mechanism: a small **policy service** (`check_policy_service inet:...` in
`smtpd_recipient_restrictions`, only for the `bounces.tatvaos.com` recipient).
Postfix queries it at RCPT TO; it parses the local part, checks `ts` is within
the window (§5), recomputes `HMAC(secret[keyid], "id.keyid.ts")`, and returns
`action=DUNNO` (accept) or `action=REJECT` (5xx, no queue). It holds the same
`Bounce:Secret` keyset the API signs with — one secret, two readers.

Not a PCRE `check_recipient_access` map: a regex can match the address SHAPE
but cannot compute an HMAC, so it would accept any correctly-shaped forgery
into the queue. Shape-matching is a cheap FIRST gate; the policy service is the
real check.

**When the policy service is DOWN — fail CLOSED, but PER-SERVICE.**

CORRECTION found wiring slice 1: this codebase already sets
`smtpd_policy_service_default_action = DUNNO` GLOBALLY, and on purpose — the
existing `check_policy_service inet:api:10025` is the quota gate, which MUST
fail open, because "the API is restarting" failing closed means "nobody in the
company receives mail." The global setting cannot be flipped to defer without
breaking all inbound mail.

So the bounce check gets its OWN failure mode inline, leaving the global alone
(Postfix 3.0+, and this box is 3.7):

    check_policy_service { inet:api:10025, default_action=defer }

invoked only for bounce-domain recipients via a scoped restriction class (a
`bounce_verify` class mapped to `bounces.tatvaos.com` through
check_recipient_access), so the quota gate keeps DUNNO and the bounce gate
defers. A deferral means the far server retries the bounce; we lose time, not
events. The wrong "fix" to refuse in the same breath: do NOT drop the inline
`default_action=defer` to inherit the global DUNNO — that opens the bounce gate
for every forgery while it reports healthy.

Reuse vs new daemon: because api:10025 already receives every RCPT, the bounce
HMAC check is cheapest as a BRANCH in that same policy handler keyed on the
recipient domain — no new daemon, and the signing secret is already in the
API's config. The per-service `default_action=defer` above is what still makes
the bounce path fail closed while the shared service's global default stays
DUNNO for quota. (If a separate daemon is preferred for blast-radius reasons,
say so; the config shape is the same, only the port changes.)

**Two conditions on the shared handler (ruling):**
- **Branch on the recipient domain FIRST**, before any parsing or crypto.
  Every inbound RCPT on the platform goes through api:10025; the bounce path
  must cost ONE string compare for the 99.9% of traffic that is not a bounce.
- **Exception-isolate the bounce branch.** A bug in it must not be able to
  change a quota answer. Quota fails open (DUNNO), so an unguarded throw would
  make mail flow unmetered rather than stop — contained, but contained on
  purpose, not by luck. The bounce branch is wrapped; on any internal error it
  returns defer for the bounce recipient and never touches the quota path.

**Binding.** The service binds loopback (or the internal compose network),
NEVER a public interface. It is a new daemon on the mail host that holds the
signing secret; nothing outside the host talks to it directly.

**Comparison.** The HMAC check uses a constant-time compare
(`CryptographicOperations.FixedTimeEquals` / `hmac.compare_digest`), not `==`.
It is a signature check reachable by anyone who can talk to port 25.

**Null envelope sender.** DSNs arrive as `MAIL FROM:<>`. The policy service
runs at RCPT TO, so it fires regardless of the empty sender — but any upstream
restriction that assumes a non-empty sender (SPF checks, the sender gate) must
NOT reject `<>` on this domain.

## 3. Intake — idempotent write (requirement B)

Accepted bounces are delivered by a transport to the intake, which parses the
DSN for status (hard/soft) and diagnostic text, then:

```
UPDATE mail.api_sends
   SET bounced_at = now(), bounce_type = $type, bounce_reason = $text
 WHERE id = $id AND bounced_at IS NULL;
```

`AND bounced_at IS NULL`: a DSN can be delivered more than once. Setting
`bounced_at` twice is harmless; counting a hard bounce twice toward a
suppression/reputation threshold is not. The guard makes the second delivery a
no-op, and suppression (a later slice) fires once.

**A valid HMAC naming a row that does not exist** (id gone, or never was):
the UPDATE affects zero rows. Log it at info and DROP — do not error. A 500 in
a mail path is discovered by a queue backing up; this path returns success to
Postfix so the (validly-signed but orphaned) DSN is consumed, not retried
forever.

## 4. Valid HMAC, mismatched recipient (requirement C — the decision)

A DSN can carry a valid HMAC (id/keyid ours) but a reported original recipient
that differs from `api_sends.to_address` for that id — a forwarding chain, or a
replay of a captured address naming a different victim.

Decision: **the api_sends ROW is authoritative for who bounced; the DSN's
claimed recipient is evidence, never authority.**

- The bounce is recorded against the row the validated id names.
- Suppression keys off the row's OWN `to_address` (what WE recorded at send
  time), NEVER the address the DSN claims — so a replay cannot suppress an
  arbitrary third party. The worst a replay does is mark one of our own
  already-sent rows bounced, once (the §3 guard bounds it).
- The DSN's claimed recipient and text go into `bounce_reason` as-is (already
  flagged untrusted PII); a mismatch is logged, not trusted.

## 5. Expiry — a signed timestamp (decision)

As first designed a signed address was valid forever: capture one, feed it DSNs
in two years. Bounded by §3 and §4, so not urgent — but free now, expensive
later, because the format is not yet in production.

Decision: **a coarse send-day stamp `ts` in the SIGNED payload**, enforced by
the policy service at SMTP time. The service rejects `now - ts > 30 days`
before verifying the HMAC — a generous window against the ~5-day DSN retry
reality — so a stale-but-authentic replay is refused at RCPT TO without a queue
entry or a DB hit. Chosen over bounding on `api_sends.sent_at` age (which would
need a DB lookup inside the SMTP path, or push the expiry check to the intake
after the address had already been accepted). Day granularity keeps `ts` short
and leaks nothing beyond the send date, which the row already holds.

## 6. Recipient validation — the reject_unlisted_recipient blocker (decision)

`smtpd_recipient_restrictions` on port 25 runs, in order:

    reject_unauth_destination
    reject_unlisted_recipient
    check_policy_service inet:api:10025

A VERP address is a unique local part in NO lookup table, so
`reject_unlisted_recipient` would refuse it two lines BEFORE the policy service
— correct by the letter of the config, useless by intent, and the HMAC check
would never run.

Decision: **make `bounces.tatvaos.com` a catch-all** — a `relay_domain` with
NO entry in `relay_recipient_maps`. Postfix then accepts every recipient for
that domain (there is no map to fail against, so `reject_unlisted_recipient`
passes and `reject_unauth_destination` passes because it is a recognised relay
destination), and the accept/reject decision falls to `check_policy_service`,
which is exactly where the HMAC lives. Junk still dies at RCPT — the policy
service rejects it before the queue — it just dies at the policy line instead
of the reject_unlisted line.

Chosen over the alternative (ordering a bounce restriction class AHEAD of
`reject_unlisted_recipient`): that reorders the SHARED global restriction list
that gates all inbound mail, and a mistake there hits every tenant. The
catch-all touches only this one domain's recipient validation and leaves the
global order alone. It is also the honest model — a VERP domain genuinely has
unlimited unique recipients, so "no recipient map, validate in the policy
service" describes what is true rather than working around it.

Delivery of accepted bounces routes via `transport_maps` to the intake
transport (§3). `relay_domains` + `transport_maps` + empty `relay_recipient_maps`
for this one domain; nothing else in the recipient path changes.

## Build order, once acked
1+2 (ONE deployable unit — a recognised bounce domain with no validator would
   accept junk, so config and validator are not separately deployable):
   the Postfix routing (catch-all relay_domain, transport to intake, scoped
   bounce_verify with inline default_action=defer) AND the api:10025 bounce
   branch (domain-branch first, exception-isolated, shape → ts window →
   constant-time HMAC), plus #28's builder gaining `ts` to match.
3. The intake (DSN parse + the idempotent write, orphan-drop, mismatch log).
4. Suppression table + admin un-suppression (its own PR, off hard bounces).

DNS (§1) is Amit's and gates nothing in code — VERP stays dormant until
`Bounce:Domain`/`Bounce:Secret` are set, so these can land and be verified on a
staging subdomain before the main one is pointed.
