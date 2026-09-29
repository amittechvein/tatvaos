# 0012 — Deleting an organisation

**Status:** design accepted by Mr. Singh, 29 September 2026, with the answers below.
Built as a draft; **not merged, not deployed. Nothing has been deleted on production.**
**Date:** 2026-09-29
**Asked by** Amit, 29 September: three organisations made for testing (Scottish public
school katihar, Trineetra Org, Trineetra by Techvein) should be deleted, "and inside
created mails". He chose a Delete button in the console over a one-off removal, and
confirmed the school is his own test.

## Context

An organisation could be suspended and never removed. `SuspendAsync` says removal is
"a separate, deliberate action after the grace period — see the billing policy"; that
action and that policy did not exist. `core.tenants.status` has a `deleted` value that
nothing writes.

The developer session does not delete customer data by hand, on production or anywhere
a person's data is. So the capability had to be something a person presses.

## What was measured first (local database, 29 September)

| Finding | Consequence |
|---|---|
| 83 foreign keys to `core.tenants` cascade | One `DELETE` removes most of it |
| `core.invoices`, `core.invoice_lines` are `RESTRICT` | An invoiced organisation cannot be deleted; this is right, invoices are tax records |
| `hire.job_openings` is `RESTRICT` against locations and designations | Could fail depending on cascade order. With the explicit delete removed the test still passed, so today the order is kind. Kept anyway |
| 8 columns hold an organisation's id with no foreign key (Connect share and access-log tables, `core.razorpay_events`); first written here as 7 | A cascade never reaches them. Seven are deleted by name; one, another organisation's access-log line about one of these people, is kept |
| `core.signup_drafts` is `SET NULL` | The deleted organisation's sign-up, with a name, email and phone on it, would stay |
| The app's role has `DELETE` on `core.tenants` today | Any endpoint bug that reaches a tenant `DELETE` already removes an organisation. Not changed here; see Open questions |
| The API mounts the maildir read-only | It cannot remove mail files, by design |
| Mail lives at `vhosts/{domain}/{local part}` | Re-register the domain, create the same address, and the new mailbox opens onto the old mail |

## What is proposed (and built, in the draft)

1. **Two steps and a typed name.** Suspend first; then Delete, typing the organisation's
   name. Only a platform operator has the route.
2. **Refused when** the organisation is not suspended; was ever invoiced; has a platform
   operator among its people; is the operator's own; is the personal house.
3. **The rules are in the database.** `core.delete_organisation` checks all of the above
   itself, including that the caller is an active operator, removes everything in one
   transaction, and writes the record. The API asks first so the person gets a sentence,
   but a route that forgot to ask still could not delete.
4. **The check afterwards.** After the delete, every column in every schema whose name
   contains `tenant` is searched for the id. Anything found raises and rolls back the
   whole deletion. A table added later by another lane, with no foreign key, stops the
   button rather than being silently left behind.
5. **What is kept:** one row in `core.organisation_deletions` (name, domains, counts per
   table, who, when, why) and one line in the operator's organisation's audit log. No
   person's address and no mail.
6. **What goes with it on purpose:** the organisation's own audit log. It is the
   organisation's data.
7. **Files.** After the commit the API removes the Space folder, the recordings and the
   DKIM keys, and writes down what it removed. "Remove files" on the record repeats it
   safely if that step failed.
8. **Mail files are not removed.** The domains whose folder exists are recorded as
   pending, and a trigger on `core.domains` refuses to register such a domain again
   until the record is marked removed. If the mail store cannot be looked at, every
   domain is treated as pending.

## What this does not do

- **It does not remove mail files from the server.** Somebody has to, by a route that is
  not this API. Options, none built:
  (a) a script run on the server that reads the pending list, refuses any domain that
  is registered again, removes the folder through the Dovecot container and marks the
  record; (b) the same as a step of every deploy; (c) leave them, since they are
  unreachable and the domain is held back. (a) and (b) change `deploy.sh` or add a
  server script, so they are Mr. Singh's.
- **It does not reach backups.** The organisation stays in encrypted backups until they
  expire. The screen says so.
- **It does not touch `ai.mail.organisations`** or the `.env` list of recording-sharing
  test organisations. An id left in a list is harmless. An id removed from
  `ai.mail.organisations` could empty it, and empty means every organisation.
- **It does not remove another organisation's access-log line** that names one of the
  deleted people. That line is the other organisation's record.
- **No waiting period.** Suspended a minute ago is enough.

## Open questions

**For Mr. Singh**

1. Should there be a minimum time suspended before Delete opens (a day, a week)? It
   would have stopped nothing on 29 September, and would stop a press made in anger.
2. Should one operator be enough, or should a second have to confirm?
3. Mail files: (a), (b) or (c) above.
4. Should `DELETE` on `core.tenants` be revoked from the app's role now that a function
   does it? It is the right end state and it is not additive, so it is not in this
   change.
5. Is it right that the organisation's own audit log goes? The alternative is to keep
   it under the deletion record, which keeps people's ids and addresses after the
   organisation asked, in effect, to be forgotten.
6. The record holds the operator's email address. Acceptable?

**For Amit**

1. Does a customer who leaves get deleted on request, and how long after? What are they
   told? Today nothing is promised anywhere.
2. The three test organisations: once this is live, you suspend each and press Delete.
   If any of them was ever invoiced, or has mail on the server, the screen will say.

## What would prove this wrong

- A table that holds an organisation's data **without** a column named like `tenant`:
  the check afterwards cannot see it. Tables reached only through a parent (a message's
  recipients, a meeting's participants) go by their own cascade; a table with neither a
  tenant column nor a foreign key chain would be left. None was found; the search was
  by column name and foreign key, not by reading every table.
- Production differing from the local database in which constraints exist. The
  function's check afterwards is the guard: it would refuse, not half-delete.
- The schema built from nothing (`verify-migrations.sh`) was **not** run: it needs
  Docker, which is not started on this laptop, and CI is down. The file was applied
  twice to an already-built database.

## Mr. Singh's answers (via Amit), 29 September 2026

| # | Question | Ruling | Where |
|---|---|---|---|
| 1 | Minimum time suspended | **24 hours.** A setting, so it can be raised | `organisations.delete_after_suspended_hours`; a value below 24 or not a number reads as 24 (TVD10) |
| 2 | A second operator | **No, not now.** Revisit with more than two operators | — |
| 3 | Mail files | **(a), built as part of 321's job**, never a deploy step. Guards first: domain non-empty and valid, not registered again, the path exactly `vhosts/<domain>` and a child of `vhosts`, never `vhosts` itself. Dry run printing the exact path. Each run on Amit's go, first on one of his test organisations | PR 321's `maildir-removals.sh` |
| 4 | Revoke `DELETE` on `core.tenants` | **Yes, in this PR**, given the function is `SECURITY DEFINER` | Revoked in the migration; red first proven |
| 5 | The organisation's own audit log goes with it | **Yes** | As built |
| 6 | Operator's email on the record | **Acceptable** (staff accountability) | As built |

He also asked for confirmation that `core.signup_drafts` is deleted for the organisation (it
is, by `converted_tenant_id`), and that the columns with no foreign key are deleted
explicitly. The measurement found **eight** such columns, not the seven first written
here. Seven are deleted by name, including `core.razorpay_events.tenant_id`, which was
first left and is now deleted. The eighth, `connect.recording_access_log.subject_tenant_id`,
is a line in *another* organisation's log saying one of these people opened that
organisation's recording. It is kept, as that organisation's record, and is the one
exception the check afterwards allows.
