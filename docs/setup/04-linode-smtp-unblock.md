# Linode / Akamai — Getting SMTP Unblocked

**Decision:** hosting on Linode (Akamai Cloud).
**Status:** Sprint 0.1 blocker. Nothing in Phase 0 can be tested until this is done.

---

## The situation

Linode blocks outbound **ports 25, 465 and 587** by default on accounts created after 5 November 2019. All three — so even authenticated submission is dead until the block is lifted.

The good news: unlike DigitalOcean, Linode has a documented unblock path and routinely grants it for legitimate use. Linode also lets you set rDNS yourself from Cloud Manager, which is the capability that disqualifies most providers.

---

## The ordering trap

**Configure DNS *before* you open the ticket.** Linode's stated requirement is that valid forward A records and rDNS are already in place on the Linode you intend to send from.

Most people request the unblock first, get asked for DNS, and lose several days to a round trip. Do it in this order and it is usually one ticket.

There is a second dependency inside this: **Linode validates forward-confirmed rDNS before it will let you set the PTR.** The A record must already resolve to that IP, or the Cloud Manager rejects the entry. So DNS propagation sits on the critical path.

---

## Ordered checklist

### 1. Domain

Register the throwaway test domain from Sprint 0.1. Not `techvein.com` — never experiment on a domain whose reputation you care about.

### 2. Create the Linode

- Region: **Mumbai or Chennai if available** — relevant to DPDP data residency (architecture §10). Verify current region availability in Cloud Manager
- Ubuntu 24.04 LTS, to match your WSL environment
- Note the assigned IPv4 address

### 3. Forward DNS — do this first

```
A    mail.<testdomain>    ->  <linode IPv4>
```

Wait for it to resolve globally before continuing:

```bash
dig +short mail.<testdomain>        # must return the Linode IP
```

### 4. Reverse DNS in Cloud Manager

Linode Cloud Manager → your Linode → **Network** → the IPv4 address → **Edit RDNS** → enter `mail.<testdomain>`.

If it refuses, the forward record has not propagated yet. Wait and retry — this is the validation described above, not an error.

Confirm both directions:

```bash
dig -x <linode-ip> +short          # -> mail.<testdomain>
dig +short mail.<testdomain>       # -> <linode-ip>
```

Both must agree. A PTR that does not forward-confirm is worse than none — receivers read it as misconfiguration.

### 5. Open the support ticket

Only now. Include every element below; missing any of them causes a round trip.

> **Subject:** Request to lift outbound SMTP restrictions
>
> Hello,
>
> I would like the outbound SMTP restrictions (ports 25, 465, 587) lifted for the following Linode:
>
> - **Linode label:** `<label>`
> - **Linode ID:** `<id>`
> - **IPv4:** `<ip>`
> - **Hostname:** `mail.<testdomain>`
>
> Forward and reverse DNS are already configured and forward-confirm:
>
> ```
> dig +short mail.<testdomain>  ->  <ip>
> dig -x <ip> +short            ->  mail.<testdomain>
> ```
>
> **Use case:** I am building a multi-tenant business email hosting platform — mailbox hosting for organisations on their own domains, comparable to Google Workspace or Zoho Mail. This is transactional and personal correspondence, not bulk or marketing email.
>
> **Mailing practices:** all sending is CAN-SPAM compliant. Every customer domain is verified by DNS before any mail is accepted for it. SPF, DKIM and DMARC are configured per domain. Outbound is rate-limited per user and per tenant, and a monitored `abuse@` address is in place with a documented response process.
>
> Thank you,
> Amit Dadhich
> Techvein

### 6. Verify

Once they confirm:

```bash
# is 25 genuinely open outbound?
telnet gmail-smtp-in.l.google.com 25

# full path, stopping before actually delivering
swaks --server gmail-smtp-in.l.google.com --to you@gmail.com --quit-after RCPT
```

Then Sprint 0.2 proper.

---

## What to say if they push back

Their concern is spam, so answer it directly rather than restating the request. The points that carry weight:

- **Mailbox hosting, not bulk sending.** Volume per account is low and human-generated
- **Domain verification before acceptance.** No customer can send from a domain they have not proven they control
- **Rate limits per user and per tenant**, plus no outbound at all on unpaid trials
- **A monitored abuse address** with a stated response SLA
- **You will be doing the deliverability work** — Google Postmaster Tools, Microsoft SNDS, blocklist monitoring

If they still decline, that is a genuine signal rather than an obstacle: go relay-first (architecture §12) and revisit own-IP sending later. For a solo build, relay-first is the expected answer regardless — this ticket mainly determines whether you keep the option open.

---

## Sizing — 1 GB is right for now, wrong for Phase 1

Current instance: **1 vCPU / 1 GB RAM / 25 GB**  (Nanode).

**For Phase 0 this is fine, because Phase 0 only needs Postfix.** The question
being answered is "does mail from this IP reach a Gmail inbox" — that needs an
MTA, correct DNS, and nothing else. Do not install the full stack here.

What will *not* fit on 1 GB:

| Component | Reality |
|---|---|
| **ClamAV** | Needs 1–2 GB for its signature database alone. Will OOM-kill the box |
| Rspamd | ~300–500 MB with reasonable settings. Tight |
| PostgreSQL + Redis + Dovecot + Postfix together | Runs, but with no headroom |

**Plan:** resize to **4 GB before Phase 1**, and 8 GB by the time real tenants
exist. Linode resizing is a few minutes plus a reboot, and the disk grows with
it — so starting small costs nothing. Just do not mistake "Phase 0 works on
1 GB" for "the platform runs on 1 GB".

Add swap regardless; it turns an OOM kill into slowness:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Realistic timeline

| Step | Time |
|---|---|
| Domain + Linode | under an hour |
| DNS propagation | 15 min – 2 hours |
| Support ticket response | hours to a couple of days |
| **Total** | **same day to 2–3 days** |

Well short of Hetzner's ~30-day wait, which is the main reason Linode is a reasonable choice here.

---

## Record the decision

Write this up as `docs/decisions/0001-hosting-provider.md` once the ticket is answered: what you asked, what they said, and what would make you revisit. It closes §17.1 in the architecture doc, and in three months neither you nor a new developer will remember the reasoning.
