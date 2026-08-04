# What a client has to add to their DNS

**Two stages, and the gap between them can be weeks.** That separation is the
whole design: a client can start using TatvaOS on day one with one harmless TXT
record, and move their actual mail across whenever they are ready.

Collapsing these into "add five records before you can log in" is how onboarding
stalls — the person evaluating the product is almost never the person who can
edit DNS.

---

## Stage 1 — Onboarding. One record. Nothing breaks.

**Added by:** us, in the super-admin console, when we create the organisation.
**Given to:** the client, as a single record to publish.

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `tatvaos-verification=<token per domain>` |

**What it does:** proves they control the domain. Until this is found, TatvaOS
accepts no mail for the domain and nobody can send as it.

**What it does NOT do:** it does not touch their mail. Their existing provider
keeps receiving everything, exactly as before. A TXT record has no effect on
delivery — this is worth saying to the client explicitly, because it is the
thing they are worried about.

### What they can do once it verifies

Nothing about their mail changes, but their organisation is live:

- Sign in and administer their organisation
- Create people, categories, mailboxes
- Send and receive on the TatvaOS address they were issued at onboarding
  (`theirname.tatvaos.com`) — a working address that needs no DNS from them

**Their own domain is verified but not yet receiving.** That is the intended
resting state, and a client can sit here as long as they like.

---

## Stage 2 — Moving their mail. Four records.

**Only when they are ready.** This is the step that changes delivery, and it is
the only irreversible-feeling one — so it is deliberately separate, and the
console says so.

| # | Type | Host | Value | Effect if missing |
|---|---|---|---|---|
| 1 | MX | `@` | `mx.tatvaos.com` · priority `10` | Mail keeps going to their old provider |
| 2 | TXT | `@` | `v=spf1 include:_spf.tatvaos.com -all` | Their outbound is likely marked as spam |
| 3 | TXT | `<selector>._domainkey` | `v=DKIM1; k=rsa; p=…` | Receivers cannot verify our signature |
| 4 | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:…` | No reporting, weaker anti-spoofing |

**Only #1 changes where mail goes.** The other three affect how their outbound
is judged. A client can add 2–4 first, days ahead, and flip MX when they choose
— which is the safe order and what the console recommends.

### Two traps that cost clients real mail

**Delete the old MX records.** Leaving the previous provider's MX alongside ours
means mail arrives at whichever responds first. Half their mail lands in a
mailbox nobody is watching, and it looks like intermittent loss rather than a
configuration error.

**Do not create a second SPF record.** If they already have one, the include
goes *into* it:

```
v=spf1 include:_spf.tatvaos.com include:whatever-they-had -all
```

Two SPF records is a specification error and receivers may ignore both. Removing
an existing include silently breaks whatever was using it — a CRM, an invoicing
system, a mailing list.

---

## Where the client signs in

### Default — no DNS needed

```
https://theirname.tatvaos.com
```

Issued at onboarding, working immediately, and undeletable. It is also the way
back in if their own domain's DNS ever breaks — which is precisely when they
most need to get in.

### Optional — their own hostname

If a client wants `admin.theirdomain.com` instead:

| Type | Host | Value |
|---|---|---|
| CNAME | `admin` | `theirname.tatvaos.com` |

**This needs work we have not done yet.** A certificate must exist for their
hostname, which means Caddy on-demand TLS plus a check that the name really
belongs to a tenant — otherwise anyone pointing a CNAME at us makes us issue
certificates on demand for domains we have never heard of.

Worth building for larger customers. Not a launch requirement, and it should
not be offered until the TLS side is done.

---

## Who can verify

Both, deliberately.

**The client**, from their own console — Domains → their domain → Check again.
Live DNS lookups, per-record results, and the actual reason for each failure.

**We**, from the super-admin console. Necessary because the most common support
call is "we added the records and it still says not verified", and the useful
answer requires seeing what their DNS actually returns — which is usually a
typo, a stray trailing dot, or a value pasted with the hostname in it.

Both paths run the same `DomainVerifier`. A support tool that checks something
different from what the customer's screen checks is worse than no support tool.

---

## What the checker reports

Five independent results, not one flag:

| Check | Gates activation | Meaning |
|---|---|---|
| **Ownership** | **Yes** | They control the domain |
| MX | No | Mail is directed here |
| SPF | No | We may send as them |
| DKIM | No | Signatures validate |
| DMARC | No | A policy exists |

**Only ownership gates anything.** A client mid-migration legitimately has old
MX records for days, and refusing to activate them over it helps nobody.

One flag instead of five is what produces the ticket that reads *"it says
verified but mail bounces"* — ownership proven with MX still elsewhere is a
completely different problem with a completely different fix, and the admin has
to be told which one they have.
