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

The deploy runs `verify-live.sh` itself and refuses to report success if it
fails, so `production deployed` is a real verdict, not an inference.

Then **use the thing you changed.** A green build proves the code compiles. It
does not prove the feature works, and four features shipped this week were
confirmed only by a build until somebody finally opened a meeting.

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
