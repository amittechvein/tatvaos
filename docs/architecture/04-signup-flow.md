# Signup

```
   ┌──────────────────────────────────────────────────────────┐
   │  SIGNUP WIZARD  (public, no account needed)              │
   │                                                          │
   │  1 Organisation    name · type · country · GST           │
   │  2 Administrator   name · email · phone                  │
   │  3 Domain          the domain they will use              │
   │  4 Verify          choose a method, publish, check       │
   └────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
        verification fails          verification passes
              │                           │
              ▼                           ▼
   ┌────────────────────┐      ┌──────────────────────────────┐
   │  SAVED AS DRAFT    │      │  ACCOUNT CREATED             │
   │                    │      │                              │
   │  Nothing is lost.  │      │  tenant + owner + domain     │
   │  They resume from  │      │  → admin.tatvaos.com         │
   │  a link.           │      └──────────────┬───────────────┘
   │                    │                     │
   │  VISIBLE TO US as  │                     ▼
   │  a lead — someone  │      ┌──────────────────────────────┐
   │  who wanted this   │      │  INSIDE THE CONSOLE          │
   │  and got stuck.    │      │                              │
   └────────────────────┘      │  Want email? → MX, SPF,      │
                               │  DKIM, DMARC records         │
                               │        ↓                     │
                               │  Then: add users             │
                               │  Billing lives here too      │
                               └──────────────────────────────┘
```

---

## Why a draft rather than a half-made account

A signup that fails at the domain step is the most valuable thing on this
screen. Somebody typed their organisation's name, their own name, and their
phone number into a form because they wanted the product — and then hit a step
that needs DNS access they may not have.

Throwing that away is throwing away a lead. Creating a broken tenant instead is
worse: an organisation row with no verified domain, no owner who can sign in,
and no way to tell it apart from a real customer in every count and report.

So the draft holds everything until verification succeeds, and **no tenant
exists until it does**. One state, not two half-states.

**The draft is also a sales queue.** Techvein sees who started and stalled, with
a contact number. In this market — schools, clinics, small businesses — the
person evaluating software is very often not the person who can edit DNS, and a
phone call resolves in five minutes what a help page will not resolve at all.

---

## The cost of gating access on verification

Worth stating plainly, because it is a real trade and it goes the other way from
what I built earlier.

**Requiring verification before console access means some genuine customers
never get in.** The office manager trialling this at a school cannot always
reach whoever set up their DNS. Every additional step before value is seen
loses people.

**What makes it acceptable here** is the draft. They are not turned away — they
are captured, and followed up by a human. That converts better than a
self-service path the customer abandons silently.

**What would make it unacceptable** is dropping the draft, or not calling the
leads. If nobody works that queue, this design is strictly worse than issuing a
free subdomain and letting them in immediately.

---

## Verification methods

Four, because DNS panels differ and some customers cannot edit DNS at all but
can upload a file to their website.

| Method | What they add | Best for |
|---|---|---|
| **TXT** *(recommended)* | `TXT @ = tatvaos-verification=<token>` | Anyone with DNS access |
| **CNAME** | `CNAME <token>._tatvaos → verify.tatvaos.com` | Panels that reject long TXT values |
| **HTML file** | `/.well-known/tatvaos-<token>.txt` on their site | Web access but no DNS access |
| **Meta tag** | `<meta name="tatvaos-verification" content="<token>">` | Site editors like Wix or Squarespace |

**TXT first, and labelled as recommended.** It is the only one that survives the
customer later moving their website — the other three break the moment their
site changes host, and a verification that silently lapses is worse than one
that was never made.

**All four prove the same thing:** control of the domain. None of them affect
mail. Their existing email is untouched — this is the sentence that has to
appear on the screen, because it is what they are afraid of.

---

## Mail is a separate, later step

Verification gets them into the console. It does **not** move their mail.

Inside, "Set up email" shows the four records — MX, SPF, DKIM, DMARC — with only
MX changing where mail goes, and it says so. A customer can use TatvaOS for
people, categories and billing for weeks before touching their mail.

**Users cannot be created until mail is set up**, because a mailbox on a domain
that does not route here would silently fail to receive. Better to require the
records than to create fifty accounts that do not work.

---

## What Techvein sees

| Screen | Shows |
|---|---|
| Organisations | Real customers — verified, with an owner |
| **Drafts** | Stalled signups, with contact details and the step they stopped at |
| Domains | Every domain and its five check results, for support calls |

The drafts screen is the one that pays for this design. Without it this is just
a stricter signup form.
