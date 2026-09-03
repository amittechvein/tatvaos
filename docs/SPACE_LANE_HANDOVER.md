# Space — lane handover

**Written 3 September 2026, on Amit's instruction, as the Space lane transfers
to Core.** It covers everything from the first line of Space to the state of
`main` this morning: what exists, why it is shaped that way, what is proven and
what is merely written, and what I got wrong so you do not inherit the
reasoning along with the code.

Read section 9 first if you are in a hurry. It is the part that decays.

---

## 1. What Space is

File storage for TatvaOS, with a second job: it is where Mail parks anything
too large to send as an attachment, which then travels as a public link to
someone who may have no account at all. That second job is why Space has a
capability-token system, an anonymous download path, and more paranoia per line
than a file store would otherwise need.

Storage is **bought once per organisation** and shared across products —
`core.storage_pools`, Core's table. Space does not sell storage; it consumes an
allocation and reports what it used. The allocation key is `'drive'`, reused
deliberately rather than minted fresh, on Core's ruling at the start.

---

## 2. Where everything is

### Backend — `apps/api/Modules/Space/`

| File | What it is |
|---|---|
| `Endpoints/SpaceEndpoints.cs` | The main surface: files, folders, upload, trash, ownership, sharing. ~1500 lines. Also holds `EvaluateStorageAsync`, the single quota implementation. |
| `Endpoints/SpaceDriveEndpoints.cs` | The Drive-shaped views: Recent, Starred, Shared with me, the people directory. |
| `Endpoints/SpaceLinkEndpoints.cs` | Public links — management (authenticated) and the anonymous pair. |
| `Endpoints/SpaceThumbnailEndpoints.cs` | Thumbnails. SkiaSharp, not ImageSharp — licensing. |
| `SpaceContentGateway.cs` | The seam other products call: `DescribeAsync`, `OpenReadAsync`, `SaveAsync`, `EnsureFolderAsync`. Mail's only door into Space. |
| `BlobStore.cs` | Bytes on disk. `.part`-then-move, so a killed upload never leaves a half file that looks whole. |
| `../../Workers/SpaceBlobSweepWorker.cs` | Sweeps orphaned blobs and `.part` debris. |
| `../../Shared/Data/SpaceEntities.cs` | Entities. Core's folder — additive only. |

### Frontend

`apps/web/lib/space.ts` is **Space's** — the API client belongs with the API,
ratified in `WORKING_IN_LANES.md` §5a after a clean merge produced two clients
for one endpoint. `app/space/*` and `components/space/*` are **Core's**.

### Schema — `local/postgres/init/`

| File | What it adds |
|---|---|
| `0025-space-schema.sql` | `space.folders`, `space.files`, `space.shares`, `can_access_folder()`, and extends `core.reconcile_storage_usage`. |
| `0026-space-purge.sql` | `purgeable_files()` / `purge_trash()`. |
| `0029-space-drive.sql` | `space.file_activity`, `space.stars`. |
| `20260816-space-public-links.sql` | `space.tenant_settings`, `space.public_links`, `peek_public_link`, `consume_public_link`. |
| `20260819-space-link-loss-logging.sql` | Re-creates `consume_public_link` with a wider return. **This is the live definition.** |
| `20260819-space-link-refund.sql` | `refund_public_link`. |
| `20260823-space-blob-audit.sql` | Blob audit. |

### Scripts — `infra/scripts/`

- `verify-space-link-predicate.sh` — the two public-link predicates must agree.
  **Called from `verify-migrations.sh`**, so it runs on every deploy check.
- `verify-space-share-privacy.sh` — drives the real API with two sign-ins and
  proves a non-owner cannot see who else a file is shared with.
- `verify-link-race.sh`, `verify-loss-refund.sh` — older, still valid.

### Documents

