# 0018 — The employee record, and who reports to whom

**Status:** **accepted by Mr. Singh, 9 Oct 2026, with the three additions
below.** Amit's two decisions (§5 directory, §4 owners) are recorded in the
ruling table once he gives them. Nothing here is built yet.
**Date:** 2026-10-09 (proposed and ruled)
**Lane:** Hire & People
**Needs:** Amit (§4, §5). Mr. Singh's part is done.

## The ruling — read this before the proposal

Forwarded by Amit, 9 Oct 2026. **Where the ruling adds to the proposal, the
ruling wins.**

| § | Ruling | What it adds |
|---|---|---|
| Hierarchy question (8 Oct) | **Closed by this record** | One nullable `reports_to`, composite FK, `CHECK` for self, trigger for loops. `people.reporting_changes` kept, because "who was this person's manager on 3 March" is what leave approval asks a year later. |
| §2 Trigger + advisory lock | **Accepted. Keep it in the trigger** | A lock in the endpoint can be forgotten by the next writer (an import, a migration, a hand fix); a lock in the trigger cannot. A closure table or materialised path was considered and rejected: more machinery, same race. **Addition 1, below:** state the lock-key derivation. |
| §3 Manager from `reports_to`, never `core.users.role` | **Accepted, as the right model, not a workaround** | Manager-ness is a relationship: a role cannot say *of whom*. People does not care what `role = 'manager'` comes to mean elsewhere. **Addition 2, below:** writing `reports_to` grants access. |
| §7 check 6 | **Extended** | **Addition 3, below.** |
| §5, §4 | Recommended to Amit as proposed | Mr. Singh: hiding "on notice" is the half that matters; manager's name is the only field with an edge (it shows the whole hierarchy in a small school), and he thinks it is fine. Organisations may narrow the directory. Owners see records only if they name themselves, which costs one click and buys the audit record of the moment they did. **Amit decides.** |

### Addition 1: the advisory-lock key, written down

`pg_advisory_xact_lock` takes an integer, and `tenant_id` is a uuid. The
trigger uses:

```sql
PERFORM pg_advisory_xact_lock(hashtextextended('people.reporting_to:' || NEW.tenant_id::text, 0));
```

- **Namespaced** with `people.reporting_to:`, so a future lock on the same
  organisation for another purpose does not queue behind hierarchy edits.
- **A hash collision makes two organisations' hierarchy edits queue behind each
  other.** That costs contention, **never correctness**: both still check for
  loops under a lock. If someone asks why two unrelated customers' edits
  serialise, this paragraph is the answer.

### Addition 2: setting `reports_to` grants access

Because manager rights come from data, **writing `reports_to` is granting
access**: whoever sets it can make someone a manager and so let them see that
person's record. §4 restricts it to People HR. That is the guard, and it is
stated as a **security property** in the migration header and in
`PeopleAccess`:

> **Setting `reports_to` grants access. It is an access change, not an
> organisational detail, and it is audited as one.**

`people.reporting_changes` is therefore an **access audit**, not only an HR
history, and it is read and kept as one.

### Addition 3: check 6 covers self-appointment

Check 6 (*manager by data*) gains: **a person who sets themselves as someone's
manager appears in `people.reporting_changes` as plainly as a permission
grant**, naming who did it, whose manager they became, and when. *Red:* write
`reports_to` by a path that skips the history row.

---

## Context

Four things are waiting on one table that does not exist yet:

