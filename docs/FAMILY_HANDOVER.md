# TatvaOS Family — handover

From the Family backend, to whoever picks each piece up next.

Three parts: one for the **frontend** developer, one for **Mail**, one for
**Core**. The frontend note is much the longest because that is where most of
the remaining work is. The Mail and Core notes are short but both contain
something I need from you rather than something I am telling you about.

**Branch:** `feature/tatvaos-family-backend` — everything below is on it, and
nothing has been merged to `main`.

**Deployed:** production is running `9d04474`. Two commits, `a7827cd` and
`73c24b1`, are pushed but **not deployed** — the label-filter fix and bulk
label editing. They go out with the next `./infra/scripts/deploy.sh production`.

**The three documents that matter**, in the order you want them:

| File | What it is |
|---|---|
| `docs/FAMILY_API.md` | The API contract. The frontend's primary reference. |
| `docs/FAMILY_BACKLOG.md` | What is left, ordered by what breaks first if you skip it. |
| `docs/setup/family-backend.md` | Getting it running, and the environment traps. |

---

# Part 1 — For the frontend developer

## What exists

Family is the contacts product, live at `family.tatvaos.com`. It has a backend
that is complete for everything the screens below do, and screens for most but
not all of it.

| Path | Screen |
|---|---|
| `app/family/[view]/page.tsx` | Contacts, Directory, Frequent, Other contacts, Bin |
| `app/family/labels/page.tsx` | Manage labels — create, rename, recolour, delete |
| `app/family/import/page.tsx` | Import and export, CSV and vCard |
| `app/family/settings/page.tsx` | The three auto-save switches |
| `components/family/FamilyShell.tsx` | The chrome, and `useFamilyChrome()` |
| `components/family/ContactPicker.tsx` | Recipient picker, used by the Mail composer |
| `lib/family.ts` | The typed client. Mirrors `lib/mail.ts`. |
| `lib/nav.tsx` | The rail entry and `familyNav()` |

Every client call takes `authedFetch` from `lib/auth`, which attaches the
in-memory access token and silently refreshes once on a 401. Nothing in
`lib/family.ts` thinks about tokens, and nothing you write should either.

## Five things that will otherwise cost you a day

**Typecheck before every push.** `next dev --turbopack` does not typecheck.
"Compiled /family/contacts" is not a green light — it is only a bundle. Two
production deploys failed on type errors that dev had never once complained
about. From `apps/web`, in PowerShell:

```powershell
npx tsc --noEmit
```

It has to be PowerShell on your own machine; pnpm's symlinks do not resolve
over a mounted drive.

**`noUncheckedIndexedAccess` is on.** `parts[0]` is `string | undefined` even
directly after a length check, and the compiler is right to insist. Use
`.at(0) ?? ''` or an explicit guard. This broke a deploy once already.

**Read `components/ui/Kit.tsx` before you use Kit.** Do not infer its API from
call sites — I did, and it cost the second failed deploy. `Badge` takes
`tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'`; there is no `primary`.
`Button` takes `variant: 'primary' | 'secondary' | 'ghost' | 'danger'` and
renders a Next `Link` when given an `href`. `Table`'s `head` now takes
`React.ReactNode[]` rather than `string[]`, so a control can sit in the column
header it controls — that is how the select-all checkbox works.

**British spelling, everywhere.** `isFavourite`, `colour`, `organisational`,
`normalised`. It matches the API, which matches the rest of the codebase. An
Americanised field name does not error; it reads as `undefined` and you lose an
afternoon.

**Ownership drives every screen.** A contact is either `personal` — yours
alone, invisible to colleagues — or `organisational`, visible to everyone in
the tenant. Row-level security enforces it in the database as well as the API,
which is why a colleague's personal contact is a **404** here and not a 403:
telling somebody a row exists but is not theirs is itself a disclosure. Sharing
is one-way and the server refuses to reverse it, because demoting would have to
nominate a new owner and there is no right answer to that. The confirm dialog
says so before the fact rather than after.

## Patterns worth keeping

**Filters live in the URL, not in state.** This is not a style preference — it
was a bug. The label filter used to be a `useState` fed from `?groupId=` by an
effect that only ever *set* it. Click a label, then click Contacts, and the URL
was clean while the screen was still filtered by a label you had navigated away
from. It reads as "the filter is broken" because the screen no longer matches
anything you clicked. Deriving it from the URL removes the second copy and with
it the whole class of bug: back, forward, refresh, deep-link and the rail all
agree because there is only one thing to agree with.

**Say when a filter is on, where the person is looking.** Two labels covering
most of the same address book produce a first page that looks identical either
way, and a count at the bottom of fifty rows is not an answer. The contacts
screen now carries a "Showing only *Label* — 1,499 contacts" chip with a
one-click clear.

**Downloads cannot be an `<a href>`.** The export endpoint needs the
`Authorization` header, so the page fetches it, takes the blob and hands that
to the browser. `saveBlob` in `lib/family.ts` does it, including revoking the
object URL on the next tick — revoking it in the same frame races the download
in Safari and produces an empty file.