`SPACE_API.md` is the reference and supersedes both addenda, which are kept
only for the reasoning and are marked superseded at the top.
`SPACE_FAULT_MATRIX.md` is the honest list of what has and has not been tested.
`SPACE_BACKEND_BRIEF.md` is the original contract. `docs/plans/SPACE_VIRUS_SCAN.md`
is the one unstarted piece of work, on a branch.

---

## 3. The data model, and the decisions inside it

**Owner references are `ON DELETE SET NULL`, never CASCADE.** Family's address
book was destroyed once by a CASCADE on a departing user. A file whose owner
has left becomes owner-less and is retained; an org admin can reclaim it.

**No `path` column.** A folder's location is its parent chain, walked by
`space.can_access_folder()`, depth-capped at 32. A path column is a
denormalised copy that drifts the first time somebody renames a folder.

**Trash is a stamp (`deleted_at`), not a table.** Trashing a folder stamps that
row only; its contents follow their ancestor, so restore is a single un-stamp.

**Shares are never copied down.** A folder share reaches contents at query time
by walking ancestors, so "why can this person see this?" always has a one-row
answer.

**`blob_key` is opaque:** `{tenant_id}/{yyyy}/{mm}/{uuid4}`. Not derived from
the filename, so renaming a file does not move bytes and a filename can never
influence a path.

**Row-level security everywhere**, driven by `app.tenant_id` / `app.user_id`,
read as `nullif(current_setting('app.x', true), '')::uuid`. The `true` handles
unset; the `nullif` handles set-but-empty. A bare `::uuid` on `''` raises, and
that is a live outage rather than a denied row.

---

## 4. The public-link path — the part to be most careful with

This is the only code in Space a stranger can reach.

- A link is a **capability**, treated as a credential: 128 bits, stored only as
  a SHA-256 hash. The plaintext exists once, in the response that created it.
- The resolve path **has no session**, so RLS cannot protect it. The only
  database access there is two `SECURITY DEFINER` functions with pinned
  `search_path`.
- **The atomic UPDATE is the check.** `consume_public_link` increments the
  count in the same statement that validates every condition, so `max_downloads`
  cannot be raced past. Proven by `verify-link-race.sh`.
- **One 404 string for every failure.** Revoked, expired, capped, trashed,
  tenant suspended, tap closed — all identical. No oracle.
- `attachment` + `nosniff`, always. No range processing.
- If the blob is missing when the bytes are wanted, the download is **refunded**
  — the recipient must not pay a download for our fault.

**The predicate appears twice by necessity** (one reads, one writes) and the
two definitions now live in *different files*. `verify-space-link-predicate.sh`
enforces their agreement and knows the live definition is the last one to run,
not the one sitting next to its twin.

---

## 5. The seams with other products

**Mail → Space** goes through `SpaceContentGateway` and nothing else. Mail
never touches Space's tables. Two flows: "save this attachment to Space"
(bytes never leave the server) and "this attachment is too large, park it in
Space and send a link".

**Space → Core**: storage allocation, tenants, users, audit. Space reads;
Core owns.

**The mail edge gets nothing.** No grant on any `space.*` object.

---

## 6. Habits this lane kept, which are worth keeping

- **A contract before an implementation.** Every feature here got a written
  brief that Core reviewed before code existed. Rework has been near zero, and
  the arguments happened on paper where they are cheap.
- **Batched DTO decoration, never per-row walks.** Every list endpoint gathers
  ids, does one query per concern, and folds. The recursive-walk version is the
  one that dies at a thousand files.
- **Tracked shared files ship as `git apply` patches, never whole-file writes.**
  A whole-file write of `Program.cs` once got swept into a production commit
  and broke live MFA.
- **Every check must be able to fail, and be shown failing.** The scripts here
  run a positive control before reporting anything.

---

## 7. Timeline — what happened, and what it cost

