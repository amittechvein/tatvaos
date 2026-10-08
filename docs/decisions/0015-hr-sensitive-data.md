# 0015 — Aadhaar, PAN and bank details: how People holds them

**Status:** proposed. For Mr. Singh's review, as his Hire & People handover asks
(§3, §6 step 4): *"Write the sensitive-data design document before any code
touches Aadhaar, PAN or bank details."* Nothing here is built.
**Date:** 2026-10-08
**Lane:** Hire & People
**Needs:** Mr. Singh (design, access, keys) · Amit (what is collected at all, §2;
who may see it, §5) · a lawyer (§9, through Mr. Singh)

---

## Context

People's pre-joining step (roadmap Phase 5) collects government identifiers and
bank details: Aadhaar, PAN, bank account and IFSC, and in time UAN, ESI number
and passport. Nothing in TatvaOS holds data like this today. The welcome (§3.2)
and the roadmap (§6.3) set four requirements, and this document turns them into
a design:

1. **Encrypted at rest separately from the rest of the row.**
2. **Every read audited**, not only writes.
3. **The keep-everything retention ruling does not carry over.** HR data has to
   be deleted.
4. **Designed before Phase 5, not during it.**

What already exists and shapes the design:

- **Two AES-GCM helpers** — `Shared/Settings/SettingsCrypto.cs` (platform
  secrets) and `Shared/Auth/TotpService.cs` (MFA secrets). Both derive their key
  from `Settings:EncryptionKey` / `Mfa:EncryptionKey`, **falling back to the JWT
  signing key**. One key protects sign-in, MFA, SMS, billing and SSO secrets, so
  rotating it makes all of them unreadable at once (`SettingsCrypto` says so in
  its header). **That fallback must not extend to identity documents.**
- **EF's `EnableSensitiveDataLogging` prints every query parameter.** It is on
  under Development only, and `Program.cs` refuses to start as production with
  it on (CTO, 17 Sept). A development log still shows parameters, so where the
  encryption happens matters (§4).
- **Backups:** encrypted with a paper passphrase; local copies kept 3 days,
  off-box 7 days (0010, corrected 25 Sept). A database dump today is the whole
  database.
- **Roles:** `it_admin`, `manager` and `auditor` are assignable and enforce
  nothing (handover §5.1). Nothing in this document may rest on them.

## The threat this is designed against

In order of likelihood, as I see it:

1. **The wrong person inside the customer sees it.** A colleague, a line
   manager, a recruiter browsing employee records. This is the commonest real
   harm, and the one encryption at rest does nothing about. §5 and §6 answer it.
2. **It leaks sideways**: into logs, the audit trail, an AI prompt, an email,
   an error message, a CSV export, the search index or a support screenshot.
   §7 answers it.
3. **A copy of the database leaves us**: a backup, a dump on a laptop, a
   restored drill database. §4 answers it: **a database copy alone decrypts
   nothing.**
4. **Another organisation reads it.** The tenant fence answers this as it does
   everywhere (RLS + EF filter), and §4's binding makes a moved ciphertext fail.

It does **not** defend against someone holding both the database and the
production server's key file — that is root on our server. Saying so plainly is
part of the design.

---

## 1. Collect less — before anything about storing it

**The cheapest identifier to protect is the one we never stored.**

| Data | Proposed default | Why |
|---|---|---|
| **Aadhaar number** | **Not stored in full. Last four digits + "verified by HR on <date>, by <person>".** | Its main use in an employer's hands is KYC against EPFO, which the employer does on the EPFO portal. If a customer needs the full number in TatvaOS (say, a payroll provider wants it in a file), that is an explicit per-organisation switch, and the full number is then held as §4 describes. **Amit decides** whether the full number is ever offered. |
| **Aadhaar card image** | **Not stored.** HR looks at the original and ticks "seen". | A scan carries the photo, address and full number, which is everything §1 tries not to hold. |
| **PAN** | Stored in full (§4). TDS needs it. | |
| **Bank account + IFSC** | Account number stored in full (§4); IFSC and bank name in plain text (not identifying alone). | Salary needs it. |
| **UAN, ESI number, passport** | Same class as PAN, added only when a feature needs them. | Nothing collected "in case". |

The minimisation is a product promise, so **Amit decides** this table. My
recommendation is the table as written.

## 2. What "a sensitive field" means in code

One list, in one file — `Modules/People/SensitiveFields.cs`: Aadhaar, PAN,
bank account number, and later UAN, ESI and passport. **Being on that list
changes how a value is stored, read, logged and exported** (§4–§7), and a
build check (§8) refuses a property with one of those meanings that is not on it.

They live in **their own table**, never on `people.employees` and never on
`core.users`: `people.employee_identifiers`, one row per (employee, kind). The
employee row can then be read, listed, searched and exported without its query
ever touching an identifier. That is the "separately from the rest of the row"
requirement, made structural rather than a matter of discipline.

