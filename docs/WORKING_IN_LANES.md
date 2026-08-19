# Working in lanes — one machine, four working directories

**Adopted 19 August 2026,** after twelve cross-lane incidents culminating in an
hour of production downtime.

## The problem this solves

Four lanes were committing through **one checkout**. A git checkout has one
`HEAD` and one index, so "whose branch is this, and whose files are staged"
had one answer for four people. The results, all real:

- Space's audit work committed inside a Mail branch.
- Three lanes' changes in a single commit.
- A Core fix committed on `main`, pushed onto a Mail feature branch, and lost —
  while production was down waiting for it.
- A new developer's entire first day sitting uncommitted on someone else's
  branch.

None of that was carelessness. Careful people sharing one index will keep
producing it, because the tool has nowhere to put the second person.

## The layout

```
C:\Users\amitd\Downloads\
    tatvaOS\             ← INTEGRATION. Always on main. Nobody commits here.
    tatvaos-core\        ← Core       (lane/core)
    tatvaos-mail\        ← Mail       (lane/mail)
    tatvaos-space\       ← Space      (lane/space)
    tatvaos-connect\     ← Connect    (lane/connect)
```

Set it up once:

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
powershell -ExecutionPolicy Bypass -File infra\scripts\setup-lanes.ps1
cd ..\tatvaos-connect      # and so on, per lane
pnpm install
```

They are **siblings, not subfolders**, deliberately: Windows still enforces a
260-character path limit in enough places to matter, and `node_modules` inside
a nested worktree is how you find them.

Each folder is a real working directory backed by the same repository. Its own
`HEAD`, its own index, its own build output — but one shared object store, so
this costs almost no disk beyond `node_modules`, and pnpm hard-links those from
a single store.

## The rules

**1. `tatvaOS\` is for integration and reading. Never commit there.**
It is where merges land and where you check what production has. If you catch
yourself typing `git commit` in that folder, you are in the wrong window.

**2. Work only in your own lane folder.** A branch can only be checked out in
one worktree at a time — git enforces it. That is a feature, not an
inconvenience: two lanes on one branch is now impossible rather than merely
discouraged.

**3. Feature branches come off your lane branch**, and are named for the lane:
`feature/mail-away`, `feature/space-thumbnails`, `feature/connect-host-controls`.

**4. Never `git add -A`. Name your paths.**
This is the single rule that would have prevented the most damage. Before every
commit:

```
git status --short
git add apps/api/Modules/Connect  docs/CONNECT_HOST_CONTROLS.md
```

If you see a file you did not touch, it is someone else's — leave it. `push.cmd`
now refuses to run unless you have staged something yourself.

**5. Another lane's files are never edited in place.** Write a patch into
`infra/patches/` and hand it over. `Program.cs`, `Shared/Data/AppDbContext.cs`,
`next.config.ts` and the shell components are Core's. The Connect developer got
this right on day one — copy him.

### 5a. Where the frontend boundary actually is

**A boundary you cannot check with `git diff --name-only` is not a boundary.**

`docs/plans/LARGE_ATTACHMENTS.md` said "the Mail client UI is Core's" and, in
the same document, assigned the compose-time pre-check and the on-send body
block to Mail. Both are compose-UI work — a pre-check that must fire "at
attach time" can only live in the file picker's handler. Two developers read
one document, reached opposite conclusions, and one day of work was built
twice. Neither misread it. It said both.

The rule that failed was the prose one, and it failed because it describes an
intent with no test attached. Every rule on this platform that people actually
follow is a file list. So this one is too — **proposed by the Mail developer,
and adopted because he is right**:

| Path | Owner |
|---|---|
| `components/shell/*`, `components/ui/*`, `lib/theme.tsx`, `styles/*`, `app/layout.tsx` | **Core** — the design system and the frame |
| `components/mail/*`, `app/mail/*`, `lib/mail.ts` | **Mail** — product behaviour inside that frame |
| `components/space/*`, `app/space/*` | **Core** — Space's screens are Core-built |
| `lib/space.ts` | **Space** — see below |
| `app/connect/*`, `lib/connect.ts` | **Connect** |

**The condition that makes this safe:** inside your own files you use existing
tokens and existing primitives, and introduce no new visual language. If a
feature needs a component that is not already in `components/ui/*`, that is a
request to Core, not something a product lane invents. A lane owning its
screens is not a lane owning the design system.

**The API client belongs with the API, not with the screens.** `lib/mail.ts`
is Mail's; `lib/space.ts` is Space's, for the same reason. When a lane changes
its endpoint the client must change with it, and routing that through a
cross-lane request adds a round trip and buys nothing — the lane that moved
the route is the only one that knows it moved.

That row said Core for a day, and the day cost us this: Space opened
`GET /api/space/settings` to ordinary users and added a `settingsApi` wrapper;
Core had independently added a `spaceSettingsApi` wrapper to the same file for
the admin toggle. **The two branches merge CLEANLY** — git puts both in the
file, two exported clients for one endpoint, one of them on a trailing-slash
path, with no conflict marker to make anyone look.

A clean merge that produces a duplicate is more dangerous than a conflict.
A conflict stops a person; this only stops a person who happens to read the
file. Owning the client where the endpoint lives makes the duplicate
impossible rather than merely unlikely.

Check yourself before pushing:

```
git diff --name-only main...HEAD
```

If a path outside your rows appears, it goes over as a patch instead.

**And before any merge into main, run:**

```powershell
powershell -ExecutionPolicy Bypass -File infra\scripts\lane-overlap.ps1
```

It lists every file that two *different* lanes are both editing across the
unmerged branches. Same-lane overlap is ordinary work and is not reported.

It tells you **where to look, never what is wrong** — it cannot read the file
and cannot tell a duplicate from two unrelated edits. A name on that list
means one thing: open it after merging and read it, looking for two things
doing one job. Two wrappers for an endpoint, two helpers under different
names, the same constant twice.

It exits 0 even when it finds something, on purpose. Making it fail a merge
would train people to skip it, and most overlaps are entirely fine.

**6. Only ONE lane runs the local Docker stack at a time.** Compose derives its
project name from the directory, so each folder would get its own containers,
volumes and database — but they would all want ports 5432, 3000 and 25 on the
same machine, and the second one fails. Agree who has the stack, or run
`docker compose down` when you are finished with it.

## Pushing

`push.cmd`, run **from your own lane folder**. It:

- refuses if you are on `main`;
- refuses if you have staged nothing;
- shows you exactly what is staged and what it is leaving alone, and asks;
- builds web and API before committing;
- pushes **the branch you are on**, not `main`.

The previous version did the opposite of all five. It `cd`'d to a hardcoded
path, ran `git add -A`, and finished with `git push origin main` regardless of
the branch you had just committed to — which is why work committed on a feature
branch went nowhere while appearing to succeed.

## Merging to main

Only in `tatvaOS\`, only after review:

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git checkout main
git pull
git merge --no-ff feature/whatever
git push origin main
```

Then deploy from the box. `deploy.sh` reads `--env-file infra/docker/.env`, not
the repo-root `.env`.

## If something still goes wrong

**Check where you are before believing anything.** Most of the false alarms in
this project's history came from grepping a tree that was on a different branch
than assumed:

```
git rev-parse --abbrev-ref HEAD
git worktree list
git status --short
```

**A branch is never lost, only misplaced.** If a commit is not where you expect,
it is on another branch, not gone:

```
git log --oneline --all --graph -20
git branch -a --contains <sha>
```

That last command is what found this morning's missing fix.
