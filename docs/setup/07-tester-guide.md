# Tester Guide — TatvaOS Mail

**For:** anyone testing the platform who does not write the code.
**You need:** Docker Desktop. Nothing else.

---

## Why there is a webmail client here

The TatvaOS web app does not exist yet — it arrives in Phase 1. So the test environment includes **Roundcube**, an open-source webmail client, which talks to our server over IMAP and SMTP exactly as Outlook or Thunderbird would.

That makes it a genuine test of the server rather than a simulation of one. If mail works in Roundcube, it works — because Roundcube was written by people who have never seen our code.

---

## Start it

```bash
cd local
docker compose up -d --build
docker compose --profile testers up -d
./scripts/seed-testers.sh
```

Then open **http://localhost:8000**

| Thing | Where |
|---|---|
| **Webmail (this is your main tool)** | http://localhost:8000 |
| Sent mail, caught safely | http://localhost:8025 |
| Database browser | `docker compose --profile tools up -d` → http://localhost:8080 |

**Nothing you send can reach the real internet.** Everything outbound is captured by Mailpit. Send whatever you like to whatever address you like — it lands at localhost:8025 and goes nowhere else.

---

## Accounts

Password for every one: **`devpass123`**

### Techvein — a normal small business

| Address | Notes |
|---|---|
| `amit@techvein.local` | Main account. ~150 messages, aliases `ceo@`, `director@`, `sales@`, `info@`, `careers@` |
| `hr@techvein.local` | **Nearly full** — 9.5 MB of a 10 MB quota |
| `support@techvein.local` | Shared mailbox |
| `former.employee@techvein.local` | **Disabled** — mail to it must be rejected |

### ABC School

| Address |
|---|
| `principal@abcschool.local` |

### City Clinic

| Address | Notes |
|---|---|
| `reception@cityclinic.local` | Shared mailbox |
| `dr.sharma@cityclinic.local` | |

### Rival Corp — the control

| Address | Notes |
|---|---|
| `ceo@rivalcorp.local` | **Exists only so you can prove nobody else can see it** |

---

## What to test

### 1. The basics

- [ ] Sign in as `amit@techvein.local`
- [ ] Read a message
- [ ] Send a message to `principal@abcschool.local`, confirm it arrives
- [ ] Reply, forward, delete, move between folders
- [ ] Attach a file and send it
- [ ] Search for a word you know is in a message

### 2. Aliases

- [ ] Send to `ceo@techvein.local` — it must arrive in Amit's inbox
- [ ] Same for `sales@`, `info@`, `careers@`

### 3. Tenant isolation — the most important section

This is the property the whole product exists to provide. **Try to break it.**

- [ ] Sign in as `ceo@rivalcorp.local`. Can you see *anything* belonging to Techvein, ABC School or City Clinic? You must not.
- [ ] Search from Rival Corp for words you know exist in Techvein mail. Nothing should come back.
- [ ] Sign in as `principal@abcschool.local`. Search for "CONFIDENTIAL". You should see only ABC School's own message.
- [ ] Try guessing another tenant's folder or message URL directly.

**If you ever see one organisation's data while signed in as another, stop testing and report it immediately.** That is the single most serious class of bug in this product.

### 4. Things that should fail

Good testing includes confirming that the right things break.

- [ ] Send to `nosuchuser@techvein.local` → should be rejected, not silently accepted
- [ ] Send to `former.employee@techvein.local` → disabled, should be rejected
- [ ] Sign in with a wrong password → should fail
- [ ] Fill `hr@techvein.local` past its quota → should warn, then refuse

### 5. Awkward content

Real mail is messy. Try:

- [ ] Very long subject lines
- [ ] Non-English text — Hindi, Tamil, emoji, right-to-left script
- [ ] An HTML message with images
- [ ] A large attachment (over 25 MB should be refused)
- [ ] A message with no subject, or no body
- [ ] Deeply nested reply chains

---

## Reporting a bug

Copy this into your report:

```markdown
**What I did**
1.
2.
3.

**What I expected**

**What actually happened**

**Account used**
amit@techvein.local

**Where**
Roundcube / Mailpit / other

**Severity**
[ ] Blocker — cannot continue
[ ] Serious — wrong behaviour, no workaround
[ ] Minor — cosmetic or has a workaround
[ ] ISOLATION — one tenant saw another's data  ← always report immediately

**Screenshot**
```

**Isolation bugs are always top severity**, regardless of how small they look. "I saw one subject line I should not have" is as serious as it gets.

---

## Useful commands

```bash
# Send a test message without using the UI
docker exec tv-postfix swaks \
  --server localhost:25 \
  --from someone@example.com \
  --to amit@techvein.local \
  --header "Subject: hello" --body "test"

# Watch mail arrive in real time
docker compose logs -f postfix dovecot

# Start over completely — wipes all mail and accounts
docker compose down -v && docker compose up -d --build
./scripts/seed-testers.sh
```

---

## What is deliberately not here yet

So these are not reported as bugs:

| Missing | Arrives |
|---|---|
| The TatvaOS web client | Phase 1 |
| Mobile apps | Phase 2 |
| Admin console | Phase 1 |
| Spam filtering | Phase 1 |
| Sending to the real internet | Never in this environment, on purpose |
| Encryption on the connection | Local only; production uses TLS |

If Roundcube itself looks dated — it is. It is scaffolding so you can test the *server* now. The real client is being built.