```
people.employee_identifiers
  tenant_id, employee_id          composite FK to people.employees
  kind                            'aadhaar' | 'pan' | 'bank_account' | …
  ciphertext   bytea              AES-256-GCM, §4
  key_version  smallint           which data key sealed it
  last4        text               shown masked: XXXX-XXXX-1234
  lookup_hash  bytea  NULL        HMAC for "is this PAN already on file", §4
  verified_at, verified_by        "HR saw the original"
  created_at, created_by, updated_at, updated_by
  FORCE RLS, nullif policy; the app: SELECT/INSERT/UPDATE/DELETE; no DbSet,
  one gate class (as HireAccess is for Hire)
```

## 3. Not built until People's basic employee record exists

This depends on `people.employees` (see the reporting-hierarchy question put to
Mr. Singh on 8 Oct). It is designed now, as asked, and built with Phase 5.

## 4. Encryption: envelope, its own key, bound to its row

- **A master key of its own**: `People:IdentifierKey`, 32 random bytes,
  **no fallback to anything**. If it is missing, every identifier screen and
  endpoint answers "not configured" and **nothing can be saved**. It fails
  closed, unlike the JWT fallback chain. It lives in the server's environment
  file, **not in the database, and not in the database backups.**
- **A data key per organisation**: random, stored **wrapped by the master key**
  in `people.identifier_keys (tenant_id, version, wrapped_key)`. Rotating the
  master key re-wraps a few hundred small keys, not every record. A version
  number lets old and new keys exist side by side during a rotation.
- **AES-256-GCM, a random nonce per value.** The **associated data** is
  `tenant_id | employee_id | kind`, so a ciphertext copied onto another person,
  another field or another organisation **fails to decrypt** rather than
  reading as someone else's PAN.
- **Encrypted in the API, before Entity Framework sees it.** The database, its
  logs and EF's parameter logging only ever see ciphertext.
- **`lookup_hash`** = HMAC-SHA256 of the normalised value, with a **second,
  separate** key (`People:IdentifierLookupKey`). It answers "this PAN is already
  on another employee" without decrypting anything. It is created only for kinds
  that need a duplicate check (PAN, bank account), never for Aadhaar.
- **Losing the master key loses every identifier.** It needs an offline copy
  held apart from the database backups. I suggest the same arrangement as the
  backup passphrase: on paper, with Amit. **Mr. Singh rules.**

**What this buys:** a stolen backup, a dump on a laptop, a restore-drill
database or a bad SQL query shows `\x8f3a…` and the last four digits. **What it
does not buy:** protection from someone with root on the production server
(see "The threat this is designed against"), or from the people §5 allows to
read the values.

## 5. Who may see the full value — the decision Amit owns

Shown **masked** everywhere by default (`XXXX-XXXX-1234`). The full value only
through an explicit **Reveal**, which:

- is allowed to **the employee themselves** (their own record, always) and to
  **people the organisation names as HR for identifiers**, a Hire-style
  per-product role (as `hire.team_members` is), **not** `org_admin`
  automatically and **never** `manager` (§5.1 of the handover: it means
  nothing yet);
- needs a **reason**, picked from a short list (payroll set-up, statutory
  filing, correction, the employee asked) plus optional text;
- asks for **two-step verification again** if it was not done in the last
  15 minutes;
- shows the value for 30 seconds and does not put it in the page's state, the
  URL or the clipboard automatically;
- writes **one audit row per value revealed** (§6).

**Amit decides:** whether organisation owners get Reveal by default, or only
the named HR people. I recommend named people only, with the owner able to
name themselves, so every reveal has a person who chose to hold that right.

## 6. Every read audited — and what the audit holds

`people.identifier_reads` (append-only for the app: INSERT only, like
`core.audit_logs`): tenant, **who**, **whose**, **which kind**, reason, when,
from which address. **Never the value, nor the last four.**

- Each export or payroll file counts as reads: **one row per value
  included**, with the export's id. "Who has seen my PAN?" then has a complete
  answer.
- **The employee can see their own read log.** That is the point of auditing
  per read: the person it is about can check it.
- **A read that fails to decrypt** (wrong key, a moved ciphertext) is logged
  at Error and audited as `failed`, never shown as empty, so a key problem is
  loud.

## 7. Where these values must never go — enforced, not hoped

| Place | Rule | Enforced by |
|---|---|---|
| Logs | never | encrypted before EF (§4); a test reads the API log after a reveal and finds no value |
| `core.audit_logs` before/after | never; the field name and "changed" only | the gate writes the audit itself; a test asserts it |
| AI (AiGate, Docs AI, Mail AI) | never sent | `SensitiveFields` values are masked before any prompt builder; the AI-gate source check gains a rule |
| Email, SMS, notifications | never; "your PAN was updated" only | the gate exposes no plain value to the notifier |
| Search index, exports, CSV | masked, unless the export is a declared payroll file (audited per value, §6) | the export builder takes masked values only, except the payroll path |
| Error messages and 4xx bodies | never echo the input | validation messages name the field, not the value |
| The browser | not cached; `Cache-Control: no-store` on reveal responses | a test on the response headers |

