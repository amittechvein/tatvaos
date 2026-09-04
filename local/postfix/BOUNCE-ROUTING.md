# Bounce routing + intake — design for review

The bounce key (schema #25) and the VERP envelope (#28) are in. This is the
slice that makes them real: getting `<id>.<keyid>.<hmac>@bounces.tatvaos.com`
delivered, validated, and written back — and it is the live SMTP attack
surface, so it is put up for design review before any of it is built. None of
the below is built yet; this file is the thing to shoot at.

## 1. DNS (manual — Amit, at the registrar)

Two records on the bounce subdomain. Neither touches the main domain.

- `bounces.tatvaos.com.  MX  10 mx.tatvaos.com.` — bounces come to our host.
- `bounces.tatvaos.com.  TXT  "v=spf1 a:mx.tatvaos.com -all"` — so the VERP
  envelope domain passes SPF alignment for our sending IP. (DMARC on customer
  mail is unaffected: it aligns on the customer domain's DKIM, which Postfix
  already signs. The envelope domain only has to authenticate itself.)

Until these exist, `Bounce:Domain`/`Bounce:Secret` stay unset and VERP is
dormant (that is why #28 shipped safe).

## 2. SMTP-TIME validation — a policy service, not post-queue (requirement A)

The requirement: verify the HMAC DURING the SMTP conversation and reject there,
so junk to a public subdomain never enters the queue and never becomes the
attack surface `verify-live.sh`'s "queue empty" check would then flap on.

Mechanism: a small **policy service** (Postfix `check_policy_service
inet:bounce-policy:PORT` in `smtpd_recipient_restrictions`, only for the
`bounces.tatvaos.com` recipient). Postfix queries it at RCPT TO; it parses the
local part, recomputes `HMAC(secret[keyid], "id.keyid")`, and returns
`action=DUNNO` (accept) or `action=REJECT` (5xx, no queue). It holds the same
`Bounce:Secret` keyset the API signs with — one secret, two readers.

Why not a PCRE `check_recipient_access` map: a regex can match the address
SHAPE but cannot compute an HMAC, so it would accept any correctly-shaped
forgery into the queue. Shape-matching is a cheap FIRST gate (reject obvious
junk with no daemon round-trip) but not the requirement; the policy service is.

Rejected addresses never reach the intake or the database.

## 3. Intake — idempotent write (requirement B)

Accepted bounces are delivered by a transport to the intake (LMTP/pipe to the
API, or a dedicated small worker). It parses the DSN for status
(hard/soft) and the diagnostic text, then:

```
UPDATE mail.api_sends
   SET bounced_at = now(), bounce_type = $type, bounce_reason = $text
 WHERE id = $id AND bounced_at IS NULL;
```

The `AND bounced_at IS NULL` is the point: a DSN can be delivered more than
once. Setting `bounced_at` twice is harmless, but counting a hard bounce twice
toward a suppression/reputation threshold is not. The guard makes the second
delivery a no-op. Suppression (a later slice) keys off this transition, so it
fires once.

## 4. Valid HMAC, mismatched recipient (requirement C — the decision)

A DSN can arrive with a valid HMAC (so the id/keyid are ours) but a reported
original recipient that differs from `api_sends.to_address` for that id. That
is either a forwarding chain (recipient forwarded; the far server bounced the
final hop) or a replay (someone captured a valid VERP address and is feeding
it a DSN naming a different victim).

Decision: **the api_sends ROW is authoritative for who bounced; the DSN's
claimed recipient is evidence, never authority.**

- The bounce is recorded against the row the validated id names — that part is
  cryptographically ours.
- Suppression, when it comes, keys off the row's OWN `to_address` (what WE
  recorded at send time), NEVER off the address the DSN claims. So a replay
  cannot suppress an arbitrary third-party address — the worst it can do is
  mark one of our own already-sent rows bounced, which the idempotency guard
  already bounds to once.
- The DSN's claimed recipient and text go into `bounce_reason` as-is (already
  flagged PII/untrusted), and a mismatch is logged, not trusted.

This is chosen deliberately so it is not decided by whichever branch got
written first.

## Build order, once acked
1. Postfix config: `bounces.tatvaos.com` as a routed domain + the policy
   service hook (config only; the service is 2).
2. The policy service (SMTP-time HMAC check) + its secret wiring.
3. The intake (DSN parse + the idempotent write above).
4. Suppression table + admin un-suppression (its own PR, off hard bounces).

DNS (section 1) is Amit's and gates nothing in code — VERP stays dormant until
`Bounce:Domain`/`Bounce:Secret` are set, so these can land and be verified on a
staging subdomain before the main one is pointed.
