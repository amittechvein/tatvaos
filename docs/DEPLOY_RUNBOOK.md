# Deploying to production

Every step here exists because skipping it cost us something real. The
parenthetical after a step is the day it bit, kept so nobody removes a line
that looks like ceremony.

---

## 0. Before you touch anything

**You are deploying ALL of `main`, not your change.** A deploy ships every
lane's work merged since the last one. If it breaks something that is not
yours, it is still your deploy. Say in the team channel that you are starting
— one deployer at a time.

---

## 1. In your lane folder

```
cd <your lane folder>
git fetch origin
git merge --no-edit origin/main
```

Then build **both**, even if you only touched one:

```
npm --prefix apps\web run build
dotnet build apps\api
```

The point of building after the merge is not your change. It is the
combination — your work plus whatever four other lanes pushed while you were
writing it. (8 Sept: a merge brought 99 files from four days of other lanes.)

**If your change includes a migration**, the folder must replay from empty.
`infra/scripts/verify-migrations.sh` needs Docker or a local PostgreSQL; the
Windows deploy machine has neither, so it cannot run there. Get it run
somewhere that can before you push — CI does it on every pull request, and
it can be done by hand in any environment with `initdb`. A migration that has
only been reasoned about has not been checked. (3 Sept: a fresh install had
been broken for weeks and production could not notice, because the objects
already existed there.)

---

## 2. Push

```
git push origin lane/connect:main
```

Pushing from the lane worktree rather than the main folder is deliberate: the
main folder is repeatedly found on somebody's feature branch, mid-merge.
(8 Sept, twice; 9 Sept.)

If the push is rejected as non-fast-forward, somebody pushed in the seconds
between your fetch and your push. Pull, rebuild, push again. Two rejections in
a row means wait — do not fight over the branch.

---

## 3. On the server

```
ssh tatvaos-production
cd /srv/tatvaos-production
```

**These commands run on the SERVER.** Running `./infra/scripts/deploy.sh` in a
PowerShell window does nothing at all and prints nothing, which reads exactly
like success. (9 Sept, during an outage.)

```
git branch --show-current
```

**It must say `main`.** Found on a feature branch four times in two days,
twice on this box. `deploy.sh` refuses to deploy from a branch, which is the
only reason none of those shipped.

```
git fetch origin
git reset --hard origin/main
./infra/scripts/deploy.sh production
```

### The rollback point

**Do not use `git rev-parse --short HEAD` before the reset.** On a
wrong-branch checkout that returns the feature branch's tip — a commit that
was never deployed. Rolling back to it during an incident would ship
unreviewed work. (9 Sept: the number written down was exactly this.)

**Read the running version off the build badge** at the bottom right of
`core.tatvaos.com` instead. That is what is actually serving.

### While it builds

The "Pulling and building" stage prints nothing, sometimes for ten minutes or
more — longer after a lockfile change, because Docker can reuse no cached
layers. **Do not press Ctrl+C.** An interrupted deploy leaves half-built
containers, which is far worse than waiting. To check it is alive, open a
second terminal and run `top -bn1 | head -20`; the old containers keep serving
throughout. (8 Sept: seven silent minutes with the terminal's output lost.)

---

## 4. Afterwards

> **The deploy deliberately trips a rate limiter.** `verify-live.sh` proves
> the org-API limit holds through Caddy by sending 31 requests with spoofed
> `X-Forwarded-For` and expecting the 31st to be refused (CTO, 19 Sept 2026).
> So every deploy produces exactly one `429` on `/api/v1/org/people` from the
> server's own address — twice, if the script is run again by hand. Harmless
> today. The day anybody adds alerting on 429s, the deploy will set it off,
> and the person on call will be chasing a check. Exclude the server's own
> address from that alert, or expect one 429 per deploy.

> **Never put a CDN in front without reconfiguring every rate limiter in
> the same change.** Every limiter in `apps/api/Program.cs` keys on the
> *rightmost* `X-Forwarded-For` entry, which is the real client only because
> Caddy is the one proxy in front. Behind Cloudflare or any CDN, the rightmost
> entry becomes the CDN's own address, so every visitor shares one bucket. The
> public careers page (120 reads a minute) would then be down for everyone at
> once. Whoever adds a CDN switches the limiters to the CDN's client-IP header,
> trusted only from the CDN's published ranges (Mr. Singh, 24 Sept 2026,
> PR 275).

