# Hosting Provider Enquiry — Phase 0 Go/No-Go

> **Superseded — Linode chosen.** Follow `04-linode-smtp-unblock.md` instead.
> Kept for the evaluation criteria, which stay useful if Linode declines the
> unblock or a second provider is needed later.

**Purpose:** get written confirmation of three things before paying any provider.
**Why it matters:** discovering that port 25 is blocked, or that reverse DNS cannot be delegated, *after* building on a provider is expensive and entirely avoidable.

---

## The email

> **Subject:** Pre-sales: outbound port 25, rDNS delegation and SMTP policy
>
> Hello,
>
> I am evaluating providers for a business email hosting platform and need to confirm a few technical points before purchasing. I would appreciate answers in writing.
>
> **1. Outbound SMTP**
> Is outbound TCP port 25 open on new instances, or blocked by default? If blocked, what is the process and timeline to have it unblocked, and are there prerequisites such as account age or a settled invoice?
>
> **2. Reverse DNS**
> Can I set the PTR record for assigned IPv4 addresses myself, via the control panel or API? I need the PTR to match my mail server's hostname exactly.
>
> **3. Acceptable use**
> Does your AUP permit running a mail server that sends on behalf of multiple customer domains? This is business mailbox hosting, not bulk or marketing email.
>
> **4. IP reputation**
> Can you confirm whether the IPs I would be assigned have prior blocklist history, and can I check a specific address before committing?
>
> **5. Additional addresses**
> Can I obtain further IPv4 addresses on the same account later? I expect to segment outbound traffic across several addresses.
>
> **6. Abuse handling**
> If you receive a spam complaint about my server, what is the process? Specifically, is there notice and an opportunity to respond, or is suspension immediate?
>
> **7. Data residency**
> Which regions can I deploy in, and do you offer capacity in India?
>
> Thank you,
> Amit Dadhich
> Techvein

---

## How to read the reply

Ask precisely and you get answers you can hold them to. "Do you allow email servers?" gets a vague yes; naming port 25 egress and PTR delegation does not.

| Answer | Read it as |
|---|---|
| "Port 25 open by default" | Green. Verify with an actual test before scaling |
| "Unblocked on request after N days / first invoice" | Fine, but it is a **lead-time item — start the clock now** |
| "Use our SMTP relay instead" | Port 25 is blocked and will stay blocked. Not viable for an MX host |
| "Contact us after purchase" | Refusal in polite form. Walk away |
| PTR set via panel or API | Green |
| "Raise a ticket for each PTR change" | Workable but slow; painful once you have several IPs |
| PTR not delegable | **Disqualifying.** Gmail and Outlook check forward-confirmed rDNS |
| No answer on abuse process | Ask again. Immediate suspension with no notice is a real operational risk |

**The disqualifying answers are the two DNS ones.** Everything else has a workaround; a missing or wrong PTR does not — receivers check it, and mail without matching forward-confirmed reverse DNS lands in spam regardless of how correct everything else is.

---

## Provider landscape, August 2026

Verify each of these yourself — policies change and vary by data centre. This is a starting shortlist, not a recommendation.

| Provider | Port 25 | Notes |
|---|---|---|
| **OVH** | Open by default | Varies by data centre; outbound anti-spam filtering applied. Has Asia-Pacific capacity |
| **Hetzner** | **Blocked on new accounts** | Lifts on request after roughly 30 days and a settled invoice, with a stated legitimate use case. PTR configurable from the console. Port 587 open from day one |
| DigitalOcean / Vultr | Blocked | Unblock possible by ticket; outcome inconsistent |
| AWS / Azure / GCP | Blocked | Removal is slow and often refused. Not suitable as an MX host |
| Indian providers | Unverified | Ask directly. Relevant for DPDP data residency — see architecture §10 |

**The Hetzner detail is the important one:** the ~30-day wait is a hard scheduling dependency. If Hetzner is a candidate, open the account and settle an invoice *now*, in parallel with everything else, rather than discovering the delay when you are ready to test.

---

## After they answer

Do not trust the answer alone — test it.

```bash
# from the new VM: is 25 actually open outbound?
telnet gmail-smtp-in.l.google.com 25
# or
swaks --server gmail-smtp-in.l.google.com --to test@gmail.com --quit-after RCPT

# does the PTR resolve, and does it match forward?
dig -x <your.ip> +short
dig +short <that.hostname>      # must return <your.ip>
```

A PTR that does not forward-confirm is worse than no PTR — it looks like a misconfiguration to receivers.

---

## What this feeds

The answers close two open decisions from the architecture doc:

- **§17.1 — own IPs vs relay-first.** If port 25 is difficult, or the unblock has conditions you cannot meet, relay-first stops being a preference and becomes the only option. For a solo build that is the expected outcome regardless.
- **§17.3 — data residency.** India-only for v1, or multi-region.

Record the outcome as an ADR in `docs/decisions/`. Future you will not remember which provider said what, and a new developer has no way to reconstruct it.

---

## Also start now — these have real lead time

Independent of the provider question, all three have blocked launches by a fortnight:

| Item | Lead time |
|---|---|
| Microsoft SNDS registration | Days, manual approval |
| Apple Developer Program | 1–2 weeks, may need a D-U-N-S number |
| Razorpay KYC | 1–2 weeks |
