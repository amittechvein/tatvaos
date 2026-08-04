# DNS — tatvaos.com

**Mail host:** `mail.tatvaos.com`
**IPv4:** `172.105.57.198` (Linode)
**DKIM selector:** `tv2026a`

---

## Order matters

Steps 1 and 2 gate everything else. Linode will not accept the PTR until the
forward A record resolves to that IP, and Linode will not lift the SMTP block
until both directions confirm.

---

## 1. A record — do this first

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `mail` | `172.105.57.198` | 300 |

```bash
dig +short mail.tatvaos.com        # must return 172.105.57.198
```

## 2. Reverse DNS — Linode Cloud Manager

Linode → your instance → **Network** → the IPv4 → **Edit RDNS** → `mail.tatvaos.com`

If it refuses, step 1 has not propagated. Wait and retry.

```bash
dig -x 172.105.57.198 +short       # must return mail.tatvaos.com
```

Both directions must agree. A PTR that does not forward-confirm reads as
misconfiguration to receivers and is worse than having none.

## 3. MX

| Type | Host | Priority | Value | TTL |
|---|---|---|---|---|
| MX | `@` | 10 | `mail.tatvaos.com` | 300 |

A second MX on a different host comes later; one is fine for the spike.

## 4. SPF

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `v=spf1 ip4:172.105.57.198 -all` |

Start with `-all` (hard fail) rather than `~all`. You control the only sender,
so there is nothing to be lenient about, and a strict record scores better.

**Exactly one SPF record per domain.** Two is a permanent error, not a warning —
receivers treat it as `permerror` and every message fails SPF. If a record
already exists, merge them.

## 5. DKIM

| Type | Host | Value |
|---|---|---|
| TXT | `tv2026a._domainkey` | see below |

```
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAngl+9r45H+afp4N7bEQKBC5duQglSi+g4b52RprK56wucuCwI5SImcZvnb09ZQ+bL4ekdefMnLhMfqH7s6bZqr5YvN59MyjYIEaMdXleXdDWksrDjNAkiIHTrvY7wEdf/8pHrrNm7EVUTyRmG3ex0gsEx4ys940VUwP9GqfiP6k7wADZIx3lup5x84XEsTFLGIjaNSVsy4Aeoqx0Mbjdh2Qct6ETWM1kvoGIYzEAaGOgR50/sgZH9UP/bif/dcZM58BIpk1Q5DiL60pvnw9UP8kuEqmo3gJHBmMX0a0DtWlyjW59XtL3PLy8dGe35AyzU4Xd9osgEVKu0D4rNK7KCwIDAQAB
```

That string is 410 characters, above the 255-character limit for a single TXT
string. Most DNS panels split it automatically — paste it as one line and let
them. If yours rejects it, split into quoted 255-char chunks; DNS concatenates
them back.

The matching private key is `infra/dkim/tv2026a.key`, gitignored.

## 6. DMARC

| Type | Host | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@tatvaos.com; ruf=mailto:dmarc@tatvaos.com; fo=1; adkim=r; aspf=r` |

**Start at `p=none`.** It publishes nothing enforceable — it only asks receivers
to send you reports. Going straight to `p=reject` before you can read those
reports is how people silently discard their own legitimate mail.

Progression, roughly a month: `p=none` → read reports for 2 weeks → `p=quarantine`
→ 2 more weeks → `p=reject`.

You need `dmarc@tatvaos.com` to exist and be readable, or the reports go nowhere.

## 7. Optional but worth having

| Type | Host | Value | Why |
|---|---|---|---|
| TXT | `@` | `v=spf1 ...` (already above) | |
| CNAME | `autodiscover` | `mail.tatvaos.com` | Outlook auto-setup |
| SRV | `_imaps._tcp` | `0 1 993 mail.tatvaos.com` | Client auto-config |
| SRV | `_submission._tcp` | `0 1 587 mail.tatvaos.com` | Client auto-config |

---

## Verify everything

```bash
dig +short mail.tatvaos.com
dig -x 172.105.57.198 +short
dig +short tatvaos.com MX
dig +short tatvaos.com TXT
dig +short tv2026a._domainkey.tatvaos.com TXT
dig +short _dmarc.tatvaos.com TXT
```

Then the two that actually matter:

- **mail-tester.com** — send it a message, target 10/10
- **Google Postmaster Tools** — add tatvaos.com now, before you need the history

---

## Before any of this reaches Gmail

Check the IP's history. Linode recycles addresses, and inheriting a blocklisted
one is worth knowing about on day one rather than after a week of confusing
results.

- MXToolbox blacklist check on `172.105.57.198`
- Spamhaus lookup

If it is listed, ask Linode for a different address. That is a normal request.
