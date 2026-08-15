# Storage — one allowance per person

**Status: DECIDED AND SHIPPED IN CORE (2026-08-15).** Migration 31 is applied,
the meters and the admin UI already use this model. **Enforcement is not
converted yet** — that is the work this document asks of the Mail and Space
lanes.

---

## The model

**A person is given ONE figure.** Mail, files, and every product after them
draw it down. "You have 30 GB" is now true of something a customer can point
at; before this it was true of email only, and files were counted somewhere
else entirely.

**Data with no owner is not charged to a person.** Shared mailboxes
(`support@`) and organisational Space files belong to the ORGANISATION and
draw on the org pool (`core.storage_pools`), which already exists. Charging
them to whoever uploaded would move one person's remaining space when a
colleague files a document, and orphan the support queue's storage the day
that person leaves.

**Trashed files count** until they are purged. The bytes are still on disk.
The UI says so; do not "helpfully" exclude them, or deleting everything and
staying full becomes an unexplainable bug report.

---

## Where the numbers live

| thing | where |
|---|---|
| the person's allowance | `core.users.storage_quota_bytes` — NULL means inherit (department, then org) |
| what they are using, per product | `core.user_storage_usage(user_id)` → rows of `(product_code, used_bytes)` |
| allowance + total used, together | `core.user_storage(user_id)` → `(quota_bytes, used_bytes)` |
| org-owned bytes | `core.storage_pools` / `core.storage_allocations`, unchanged |

Both functions are `SECURITY DEFINER` with a pinned `search_path`: they read
`mail.mailboxes` and `space.files`, which are RLS-scoped to the caller, and
the policy service needs the true figure for somebody who is not the caller.
They return byte counts only — no names, no addresses.

`mail.mailboxes.quota_bytes` is still maintained, in step with the person's
allowance, because the mail edge reads mailboxes directly and knows nothing
about `core.users`. **It is a mirror, not the source.** Do not write to it as
if it were the truth.

---

## What each lane owes

### Mail — `PostfixPolicyWorker`

Today it compares a mailbox's `used_bytes` against that mailbox's
`quota_bytes`. It must instead ask `core.user_storage()` for the recipient's
OWNER and compare against the person's total.

- **Shared mailboxes have no owner.** For `type = 'shared'`, keep the existing
  mailbox-quota comparison — those bytes are the organisation's.
- **Amit's ruling on enforcement: refuse everything, including incoming mail.**
  Over-quota means a 4xx defer at SMTP; senders retry for about five days and
  then bounce. This is stricter than the previous "keep receiving" behaviour
  and it is deliberate.
- Keep the observe/enforce switch. Run in observe for a few days after the
  change and read the would-defer lines before flipping, exactly as last time
  — the definition of "full" is changing under people who were nowhere near
  their mail quota but have large Space files.

### Space — the upload gate

Today it checks the `drive` allocation out of the org pool. For a **personal**
upload it must check `core.user_storage()` for the uploading person; for an
**organisational** upload it keeps checking the org pool.

- The `413` + `reason` contract does not change. `full` now means "this
  person is full", so the sentence should say so — "You have used all 30 GB of
  your storage", not "your organisation is out of space", because the fix is
  different.
- The pre-check still happens BEFORE the bytes are read. Nothing about the
  streaming contract changes.

---

## What Core already did

- Migration 31: the column, both functions, and a one-time seed copying every
  existing mailbox quota up to the person. **That seed only ever widens** —
  nobody lost room on deploy day.
- `GET /api/account/storage` — the person's allowance, usage, and the
  per-product split. Any signed-in user may read their own.
- One rail meter, shared by every product, reading that endpoint. Mail's
  separate mailbox meter is deleted.
- Account → Storage: the breakdown.
- Admin: the Edit Person dialog now sets the person's allowance, and the
  people list reports account usage. A person with no mailbox still has an
  allowance, because they will have files.

---

## The trap worth naming

Two implementations of "is there room" WILL disagree, and the one that refuses
is the one the customer notices. That is why both lanes call the same SQL
function rather than each computing it. If you find yourself writing a `SUM`
over `size_bytes` or `used_bytes` in application code to answer "is this person
full", stop — that is the second implementation, and it is the bug.
