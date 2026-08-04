# DNS — trineetra.com

**Role:** the platform mail host, and a test tenant.
**Server:** `172.105.57.198` (Linode, Mumbai)

Add these at whoever hosts DNS for `trineetra.com`. Order matters — see the
trap at the bottom.

---

## 1. Forward record — do this first

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `mail` | `172.105.57.198` | 300 |

Nothing else can be done until this resolves. Check from PowerShell:

```powershell
nslookup mail.trineetra.com
```

## 2. Reverse DNS — Linode Cloud Manager

**Linode → your Linode → Network → the IPv4 address → Edit RDNS**

```
mail.trineetra.com
```

**If Cloud Manager refuses it, the A record has not propagated yet.** That is
the validation working, not an error — Linode will not set a PTR that does not
forward-confirm. Wait and retry.

Confirm both directions agree:

```powershell
nslookup mail.trineetra.com          # -> 172.105.57.198
nslookup 172.105.57.198              # -> mail.trineetra.com
```

**A PTR that does not forward-confirm is worse than none** — receivers read the
mismatch as misconfiguration and score it against you.

## 3. Mail records

| Type | Host | Value | TTL |
|---|---|---|---|
| MX | `@` | `10 mail.trineetra.com` | 300 |
| TXT | `@` | `v=spf1 a:mail.trineetra.com ip4:172.105.57.198 -all` | 300 |
| TXT | `tv2026a._domainkey` | see below | 300 |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@trineetra.com` | 300 |

### The DKIM value

One line, no spaces after the semicolons, no line breaks. Some DNS panels wrap
it for display — that is fine, as long as you pasted it unbroken.

```
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAngl+9r45H+afp4N7bEQKBC5duQglSi+g4b52RprK56wucuCwI5SImcZvnb09ZQ+bL4ekdefMnLhMfqH7s6bZqr5YvN59MyjYIEaMdXleXdDWksrDjNAkiIHTrvY7wEdf/8pHrrNm7EVUTyRmG3ex0gsEx4ys940VUwP9GqfiP6k7wADZIx3lup5x84XEsTFLGIjaNSVsy4Aeoqx0Mbjdh2Qct6ETWM1kvoGIYzEAaGOgR50/sgZH9UP/bif/dcZM58BIpk1Q5DiL60pvnw9UP8kuEqmo3gJHBmMX0a0DtWlyjW59XtL3PLy8dGe35AyzU4Xd9osgEVKu0D4rNK7KCwIDAQAB
```

**`p=none` on DMARC is deliberate.** It reports and rejects nothing. Moving to
`quarantine` or `reject` before you have read a week of reports is how a
business loses mail it never knew it was sending — from a CRM, an invoicing
tool, a mailing list.

## 4. Web records — the product itself

| Type | Host | Value |
|---|---|---|
| A | `app` | `172.105.57.198` |
| A | `@` | `172.105.57.198` |

---

## 5. If customers will sign in on subdomains of this domain

Onboarding issues each organisation a subdomain — `abcschool.trineetra.com` —
that works immediately. That needs a wildcard so a new customer does not wait
on a DNS change:

| Type | Host | Value |
|---|---|---|
| A | `*` | `172.105.57.198` |

**A wildcard has a real cost, so decide deliberately.** It makes *every*
unregistered name resolve, so `mail-catcher.trineetra.com` and
`webmail.trineetra.com` become publicly reachable rather than merely
unlisted. Either accept that and make sure nothing sensitive is served on a
guessable hostname, or skip the wildcard and add each customer's subdomain by
hand at onboarding.

---

## The ordering trap

**A record → wait for propagation → PTR → then the Linode ticket.**

Linode validates forward-confirmed rDNS before it will set the PTR, and their
SMTP-unblock ticket asks for the rDNS to already exist. Doing these in the
wrong order costs a round trip of a day or more each time.

---

## Verify the whole set

**Machine:** the Linode · **Directory:** `/root`

```bash
./check-dns.sh trineetra.com 172.105.57.198
```

Run it until every line is green before sending anything. **A new IP's first
messages are the ones receivers weigh most heavily** — getting SPF or DKIM
wrong on day one costs more than waiting an hour to get it right.

---

## What still will not work after all this

**Sending.** Linode blocks outbound 25, 465 and 587 by default. Receiving works
the moment the MX record resolves; sending needs a support ticket.

See `docs/setup/04-linode-smtp-unblock.md` — it has wording that is usually
approved first time, and the main reason tickets get bounced is opening them
before the rDNS exists.