## 8. The checks that make this true, and their red runs

Each is to be shown failing once before it is trusted (handover §7):

1. **Structure (source scan, like `check-job-gate.sh`):** no entity property
   named like an identifier (`Aadhaar`, `Pan`, `AccountNumber`, …) outside
   `employee_identifiers`; no `DbSet` of it; only the gate references it.
   *Red:* add `public string Pan` to `Employee`.
2. **At rest (database test):** after saving a known PAN through the API, the
   table's `ciphertext` does not contain it, in text or in any common encoding,
   and `pg_dump` of the table does not contain it. *Red:* store plain text.
3. **Binding:** copy one employee's ciphertext onto another, then reveal. It
   must fail, and the failure must be audited. *Red:* drop the associated data.
4. **Fail closed:** start the API without `People:IdentifierKey`. Saving is
   refused and screens say "not configured". *Red:* add a fallback.
5. **Per-read audit:** N reveals produce N rows; an export of M people produces
   M rows; no row contains the value or its last four. *Red:* audit on write
   only.
6. **Isolation:** the two-tenant suite with all three tables (`identifiers`,
   `identifier_keys`, `identifier_reads`): see-own, no-context-zero, forged
   insert, cross-tenant decrypt fails. *Red:* drop RLS on one.
7. **Logs:** run the reveal under Development logging (parameters printed) and
   grep the API log for the value. *Red:* encrypt after EF instead of before.

## 9. Deletion — different from mail, as the welcome says

- **On exit:** identifiers are kept only as long as the law requires for
  payroll and tax records, then **deleted automatically** (the #271 pattern: a
  switch, a sweep, count-only audit). **The period is a lawyer's answer, not
  mine.** Payroll and tax records have statutory retention periods, and I will
  not guess them.
- **Bank details** can usually go sooner: after the full-and-final settlement
  is paid. **Amit/lawyer.**
- **From backups:** a deleted identifier remains in database backups until they
  age out (3 days local, 7 off-box). Because the data key is per organisation,
  deleting a whole organisation can also **delete its data key**, which makes
  every backup copy of its identifiers unreadable at once ("crypto-shredding").
  A single employee's erasure relies on backups ageing out: *"deleted from live
  systems at once and from backups within a further seven days"*, the same
  sentence 0010 uses for candidates.
- **The read log** (§6) is kept as long as the identifiers it describes and
  goes with them, unless the lawyer says the log must outlive them.

## 10. Questions this document cannot answer

**For Amit (product):**
1. §1: is the full Aadhaar number ever stored, and are card images ever
   stored? (I recommend no to both by default.)
2. §5: do organisation owners get Reveal by default, or only named HR people?
   (I recommend named people.)

**For Mr. Singh:**
3. §4: the key arrangement: its own master key with no fallback; the offline
   copy and who holds it; a per-organisation data key.
4. §5: re-asking for two-step verification before a reveal. This is the first
   step-up in TatvaOS, so it is a sign-in change.
5. Whether this record should also settle Hire's résumé files, which hold
   personal data but are not this class. My suggestion is **no**: 0010 governs
   them.

**For the lawyer (through Mr. Singh):**
6. Whether UIDAI's rules on storing Aadhaar numbers (the "Aadhaar Data Vault"
   circulars) bind an employer that keeps Aadhaar for payroll. §1's default
   avoids the question by not storing it.
7. Retention after exit for PAN, bank details and the read log (§9).
8. **A correction to check:** the welcome (§3.2) and the roadmap (§6.3) call
   these "sensitive personal data under the DPDP Act". My understanding is that
   the DPDP Act 2023 does not have a "sensitive" category; that term came from
   the 2011 SPDI Rules under the IT Act. **I may be wrong, and the design does
   not depend on it.** It treats these as the highest class either way. But the
   sentence should be checked before it reaches a customer.

## Consequences

- **Easier:** a leaked backup or dump is not an Aadhaar/PAN incident. "Who saw
  my PAN" has an answer. A new identifier kind is one entry in one list.
- **Harder:** two new keys to keep safe, and losing the master key loses the
  data. Every export path has to know about masking. Phase 5 waits for
  `people.employees`.
- **Accepted:** root on the production server can read everything. A
  determined insider with Reveal rights can still copy what they reveal; the
  per-read audit makes that visible, not impossible.

## Revisit when

- a customer asks for its own key (bring-your-own-key), or for keys in a
  managed key service rather than a file on the server;
- the full Aadhaar number has to be stored after all (§1). Then re-read §4
  against UIDAI's data-vault rules with the lawyer;
- TatvaOS runs on more than one server, and the key file stops being one file
  in one place.
