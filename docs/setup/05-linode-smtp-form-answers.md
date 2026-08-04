# Linode SMTP Restriction Removal — Form Answers

Copy-paste ready. Written to be **accurate about what exists today** — things not yet built are stated as design commitments, not as present-tense facts. Reviewers check, and an overstated application is worse than an early-stage one.

---

## Field 1 — Email use case and how you'll avoid unwanted email

> **What this server does**
>
> I am building TatvaOS Mail, a multi-tenant business email hosting platform — mailbox hosting for organisations on their own domains, in the same category as Google Workspace, Microsoft 365 or Zoho Mail. Each customer organisation verifies ownership of its domain, then creates mailboxes for its staff.
>
> The mail is **person-to-person business correspondence**: an employee writing to a colleague, a customer, or a supplier. There is no bulk sending, no marketing campaigns, no mailing lists, and no purchased or scraped recipient data. This is not an ESP or a campaign platform.
>
> **Current stage and volume**
>
> The platform is in early development. This Linode is being used to validate deliverability before any customer exists. Immediate volume is a handful of test messages per day, sent to inboxes I control and to mail-tester.com. I expect fewer than 100 messages per day for the next several months, growing slowly and only as real paying organisations onboard.
>
> **How unwanted email is prevented**
>
> Controls already in place:
>
> - **Domain ownership verification.** No mail is accepted for a domain until the owner has published a verification TXT record. Nobody can send as a domain they do not control.
> - **SPF, DKIM and DMARC configured per sending domain**, with a dedicated DKIM key per domain rather than a shared platform key.
> - **Unknown recipients are rejected during the SMTP transaction** (550) rather than accepted and bounced. The server is not a backscatter source.
> - **Not an open relay.** Relaying is refused for any domain the server does not host; this is explicitly asserted by an automated test on every build.
> - **Forward-confirmed reverse DNS** on the sending address.
>
> Controls that are designed and will be enforced before any customer sends mail:
>
> - **No outbound sending on unpaid or unverified accounts**, or a hard daily cap where a trial is offered.
> - **Per-user and per-tenant outbound rate limits.**
> - **Bounce and complaint handling** with an automatic suppression list.
> - **A monitored `abuse@` mailbox** with a documented response process, and the ability to suspend an individual tenant immediately without affecting others.
> - **Registration with Google Postmaster Tools and Microsoft SNDS/JMRP** so that complaint rates are monitored continuously rather than discovered via a blocklisting.
>
> **On compliance**
>
> All sending is CAN-SPAM compliant. As an India-based operation I am also building to the DPDP Act 2023 requirements. Because this is mailbox hosting rather than bulk mail, recipients are corresponding with a person who wrote to them individually.
>
> **If a complaint reaches you**
>
> I would like to be contacted at the account address, and I will respond within one business day with the tenant identified, the mail logs for the message concerned, and the action taken. I would rather find out from you and suspend a bad tenant immediately than have the IP blocklisted.

---

## Field 2 — Domains that will send email

> **tatvaos.com** — sending host `mail.tatvaos.com` (172.105.57.198)
>
> Additional customer domains will be added over time, each only after the owner has completed DNS-based ownership verification and published SPF and DKIM records delegating to this platform.

If you will also send from Techvein's own domain, add it:

> **techvein.com** — the operating company

---

## Field 3 — Links to public information

**This is the weak part of the application, and it is fixable in an hour.**

Linode is looking for evidence that a real, identifiable business is behind the request. A brand-new domain with no website, requesting SMTP access, matches the shape of a throwaway spam operation — regardless of your intent.

Supply what genuinely exists:

> - Company: https://techvein.com
> - Product: https://tatvaos.com
> - Contact: tech_ai2@techvein.com

Add any of these you actually have: LinkedIn company page, GitHub organisation, GST registration number, company registration number, Twitter/X.

### Before you submit — put something on tatvaos.com

A single static page is enough, and it changes how the request reads:

- What TatvaOS Mail is, in two or three sentences
- That it is business email hosting for organisations
- Company name, registered address, contact email
- A `/privacy` and an `/abuse` page — even a paragraph each

The abuse page matters more than it looks. It tells a reviewer you have thought about the thing they are worried about.

**Also make `abuse@tatvaos.com` and `postmaster@tatvaos.com` deliverable**, even as forwards to your normal inbox. RFC 2142 expects them, reviewers check, and an unroutable `abuse@` is a genuine red flag.

---

## Realistic expectation

The use case is legitimate and clearly explained, DNS is correctly configured, and the anti-abuse answer is more thorough than most applications. That is a strong position.

The two things that could still cause a decline or a follow-up question:

1. **No public web presence** — fix before submitting.
2. **Multi-tenant sending on behalf of other domains** makes some providers cautious, because it is exactly what a spam operation looks like. The mitigation is the domain-verification requirement, so make sure that point is prominent.

If Linode declines anyway, that is information rather than a wall: go relay-first as described in architecture §12, which for a solo build is the expected path regardless. This request mainly determines whether you keep the own-IP option open.