The deploy runs `verify-live.sh` itself and refuses to report success if it
fails, so `production deployed` is a real verdict, not an inference.

Then **use the thing you changed.** A green build proves the code compiles. It
does not prove the feature works, and four features shipped this week were
confirmed only by a build until somebody finally opened a meeting.

### If the deploy carries an AI change

Its deploy note states two things (Mr. Singh, 30 Sept and 1 Oct 2026):

1. **Who is on each AI list** at that moment: `ai.mail.organisations`,
   `ai.connect.organisations`, `ai.docs.organisations` (the deploy prints
   them once PR 365 is live).
2. **That the OpenAI sharing settings were checked off**, and when: the three
   Sharing options Disabled and retention as recorded in
   `docs/runbooks/backup-and-restore.md`, "Provider settings". This is read
   in Amit's browser; it cannot be read from the server. If it was not
   checked, the note says so - it does not say "checked".

### If something is broken

1. `docker logs --tail 40 tatvaos-api-1` — the API's own startup and worker
   errors say more than any dashboard.
2. `docker logs --tail 20 tatvaos-web-1`
3. `curl -s -o /dev/null -w "%{http_code}\n" https://core.tatvaos.com/health`

**`/health` answering 200 does not mean the system works.** It does not touch
the database. On 9 September the API returned 200 while every single database
call threw and nobody could log in. The deploy's own pre-swap gate uses that
same endpoint, so it will wave through a build whose every query fails.

Fixing forward is usually not slower than rolling back — both need a full
deploy cycle — and a rollback takes out every other lane's work too. Roll back
when the cause is unclear; fix forward when it is one known line.

---

## Changing the server's settings file (`infra/docker/.env`)

That one file holds every production secret: database passwords, signing
keys, mail and SMS credentials. **A copy of it is the same secret, in a
second place.**

**The rule (Mr. Singh, 28 Sept 2026 — the same rule #254 applied to the
pre-deploy database copies):**

1. **A copy of `.env` is created with `umask 077`, or not at all.** Never a
   bare `cp`.
2. **The name carries the reason and the UTC time**, so nobody has to guess
   what it was for or how old it is. The file's own date cannot be trusted:
   `cp -p` carries the *original's* date onto the copy.
3. **Copies older than seven days are removed** — by a person, saying which
   ones, never by a deploy.
4. **`.env` itself is `600`, owner `deploy`.** Nothing else reads it: compose
   substitutes its values when it renders the services, and no container
   mounts the file.

```bash
cd /srv/tatvaos-production/infra/docker
( umask 077; cp .env ".env.before-<reason>-$(date -u +%Y%m%dT%H%M%SZ)" )
# ... make the change ...
stat -c '%a %n' .env .env.*          # every line must start 600
ls .env.before-* .env.*backup* 2>/dev/null   # anything older than 7 days goes
```

**Why this rule exists.** On 28 Sept 2026 `.env` was found at mode **664**
— readable by every account on the server — with three copies beside it the
same way, one of them 52 days old. Nobody chose that: the `deploy` account's
default umask is `002`, so *every* file it creates is born group-writable and
world-readable unless the command says otherwise. Only `root` and `deploy` can
log in, so nothing is known to have read them; but one compromised service
account on that machine would have been handed everything. They were set to
`600` that day (Amit's go), with no restart and no service affected.

**What this does not cover.** Anything else the `deploy` account writes is
still born `664`. `/home/deploy` is `750` and `/srv/backups/tatvaos` is
`700`, so their contents are protected by the folder; **the checkout under
`/srv/tatvaos-production` is not** (`755`). A secret written anywhere inside
the checkout needs the same `umask 077`.

---

## What each guard actually catches

| Guard | Catches | Does NOT catch |
|---|---|---|
| `dotnet build` | Compile errors | EF model errors — those are runtime (9 Sept outage) |
| `npm run build` | Type and lint errors | Anything visual |
| `verify-migrations.sh` | A fresh install failing | Application code |
| deploy pre-swap `/health` | An API that will not start | An API that starts and cannot query |
| `deploy.sh` branch check | Deploying a feature branch | The same mistake locally |
| `verify-live.sh` | Dead services, IMAP, SMTP, queue | Whether your feature works |

Nothing in that table checks that the thing you built does what you said it
does. That is still a person opening the page.
