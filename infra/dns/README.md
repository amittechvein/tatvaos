# DNS — two roles, two record sets

There are two kinds of domain in TatvaOS and they are configured completely
differently. Confusing them is how a platform ends up depending on a customer.

| | **tatvaos.com** | **trineetra.com** |
|---|---|---|
| Role | Platform infrastructure | A customer |
| Owns | The mail host, the PTR, the signing key, sign-in subdomains | Its own mailboxes |
| MX points at | itself | `mail.tatvaos.com` |
| Configured by | us, once, permanently | the customer, through the console |

**Every customer's MX record points at `mail.tatvaos.com` forever.** That is why
the mail host must not live inside a domain that is also a tenant — the day such
a domain moved, expired or changed hands, mail would break for every
organisation on the platform at once.

---

# 1. tatvaos.com — the platform

Set up once. Never changes unless the server's IP does.

## Forward record — first

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `mail` | `172.105.57.198` | 300 |

## Reverse DNS — Linode Cloud Manager, not the registrar

**Linode → your Linode → Network → the IPv4 → ⋯ → Edit RDNS**

```
mail.tatvaos.com
```

Both directions must agree:

```powershell
nslookup mail.tatvaos.com     # -> 172.105.57.198
nslookup 172.105.57.198       # -> mail.tatvaos.com
```

**This single record matters more for deliverability than all the others
combined.** Generic reverse DNS — `172-105-57-198.ip.linodeusercontent.com` —
is the strongest "unconfigured cloud VM" signal receivers have, and a new IP's
first messages are the ones weighed most heavily.

## The SPF include target

| Type | Host | Value | TTL |
|---|---|---|---|
| TXT | `_spf` | `v=spf1 ip4:172.105.57.198 -all` | 300 |

**This is the reason customers include a name rather than an IP.** They publish
`include:_spf.tatvaos.com` once. When we add a second sending server, or change
IP, we edit this one record — not every customer's DNS. Asking four hundred
organisations to update SPF because we resized a VM is not a migration anyone
survives.

## The platform's own mail records

Needed because we send from `tatvaos.com` too — password resets, notifications.

| Type | Host | Value |
|---|---|---|
| MX | `@` | `10 mail.tatvaos.com` |
| TXT | `@` | `v=spf1 include:_spf.tatvaos.com -all` |
| TXT | `tv2026a._domainkey` | the DKIM value below |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@tatvaos.com` |

## Web and sign-in subdomains

| Type | Host | Value | Purpose |
|---|---|---|---|
| A | `app` | `172.105.57.198` | the product |
| A | `staging` | `172.105.57.198` | testing environment |
| A | `*` | `172.105.57.198` | each customer's sign-in subdomain |

**The wildcard is a real decision.** Onboarding issues every organisation
`theirname.tatvaos.com`, working immediately — without a wildcard each new
customer waits on a manual DNS change. The cost is that *every* unregistered
name resolves, so anything served on a guessable hostname becomes publicly
reachable rather than merely unlisted. Keep nothing sensitive on one.

---

# 2. trineetra.com — a customer

This is what every customer does, and `trineetra.com` is the first one, so it
should go through exactly the path a real customer will: onboard it in the
console, then verify it from the organisation's own Domains screen.

**Change the records already added** — they currently point at
`mail.trineetra.com`, which is no longer the mail host.

| Type | Host | Current | Change to |
|---|---|---|---|
| MX | `@` | `mail.trineetra.com` (10) | **`mail.tatvaos.com`** (10) |
| TXT | `@` | `v=spf1 a:mail.trineetra.com ip4:… -all` | **`v=spf1 include:_spf.tatvaos.com -all`** |
| TXT | `tv2026a._domainkey` | the hostname, by mistake | **the DKIM value below** |
| TXT | `_dmarc` | `v=DMARC1; p=none; …` | correct already |

**Remove:** the `A mail` record and the `A *` wildcard. Neither is needed on a
customer domain, and the wildcard actively hides mistakes — it is what made the
malformed `10mail.trineetra.com` MX record appear to resolve.

**Add:** the ownership TXT record the console gives you when you onboard the
organisation. That is the one that actually gates activation.

---

## The DKIM value

Same key for both domains for now — one signing key, one selector. Rotate to a
per-domain key before real customers, and note that the private half lives only
on the server and in Bitwarden.

One line. No line breaks, no spaces after the semicolons.

```
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAngl+9r45H+afp4N7bEQKBC5duQglSi+g4b52RprK56wucuCwI5SImcZvnb09ZQ+bL4ekdefMnLhMfqH7s6bZqr5YvN59MyjYIEaMdXleXdDWksrDjNAkiIHTrvY7wEdf/8pHrrNm7EVUTyRmG3ex0gsEx4ys940VUwP9GqfiP6k7wADZIx3lup5x84XEsTFLGIjaNSVsy4Aeoqx0Mbjdh2Qct6ETWM1kvoGIYzEAaGOgR50/sgZH9UP/bif/dcZM58BIpk1Q5DiL60pvnw9UP8kuEqmo3gJHBmMX0a0DtWlyjW59XtL3PLy8dGe35AyzU4Xd9osgEVKu0D4rNK7KCwIDAQAB
```

In GoDaddy the **Name** field is `tv2026a._domainkey` — it appends the domain
itself. Typing the full name creates
`tv2026a._domainkey.trineetra.com.trineetra.com`, which is what happened the
first time.

---

## Two rules that would have prevented every mistake so far

**1. Priority goes in the Priority field.** `10 mail.tatvaos.com` in the value
box produces a hostname called `10mail.tatvaos.com`. With a wildcard present it
even resolves, which is worse than failing.

**2. Two DMARC records mean you have none.** RFC 7489 requires receivers to
treat multiple records as no policy at all. If a host added one, delete theirs.