**Never loop the single-member group routes.** `PUT /groups/{g}/members/{c}`
is for one contact. For a selection, use `POST /contacts/labels`. 1,499 round
trips is not a feature, it is a hang.

**Import always dry-runs first.** `dryRun=true` returns an identical report and
writes nothing. The screen refuses to run a real import the person has not been
shown a report for, and that is the most useful thing it does — nobody notices
forty duplicates on the day, they notice them in three months when the original
file is gone.

## The bug I would fix first

`app/family/[view]/page.tsx` calls `useFamilyChrome()` and then renders
`<FamilyShell>`. The provider is inside the shell, so the hook reads the default
context and `chrome.refresh()` is a no-op — add a contact and the count in the
rail stays where it was until a full reload.

Three lines: move the page body into an inner component and render that as the
shell's child. `app/family/import/page.tsx` and `app/family/labels/page.tsx`
both already do it correctly; copy either. Worth doing before anything else
touches that file, because the mistake is easy to copy.

It is item **7b** in `FAMILY_BACKLOG.md`.

## What is not built

Merge is the big one — auto-save guarantees duplicates, because the same person
writes from `work@` and `personal@` and nothing can join them. There is no
server behind it yet, and `/family/merge` is a deliberately disabled nav entry
so the same feature does not get requested three times.

Also missing: a Dates section on the contact card (the SQL exists,
`20-family-dates.sql`, but there is no entity behind it, so imported birthdays
are counted and reported rather than stored — remember the year is nullable, so
render "14 March" with no computed age); add and remove for postal addresses,
which are read-only today; contact photos, which are cheap because
`core.user_avatars` already solved the same problem; bulk delete and bulk
restore; and the Directory view, which currently shows shared *contacts* when
it should show the organisation's people.

## Building and deploying

```powershell
cd apps\api  ;  dotnet build          # the API must compile
cd apps\web  ;  npx tsc --noEmit      # the web app must typecheck
```

Then commit, push, and on the **server** — the session whose prompt reads
`deploy@…:/srv/tatvaos-production$`, not PowerShell:

```bash
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh production
```

`deploy.sh` builds before it swaps anything, so a bad build aborts without
touching the running services. That is the safety net, not an excuse to skip
the two commands above — a failed deploy is still ten minutes and a Docker
build cache that grows every time.

---

# Part 2 — For the Mail developer

## What I changed in your code

Three files, and I would rather you knew than found out.

`apps/api/Modules/Mail/Endpoints/MailEndpoints.cs` — `SendAsync` now takes a
`ContactAutoSave` and calls it after the send commits.

`apps/api/Workers/MaildirIngestWorker.cs` — the same on the receive path,
draining a list of staged messages after the save.

`apps/web/components/mail/Composer.tsx` — the To input is wrapped in
`<ContactPicker>`, which suggests colleagues and saved contacts as you type. It
owns nothing and degrades silently: if Family is unreachable the input behaves
exactly as it did before.

## The contract between us

**`ContactAutoSave` swallows its own exceptions.** Mail must never fail because
Family did — a bounced message because an address book insert threw would be an
absurd trade. If you see auto-save errors in the log, they are mine. Please do
not wrap the call in a try/catch to quiet them; tell me instead, because a
silent one is a contact somebody is not getting.

**Ordering matters.** `family.contact_sources` has a foreign key to
`mail.messages`, so auto-save cannot run until the message row is committed.
The ingest worker already gets this right with the drained list. Keep it that
way if you refactor it.

## Two things I need from you

**An `is_bulk` column on `mail.messages`, set at ingest.** This is the highest
value thing Mail can do for Family, and it is not close.

Auto-save is on by default. Without filtering, every newsletter, receipt,
delivery notification and password reset becomes a contact, and within a month
a real address book is mostly robots. The way people react to that is to turn
auto-save off, which costs the feature entirely.

What I have today is `ContactMatching.IsNoReply()`, an address heuristic —
`noreply@`, `mailer-daemon@`, VERP bounce prefixes. It is deliberately
conservative, because a false positive silently loses a real person and nobody
ever finds out, while a false negative leaves one robot somebody deletes in two
seconds. So `support@`, `info@`, `sales@` and `accounts@` are **not** filtered:
they look impersonal and they are real correspondents.

What it cannot see is `List-Unsubscribe`, `Auto-Submitted: auto-generated` and
`Precedence: bulk`, which are the authoritative signals. They live in headers,
and auto-save runs after commit with only the `mail.messages` row, which does
not carry them. At ingest, MimeKit has already parsed them. One boolean column
set there catches every mailing list sending from an ordinary-looking address,
which the address heuristic never can.

**A decision about sender names.** `GET /api/family/contacts/lookup?email=…`
returns a name and company for an address, or a 404, which is a normal answer
rather than an error — so you can branch on "known" without inspecting a body.
It is built and nothing calls it. Putting a name on a sender in the message
view is what makes Family feel like part of the product rather than a second
address book nobody opens.

One caveat before you wire it: **that endpoint only searches
`family.contacts`**. A message from a colleague still comes back as a bare
address, because colleagues live in `core.users` and always will — a person
exists once, in Core. The recipient picker already handles this by reading both
and merging, colleagues first. If you want the same for senders, ask me and I
will add it to `lookup` once, rather than each caller learning the rule.

