# TatvaOS Family — what is left, in the order I would build it

Written at the end of the session that built Family. Sequenced by what breaks
first if you skip it, not by size.

Ground truth for what exists: `docs/setup/family-backend.md` and
`docs/FAMILY_API.md` on `feature/tatvaos-family-backend`.

---

## 0. Before any new feature — typecheck the frontend

Nothing in `apps/web` has been typechecked. `next dev --turbopack` does not do
it, which is why "Compiled /family/contacts" was not the green light it looked
like.

```powershell
cd apps\web
npx tsc --noEmit
```

Highest-risk files, in order: `app/family/[view]/page.tsx` (moved and rewired
mid-session), `components/family/FamilyShell.tsx` (new), and the three shared
shell files that gained a `'family'` scope.

**Do this first.** Everything below assumes it is clean.

---

## 1. No-reply filtering — SHIPPED IN THIS BUNDLE, needs applying

Auto-save is on by default and nothing filtered robots. See
`ContactAutoSave.patch.md`. Thirty lines. Apply it before anyone uses Family
in anger, or the first week's address book is mostly newsletters.

Follow-up, worth doing properly: an `is_bulk` column on `mail.messages` set at
ingest from `List-Unsubscribe` / `Auto-Submitted` / `Precedence: bulk`. That
catches mailing lists sending from ordinary-looking addresses, which the
address heuristic cannot.

---

## 2. The departure bug

`family.contacts.owner_user_id` is `ON DELETE CASCADE`. Mail deliberately uses
`SET NULL`, with the comment "NULL after a user is deleted but their mail is
retained". So today a hard-deleted user takes their entire personal address
book with them, while their mail survives. My inconsistency, not yours.

Not a one-line fix: the `CHECK` requires a personal contact to have an owner.
Three options, and it is a product decision:

- reassign to the departing person's manager
- convert to organisational — **no**, that publishes private contacts
- retain with a null owner, relax the `CHECK`, so RLS hides it from everyone
  until an admin deliberately reassigns

I would take the third. It matches Mail's retained-but-unreadable model.

---

## 3. Merge

Auto-save guarantees duplicates: the same person writes from `work@` and
`personal@` and nothing can join them. The audit log already reserves a
`merge` operation.

Shape: `POST /contacts/{keepId}/merge/{mergeId}`. Move emails, phones,
addresses, interactions, sources and group memberships to the survivor;
soft-delete the other; write one audit row on each carrying the other's id.
Must be one transaction — a half-merge is worse than two duplicates.

Then a finder: group live contacts by `email_normalised` collision and by
identical `display_name`, and offer them side by side.

---

## 4. Wire Mail ↔ Contacts

`ContactPicker` and `SenderName` are written and delivered; neither is wired.
`INTEGRATE.md` has the exact wrapper. One paste in `Composer.tsx`, one in
`MessageView.tsx`.

Also needed: `/family/contacts?open=<id>` is linked by `SenderName` and the
contacts page does not read it yet. Three lines beside the existing `?create=1`
handling.

This is what makes Family a feature rather than a second address book nobody
opens. It is only below merge because merge gets harder the longer you wait.

---

## 5. Addresses are read-only

The table, entity and detail response exist. There is no endpoint to add or
remove one. Mirror `AddEmail` / `RemoveEmail` — perhaps forty lines including
the DTO.

Same shape: `POST /contacts/{id}/addresses`, `DELETE .../addresses/{addressId}`.

---

## 6. Dates UI

Backend is built and the SQL is verified: `20-family-dates.sql`, plus the
entity, endpoints and client patches. No UI. Add a Dates section to the detail
dialog beside Emails and Phones, and an "Upcoming" view reading
`family.upcoming_dates(30)`.

Remember the year is nullable — render "14 March" when there is no year, and
never show a computed age for those.

---

## 7. Import and export — BUILT

Shipped as `Csv.cs`, `VCard.cs`, `ContactRecord.cs`, `ContactCsvFormat.cs`,
`ContactImport.cs` and `Endpoints/ImportExportEndpoints.cs`, with
`app/family/import/page.tsx` in front of it. Documented in `FAMILY_API.md`.

CSV and vCard both directions. The importer reads Google's two column
generations, Outlook's and Apple's; the exporter writes a Google-compatible
CSV and vCard 3.0. Duplicate detection reuses `ContactMatching.NormaliseEmail`,
so an import cannot let in an address that auto-save would have folded. Every
row that does not become a contact is reported with a reason, and `dryRun=true`
gives that report without writing anything — the UI refuses to import a file
the person has not seen a report for.

Verify with `tests/isolation/family/smoke-family-import.ps1`. Its round-trip
step — import, export, re-import as a dry run, insist nothing is new — is the
one that catches a disagreement between the reader and the writer.

Still open, and small:

- **Birthdays are parsed and discarded.** The report warns and tells the person
  to keep the original file. Fixed by item 6, not by anything in the importer.
- **Rows with no email cannot be de-duplicated.** Nothing to match on. Importing
  the same nameless-but-addressless file twice makes two of everything.
- **`keys.Contains(e.EmailNormalised)` against a citext column.** EF turns this
  into `= ANY(@keys)` and the operator resolution goes through citext's
  implicit cast from text. It should be fine and it is the first thing to check
  if the first real import throws — the smoke test's dry-run step exercises it
  before any data is written.
- **Export is not audited.** `contact_audit_logs` needs a contact id per row, so
  there is nowhere to record a bulk export. Wants its own small table if that
  matters.

---

## 7b. The sidebar count does not refresh

`app/family/[view]/page.tsx` calls `useFamilyChrome()` and then renders
`<FamilyShell>`. The provider is inside the shell, so the hook reads the
default context and `chrome.refresh()` is a no-op — add a contact and the count
in the rail stays where it was until a full reload.

Three lines: move the page body into an inner component and render that as the
shell's child, the way `app/family/import/page.tsx` does. Worth doing before
anything else touches that file, because the same mistake will be copied.

---

## 8. Bulk select

Pairs with Other contacts. If mail has saved 200 people and nine are worth
keeping, pruning one dialog at a time is why people abandon address books.
Checkbox column, then label or delete the selection.

---

## 9. Contact photos

Cheap, because it is solved once already: `core.user_avatars` is its own table
precisely so lists do not carry image bytes, and `UserPhoto` / `PhotoPicker`
exist. Same pattern, new table.

---

## 10. Everything after that

Roughly in value order, none of it started:

- **Contact → send email** — a compose link from the contact card
- **Blocking** — Family-level, distinct from Mail's per-mailbox `blocked_senders`
- **Custom fields** — jsonb on the contact, or a key/value child table
- **Multiple organisations** — today `companyName` is one string
- **Finer permissions** — share with a colleague or a department, not just
  personal-or-everyone
- **Advanced labels** — nesting, and rules that apply them automatically
- **Calendar** — read `family.upcoming_dates()`; do NOT copy birthdays into
  events, or one of the two copies goes stale
- **Suggestions, intelligence, CRM, AI summarisation** — all of these want a
  clean, deduplicated, well-populated address book underneath them, which is
  the argument for doing 1 through 8 first

---

## Standing caution

Three environment traps cost most of one day and are now written up in the
troubleshooting section of `docs/setup/family-backend.md`: a native PostgreSQL
holding port 5432, a stale Docker volume, and `docker compose up -d` not
rebuilding images. Read that section before debugging anything that looks
impossible.
