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