- **The reporting hierarchy**, the last Phase 0 item. "A reports to B" is a fact
  about two employees, and must not hang off `core.users`, which is a login
  (welcome §2; `20260924-a`'s header).
- **Employee IDs** (#409) are a numbering scheme with nothing to number. The
  allocator was deferred "until people.employees".
- **Aadhaar, PAN and bank details** (0015) live in their own table, keyed to an
  employee.
- **Phase 6** (roadmap) is the employee profile and directory, and R5 starts
  there.

This record is **the smallest employee table those four can stand on**, and
deliberately no more. Personal, contact, emergency, documents and bank details
(Phase 6's other boxes) come later, each with its own access rule.

## 1. The table

```
people.employees
  id, tenant_id                     composite (tenant_id, id) unique, for FKs
  employee_code   text NOT NULL     UNIQUE (tenant_id, employee_code); never reused
  user_id         uuid NULL         → core.users, UNIQUE (tenant_id, user_id) where set
  full_name       text NOT NULL     the name at work; a login's display name may differ
  work_email      text NULL
  department_id, designation_id, location_id    composite FKs to core.*, all optional
  reports_to      uuid NULL         → people.employees (same tenant), §2
  employment_type text              'full_time' | 'part_time' | 'contract' | 'intern'
  status          text              'active' | 'on_notice' | 'exited'
  joined_on       date NOT NULL
  exit_on         date NULL         CHECK: set exactly when status = 'exited'
  created_at, created_by, updated_at, updated_by
  FORCE RLS, nullif policy; no DbSet; one gate class (PeopleAccess), as HireAccess
```

- **`user_id` is optional.** Some employees never sign in to TatvaOS (a school's
  support staff), and some logins are not employees (a consultant with a
  mailbox). That is the welcome's §2 in one column.
- **`employee_code` uses #409's scheme.** In auto mode it is allocated at
  creation by `people.next_employee_code(tenant)`, which locks the settings row
  (`SELECT … FOR UPDATE`), formats with `people.format_employee_id()`, and
  increments in the same transaction. Two simultaneous joiners can never get one
  number. In manual mode it is required and typed. Once a code is issued, #409's
  PUT refuses a `next_number` at or below the highest code issued in that
  format.
- **No delete.** An employee who leaves is `exited` with an `exit_on`. When
  exited records are deleted is 0015 §9's lawyer question, answered once for
  both.

## 2. The hierarchy: one column, two rules, and its history

`reports_to` points at another employee **in the same organisation** (composite
FK). That is the whole hierarchy. "Who are my reports" is
`WHERE reports_to = me`, and the org chart is a recursive query.

**Rule 1: never yourself.** `CHECK (reports_to <> id)`.

**Rule 2: never a loop.** A reports to B reports to A must be impossible, or
every "my team, recursively" query runs forever. A CHECK cannot see other rows,
so a **trigger** walks up from the new manager and refuses if it reaches the
employee. Two traps, both from this lane's own history:

- **Two simultaneous changes can build a loop that neither saw.** A→B and B→A,
  saved at the same instant, each find no loop. The trigger therefore takes
  `pg_advisory_xact_lock` on the organisation first, so hierarchy changes
  within one organisation queue up. #267's deadlock (28 Sept) showed that races
  here are real, and that they appear in one round out of five. The test runs
  rounds.
- **A deep chain must not become an outage.** The walk stops at a fixed depth
  (64) and refuses with a sentence rather than looping. No real organisation is
  64 levels deep.

**History.** `people.reporting_changes`: append-only for the app; who, from
whom, to whom, when, and by whom. Leave approval (R5) needs "who was this
person's manager on 3 March", and this table answers that.

**Whoever is exited cannot be a manager.** Exiting someone who still has
reports is refused with *"N people report to X — choose who they report to
now"*. The UI offers a single "move all to …".

## 3. "Manager" comes from the relationship, not from a role

The handover's §5.1 trap: `manager` is an assignable role that grants nothing.
**This record proposes that People never reads that role.** A person is
someone's manager **because a `reports_to` row says so**, and only for those
people. That means:

- no administrator has to remember to appoint someone "Manager" for them to
  approve their team's leave;
- reassigning one report changes one person's rights, not a role that covers
  everyone;
- the `core.users.role = 'manager'` question (Amit's list) can be decided
  separately, for the products that use roles, without blocking People.

Whatever the role decision, **"a manager can see their own reports' leave"
becomes true by data, and the sentence on screen matches the code** (§5.2: the
label is the promise).

## 4. Access, through one gate

`PeopleAccess` is the only way to the table, enforced by a source check (as
`check-job-gate.sh` does for Hire):

| Who | Sees | Changes |
|---|---|---|
| **People HR** (named per organisation, like `hire.team_members`) | everyone, every field in this table | create, edit, set `reports_to`, exit |
| **Organisation owner/admin** | as People HR **if they name themselves**; not automatically | as People HR, if named |
| **A manager** (§3) | their reports, recursively: this table's fields | nothing here (leave approval is R5's) |
| **The employee** | their own record | nothing here (self-service edits come with Phase 6's personal fields) |
| **Everyone else in the organisation** | the **directory** only (§5) | — |

## 5. The directory: Amit decides how open it is

Phase 6 promises a directory "searchable by employee ID, name, department,
designation, location, manager, status". Every row of that is visible to every
colleague. Proposed default:

- **Visible to everyone in the organisation:** name, designation, department,
  location, work email, manager's name.
- **Not in the directory:** employee code, status, joining and exit dates,
  employment type. A colleague does not need "on notice" or "contract".

**Amit decides** whether the default stands, and whether an organisation may
narrow it (some schools may not want staff to see each other at all).

## 6. Hire to People: the candidate who joins

When an application reaches **Joined** (#267's last stage), HR may **create the
employee from it**: name, work email, job's department, designation and
location are copied; the hiring manager is offered as `reports_to`. A copy, not
a link. The candidate record then follows Hire's retention (#271) like any
other, and People does not keep the application, the CV or the rejection
history of other candidates. One person in two products, with the boundary in
one place (roadmap §7: "where a Candidate→Employee conversion is least likely
to go wrong").

## 7. The checks, each with its red run

1. **Isolation** (two-tenant suite): see-own, no-context-zero, forged insert;
   **`reports_to` cannot point into another organisation, even as postgres**
   (composite FK). *Red:* a single-column FK.
2. **Loops refused:** self, two-step, five-step. *Red:* drop the trigger.
3. **Loops refused under a race:** N rounds of A→B and B→A saved at once; the
   hierarchy afterwards has no loop and every request answered 200 or a 409
   with a sentence, none 500. *Red:* drop the advisory lock (expect a loop in
   some round).
4. **Codes never collide:** 20 simultaneous creates in auto mode give 20
   distinct codes, contiguous. *Red:* allocate without `FOR UPDATE`.
5. **The gate:** no `Set<Employee>` or `people.employees` SQL outside
   `PeopleAccess`. *Red:* read it from a test endpoint.
6. **Manager by data:** a person with `role = 'manager'` and no reports sees no
   one's record; a person with `role = 'employee'` and two reports sees exactly
   those two. *Red:* gate on the role.
7. **Exit with reports refused**, with the count in the sentence.

## 8. Questions

**For Amit:**
1. §5: the directory default, and whether an organisation may narrow it.
2. §4: organisation owners see employee records only if they name themselves
   People HR. (I recommend this, as 0015 §5 does for identifiers.)

**For Mr. Singh:**
3. §2: the trigger with an advisory lock per organisation, versus another way of
   keeping the hierarchy loop-free.
4. §3: People never reads `core.users.role`. Is that the right separation while
   the role decision is open?
5. Whether this record **closes the reporting-hierarchy question** from 8 Oct,
   or whether he wants the hierarchy built some other way.

## Consequences

- **Easier:** the hierarchy, employee IDs, identifiers and the directory all
  have their foundation. Manager rights cannot drift from the org chart.
- **Harder:** every People read goes through one gate (the point, but more
  code). Hierarchy changes in one organisation are serialised (fine at our
  sizes; see Revisit).
- **Accepted:** one manager per person. Dotted lines, matrix reporting and
  acting managers are not in this record.

## Revisit when

- a customer needs dotted-line or matrix reporting;
- an organisation is large enough that serialised hierarchy changes are felt
  (thousands of changes a minute, which is not a school);
- Amit decides what `core.users.role = 'manager'` means for the other products.