There is no `SenderName` component. It was discussed and never built.

---

# Part 3 — For the Core developer

## The one change I made outside Family, and it is in your file

`apps/api/Shared/Tenancy/TenantConnectionInterceptor.cs` now sets
**`app.user_id`** alongside `app.tenant_id` on every connection.

Family needs it because its row-level security is per user, not only per
tenant: a personal contact is visible to its owner and to nobody else, and the
policy reads `current_setting('app.user_id')` to decide. Core and Mail never
needed that, which is why the setting did not exist.

Two details worth carrying forward if you touch this file.

The command is **parameterised** — `set_config('app.tenant_id', @tenant, false)`
rather than a concatenated string. Building that SQL by concatenation with a
value that ultimately comes from a token is exactly the injection you do not
want at the isolation boundary.

A null user id is sent as an **empty string**, not as SQL `NULL`. So every
policy must read `nullif(current_setting('app.user_id', true), '')::uuid`. A
bare `::uuid` on an empty string raises, and I broke my own tests learning
that. The `true` argument makes an unset setting return null instead of
raising; the `nullif` handles the set-but-empty case. Both are needed.

`RESET app.tenant_id; RESET app.user_id` runs when the connection returns to
the pool, so a pooled connection cannot carry one request's identity into the
next.

Family's isolation tests are `tests/isolation/family/family-rls.sql` — eight
checks, wrapped in a transaction that always rolls back. Run them if you change
the interceptor.

## `core.products` has no `family` row

`00-core-schema.sql` seeds `mail`, `drive`, `people`, `payroll`, `sheet` and
`word`. Family is live in production and is not in that table, so product
access and entitlement cannot see it. It wants something like:

```sql
('family', 'TatvaOS Family', 'Contacts and people management', true, 15)
```

I have deliberately not added it — it is your table and the sort order is a
decision about how the product list reads, not a mechanical insert.

## The departure bug — I need a product decision

`family.contacts.owner_user_id` is `ON DELETE CASCADE`. Mail deliberately uses
`ON DELETE SET NULL`, with the comment "NULL after a user is deleted but their
mail is retained".

So today, hard-deleting a user destroys their entire personal address book
while their mail survives. The inconsistency is mine, not yours — but it is
Core that deletes users, so it is your delete that pulls the trigger.

It is not a one-line fix: the `CHECK` constraint requires a personal contact to
have an owner, so relaxing the foreign key alone leaves a row that violates it.
Three options, and it is a product decision rather than a technical one:

Reassign the departing person's contacts to their manager, which is defensible
and needs a manager to exist. Convert them to organisational — **no**, that
publishes somebody's private contacts on the day they leave, which is the worst
possible reading of a departure. Or retain them with a null owner and relax the
`CHECK`, so RLS hides them from everyone until an admin deliberately reassigns.

I would take the third. It matches Mail's retained-but-unreadable model, it
loses nothing, and it makes the recovery an explicit act by somebody with the
authority to make it.

## Family reads `core.users` directly

`AutocompleteAsync` merges colleagues from `core.users` with contacts from
`family.contacts`, colleagues listed first and winning on a duplicate address —
the colleague row is the authoritative record of that person, and a stale copy
in somebody's address book should not shadow it. It filters on
`Status == "active"`.

So: if the meaning of `users.status` changes, if `display_name` gains
semantics, or if users grow a soft delete, that picker is affected and I would
like to know. It is the only place Family reaches into Core's tables, and it is
deliberate — the address you type most often is the one sitting next to you,
and a recipient picker that cannot offer your own team is the wrong tool.

The same principle has one unfinished consequence on my side: `/family/directory`
currently lists shared *contacts* when it should list the organisation's people
from `core.users`. That is my fix, not yours. Flagging it so you know that view
is not authoritative yet.

---

## Appendix — environment traps

Three of these cost the best part of a day and are written up properly in the
troubleshooting section of `docs/setup/family-backend.md`. Read that before
debugging anything that looks impossible.

A native PostgreSQL holding port 5432 on the developer machine, which makes the
container's database invisible while everything appears to connect. A stale
Docker volume, which keeps an old schema alive through what looks like a clean
rebuild. And `docker compose up -d` not rebuilding images, so a fixed image is
never actually the one running — read the *start* of a container's log rather
than the tail to catch it.

Two more from this week. The database is `tatvaos_mail`, not `tatvaos`, for
historical reasons. And PowerShell has no `<` redirection, so piping a `.sql`
file into `psql` needs `Get-Content … | psql` instead.

On the production box, the Docker build cache grows on every deploy and
BuildKit never expires it — it reached 52 GB before anyone looked. Run
`docker builder prune -f` when `df -h /` passes 60%, or set a standing cap in
`/etc/docker/daemon.json` with `{"builder": {"gc": {"enabled": true,
"defaultKeepStorage": "10GB"}}}` and restart Docker in a quiet window. When
you read `df -h` there, ignore the dozen `overlay` lines — they are the same
root filesystem seen through each container. Only `/dev/sda` is real.