**16 Aug** — schema, quota, sharing, trash. Public links designed and built
(v1.3 contract, approved with one amendment: a `space.tenant_settings` table
rather than a flag on `core.tenants`, because the identity table is not a junk
drawer for every product's flags).

**19 Aug** — the busy day. Thumbnails, audit, link refund (review finding F1),
the landing-page fixes, storage-loss logging, settings split so ordinary users
can read policy. Mail's large-attachment flow went live on top. The lane system
started the same day, after twelve cross-lane incidents.

**20 Aug — the worst self-inflicted day.** My `20260819` migration dropped and
re-created `consume_public_link` with a wider return type. `20260816`'s
`CREATE OR REPLACE` then failed with *"cannot change return type"* on the
**second** deploy. Every deploy was blocked for a day. I had written *"these
migrations re-run on every deploy"* in that file's own header and failed to
follow it one file backwards. Core fixed it with a conditional create, and that
incident is why `verify-migrations.sh` exists.

**23–24 Aug** — API reference consolidated; Core's test results folded into the
fault matrix. Three faults closed with evidence, five left box-only.

**29 Aug** — house-rules consolidation. Rule 11 (every lane merges and deploys
its own work) had lived only in chat for two days while four committed
documents asserted the superseded policy. Absence makes a person ask; a stale
copy makes them confident.

**30 Aug** — Amit's ruling that a share list is personal data.

**31 Aug** — share-list privacy shipped and deployed, then verified against
production with real accounts. The scanning brief written. Lane parked.

**2–3 Sep** — Core landed the UI half (see section 9).

---

## 8. What is proven, and what is only written

**Proven by execution, on production or against it:**

- the share list is closed by default — 12 checks, real accounts, `verify-space-share-privacy.sh`;
- the download-count race holds — `verify-link-race.sh`;
- orphaned blobs are findable and `.part` debris is swept;
- the two link predicates agree — runs on every deploy check;
- the whole 40 MB path end to end: real file → Gmail → opened with no session;
- migrations build from nothing and re-run cleanly — 58 files, both passes.

**Written and believed but never executed** — the five box-only entries in
`SPACE_FAULT_MATRIX.md`: the volume filling mid-upload, concurrent overwrite,
the purge worker killed mid-subtree, a real decompression bomb, and tenant
isolation exercised rather than reasoned. **Amit closed this permanently on
31 Aug: there will be no staging box.** They are not "pending"; they are
accepted, and the matrix should say so rather than imply a queue.

---

## 9. Open items, handed over

### 9.1 `fix/space-share-panel-honesty` — **delete it, do not merge**

I wrote a UI fix on 31 Aug and pushed it unmerged. Core wrote the same fix
independently and merged it on 2 Sep (`d1b5b64`). **Main already has the
behaviour.** Merging my branch now would conflict or duplicate.

Core's version is better than mine in one specific way and it is worth
recording: he defaults `canSeeEveryone` to **false**, I defaulted it to
**true**. My reasoning was that a loading panel should not claim to be partial.
His is that a privacy control whose default over-discloses is one refactor away
from doing so. He is right — the cautious default costs a flicker; mine costs a
disclosure the day someone moves the fetch.

*(Note: `2793fbd` on 3 Sep re-applies the identical content directly on `main`,
unreviewed. It produces no textual difference from `d1b5b64`. Worth a glance to
confirm it was intentional.)*

### 9.2 `docs/space-virus-scan-brief` — **decision needed, no code written**

The brief is `docs/plans/SPACE_VIRUS_SCAN.md`. Two findings shape it:

1. **No scanner is deployed and nothing on this platform has ever been
   scanned.** `ClamAvScanner` and `AttachmentScanWorker` are written, correct,
   and idle — `Mail__ClamAv` is empty and no `clamav` service exists in any
   compose file.
2. **Space's cap is 2 GB; clamd's default `StreamMaxLength` is 25 MB.** So the
   large files — the ones that become public links to strangers, which is the
   whole point of the large-attachment feature — are exactly the ones a default
   scanner cannot inspect.

Three decisions are named in the brief and none of them are the implementer's:
whether we run a scanner at all (cost, ~1–2 GB RAM); whether `ClamAvScanner`
moves from `Modules/Mail/` to `Shared/`; and what a `pending` file does at each
of Space's five exits. **Without the first, there is nothing worth building.**

### 9.3 Partial share lists — settled, and where

Ruled by Amit on 30 Aug and now implemented: the uploader and org admins see
everyone; anyone else sees their own access and any organisation-wide grant.
No count, ever — how many others hold a file is a fact about them. Written up
in `SPACE_API.md`. **Space has no group audience beyond org-wide**, so the
"group name, never membership" half of the ruling has nothing to bind to yet;
when folder- or department-level sharing arrives it inherits the rule rather
than re-deciding it.

### 9.4 Range requests on public downloads (F2)

Deferred by ruling, not blocked. Reopen it the first time somebody complains
that a large download cannot resume.

### 9.5 The org-admin role set

`u.Role == "org_owner" || "org_admin" || "super_admin"` is written out
independently in several modules. Space has exactly one copy, in
`IsOrgAdminAsync`. Consolidating across Core, Mail and Admin is a conversation,
not a quiet edit — flagged, never done.

### 9.6 Phase-2 pool, none started

Password-protected links (the `password_hash` column already exists, reserved
in August — no migration needed), folder links, file versions, presigned
uploads, virus scanning, resumable uploads, and Mail saving into a shared
folder. Each needs a brief before code.

---

## 10. Mistakes I made, so the reasoning does not get inherited

Stated plainly, because a handover that only lists achievements teaches nothing.

**The migration that blocked every deploy for a day.** Covered above. The
lesson generalised: an earlier migration must not fight a later one's evolution
of the same object, and the only way to know is to run the whole directory
twice.

**A whole-file write swept into a production commit**, breaking live MFA. Hence
the patch discipline.

**A test recipe whose failure was indistinguishable from its success.** I
proposed checking a deleted-blob refund by asserting "the count is unchanged" —
which is equally true if the link was never consumed. Core caught it. The fix
was a positive control: one successful download first.

**A verification script that reported success after announcing failure.**
`login()` ended in `exit 1` and was called in a command substitution, so it
killed only the subshell; the script carried on with an empty token and printed
"signed in". Found because Amit ran it and pasted the output, not because I
reviewed it. I had tested what the check *concludes* and never the path where
its own setup fails.

**A gate keyed on a signal that could not answer the question.** I told Amit to
build again "if `git pull` brought anything down". In a shared-worktree repo
another lane's fetch advances `main` for everyone, so the pull is silent even
when `main` moved. The CTO's replacement is right and simpler: **build after
merging, always, no condition.**

**And the first version of the predicate check compared the wrong pair** — the
two definitions sitting together in one file, both superseded seconds later by
a third. It would have passed forever while the live pair drifted. It surfaced
only because it failed for an unrelated reason.

The pattern in all of them is one thing: **the care went into the reasoning,
and the mechanism was never run.**

---

## 11. Traps

- **`main` moves under you.** Rebase before you build, and build again after
  merging. Always.
- **A deploy ships all of `main`, not your branch.** Check what is riding along
  before you type `production`, and record the rollback SHA first.
- **Never bare `--force`.** `--force-with-lease`, always.
- **`.env` is on the server and Amit manages it.** `deploy.sh` reads
  `--env-file infra/docker/.env`, not the repo root's.
- **Only one lane runs the local Docker stack at a time.**
- **The `20260911-*` and `20260912-*` migrations still wear future dates.**
  Core's own review flagged them. Not Space's, but they sort after everything
  and somebody should reconcile them.

---

## 12. If you read nothing else

Space is complete, live, and its riskiest path — a stranger downloading a file
with no account — is the most heavily verified thing in it. The backlog is
empty. The only unstarted work is virus scanning, and that begins with a
decision about money and memory rather than a decision about code.

The habit that produced that, and the one worth keeping: **write the contract
first, and run the check before you believe it.**
