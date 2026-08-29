# Amit's guide — how to run commands safely

*Your file. Written for you, not for the developers. Keep it open while you work.*

You are not a developer and you don't need to become one. Your job with
commands is simple: **run them in the right window, one at a time, and paste
back what you see.** This file tells you how to do that without getting hurt.

---

## Part 1 — The two windows

Almost every mistake we've made came from running a command in the wrong place.
There are only two windows. Learn to tell them apart at a glance.

### Window A — your laptop

Opens as **PowerShell** on your own computer. The line where you type looks
like this:

    PS C:\Users\amitd\Downloads\tatvaOS>

**How you know:** it starts with `PS` and shows a `C:\` path with backslashes.

**What happens here:** the code is written, saved, and sent up to the internet.
Nothing here is live yet. Customers cannot see any of it.

### Window B — the server in Mumbai

You get there by typing one command in Window A:

    ssh -i C:\Users\amitd\.ssh\tatvaos_deploy deploy@172.105.57.198

After that, the line where you type changes to something like:

    deploy@localhost:~$

**How you know:** it starts with `deploy@` and uses forward slashes (`/srv/...`).

**What happens here: this is the live product.** Every customer is on this
machine. Be slower here.

To leave the server and come back to your laptop, type:

    exit

> **If you are ever unsure which window you're in**, press Enter on an empty
> line. The prompt reprints itself and tells you.

---

## Part 2 — Five rules that protect you

**1. One command per line. Always.**
Your PowerShell is an older version that cannot join commands with `&&`. If a
developer ever gives you `something && something`, that is a mistake — **send it
back**. On 21 August a joined command silently did nothing, and the deploy that
followed re-shipped old code while looking perfectly healthy.

**2. Run one, check, then run the next.**
Never paste a block of five commands and walk away. Run one. Look at the
result. If it's wrong, stop and paste it to me. Fixing one broken step is
minutes; unpicking five is an afternoon.

**3. Never paste a password or key into chat.**
Not to me, not to a developer, not anywhere. If a command's *output* is a
secret, that command was badly written — refuse it and ask for a version that
writes the secret straight to where it belongs. Every key we've ever printed on
screen has had to be thrown away and replaced.

**4. If you don't know what "good" looks like, don't run it.**
Every command a developer gives you should come with a line saying what a good
result looks like. If it doesn't, ask. You cannot be expected to judge output
you've never seen.

**5. When something fails, stop and paste it.**
Don't try the next command hoping it recovers. Don't retype it differently.
Copy the whole red message and send it. Nobody here minds. A failure caught at
step 2 is cheap; the same failure discovered at step 7 is not.

---

## Part 3 — The three jobs you actually do

### Job 1 — Send finished work to the internet (a "push")

*You do this after a developer says their work is ready and merged.*

Window A — your laptop. Start in the main folder:

    cd C:\Users\amitd\Downloads\tatvaOS

Check the code still builds. Two commands, **run them one at a time**:

    dotnet build apps\api

✅ **Good =** the last line says `Build succeeded` with `0 Error(s)`.
❌ If you see red text with the word `error`, stop and paste it.

    npm --prefix apps\web run build

✅ **Good =** it finishes with a list of pages and no red `Failed to compile`.
❌ Anything red, stop and paste it.

Only if **both** were green:

    git push origin main

✅ **Good =** a few lines ending with something like `main -> main`.
❌ If it says `rejected` or `failed`, stop and paste it.

> **Why both builds first?** Because pushing broken code means the server
> refuses to start, and fixing that under pressure is how mistakes multiply.
> Five minutes of checking buys you that safety.

---

### Job 2 — Put it live (a "deploy")

*Only after Job 1 succeeded.*

Window A — go to the server:

    ssh -i C:\Users\amitd\.ssh\tatvaos_deploy deploy@172.105.57.198

Now you're in Window B. Go to the product folder:

    cd /srv/tatvaos-production

**Write down where we are now, so we can come back if this goes wrong:**

    git rev-parse --short HEAD

It prints a short code like `73dac96`. **Copy it somewhere.** That is your
undo button. It takes two seconds and has saved us before.

Fetch the new code:

    git fetch origin

    git reset --hard origin/main

✅ **Good =** it prints `HEAD is now at <code> <message>` — and the code is
**different** from the one you just wrote down.

> ⚠️ **This line matters more than any other in this file.** If it names the
> *same* code you wrote down, then nothing new arrived — the push didn't work,
> and deploying now will change nothing while appearing to succeed. That exact
> trap wasted a deploy on 21 August. **Stop and tell me.**

Now deploy:

    ./infra/scripts/deploy.sh production

It will ask you to type a word to confirm. Type:

    production

✅ **Good =** you see these lines go past, in this order:

- `the new API starts and /health answers 200 — safe to swap`
- `all 11 services running`

❌ If it stops early, or the count is not 11, paste everything.

Then leave the server:

    exit

---

### Job 3 — Undo a bad deploy (a "rollback")

*Only if something broke and customers are affected.*

You need the short code you wrote down in Job 2. In Window B:

    cd /srv/tatvaos-production

    git reset --hard <the code you wrote down>

    ./infra/scripts/deploy.sh production

Type `production` when it asks. This puts the product back exactly as it was
before. **This is safe.** It is designed to be used. Don't hesitate out of
worry that you're doing something drastic — leaving customers on broken code is
the drastic option.

---

## Part 4 — Words developers use, in plain English

| They say | It means |
|---|---|
| **commit** | Save a set of changes with a note describing them. Still only on your laptop. |
| **push** | Send those saved changes up to the internet, where everyone can see them. Still not live. |
| **deploy** | Put the code onto the Mumbai server so customers actually get it. **This is the one that matters.** |
| **branch** | A separate copy of the code where someone works without disturbing others. |
| **main** | The one branch that is real. If it isn't on `main`, it isn't going live. |
| **merge** | Fold one person's branch into `main`. |
| **worktree / lane** | Each developer's own folder on your computer, so five people don't collide in one place. |
| **migration** | A change to the shape of the database. Runs automatically on every deploy. |
| **build** | Checking the code actually compiles before trusting it. |
| **rollback** | Undo — put yesterday's working version back. |

**The one sentence that clears up most confusion:**
*committed → pushed → deployed* are three different things, in that order.
Work can be finished and committed and still not be live. **"It's done" and
"customers have it" are not the same claim** — and we've been caught by that
difference more than once.

---

## Part 5 — Where things live on your computer

| Folder | What it's for |
|---|---|
| `C:\Users\amitd\Downloads\tatvaOS` | **The main folder.** You work here. Merging, building, pushing. |
| `...\tatvaos-core` | Core developer's folder |
| `...\tatvaos-mail` | Mail developer's folder |
| `...\tatvaos-connect` | Connect developer's folder |
| `...\tatvaos-space` | Space developer's folder |
| `...\tatvaos-platform` | Platform developer's folder |

**You only ever work in the main folder.** The five lane folders belong to the
developers. If a developer asks you to run something in one of theirs, that's
fine — but check the path in the command matches the folder they named.

---

## Part 6 — What you should push back on

You have more authority here than you may feel you do. Say no to any of these:

- A command with `&&` in it (in a laptop window)
- A command with no explanation of what good looks like
- A block of commands sent all at once with no checkpoints
- Any command that will print a password or key on your screen
- "Just run these, it'll be fine"
- A developer telling you something is **live** when you never ran a deploy for
  it — ask them which deploy it went out in. If they can't name one, it isn't live.

That last one isn't suspicion, it's arithmetic. Nothing reaches customers
without you running Job 2.

---

## Part 7 — Your standing habits

- **Once a day**, you get a review note from me in `docs/reviews/`. One page:
  what shipped, what I sent back, what needs your decision, what's quietly
  risky. Read the "Needs Amit" section; skim the rest.
- **You are the only one who deploys.** That's not a bottleneck to remove — it's
  the reason nothing surprises you.
- **When a developer is stuck, send them to me**, not into your day.

---

*Written by your CTO, 27 August 2026. If any step in here fails in a way this
file doesn't cover, that's a gap in the file — tell me and I'll fix it.*
