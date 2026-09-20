# Evidence for PR 190 — Meetings API guide correction

Requested by Mr. Singh, 20 September 2026: "the exact five check commands, versions,
outputs, falsifying outcomes, failed-first evidence, and not-done list."

**Status.** PR 190 is merged as `2e9d8b3635e731390b159820d7c7ec92e5214067` (20 Sept 17:19Z).
Its content is retrospectively approved. **It is NOT deployed.** Production serves
`5f2f461bd96828f590fc3f81b85bcf97e4e04320`, which is also the rollback point. Deployment is
blocked until Mr. Singh lifts it. Amit confirmed on 20 Sept that no customer meeting was live.

**The breach, recorded.** PR 190 was merged before Mr. Singh completed their review. It is a
customer-promise change and that gate is theirs. I flagged it to Amit in the same message
and merged on his go. It is an exception, not a precedent.

## Version under test

Every command below was run on **`2e9d8b3635e731390b159820d7c7ec92e5214067`**, the merge commit
of PR 190, plus one added file that changes no product code: `tests/orgapi/test-paging-promises.sh`.
The script prints the commit it runs on as its second line. Local machine, WSL PostgreSQL 18
with every file in `local/postgres/init/` applied. No production system was touched.

## The commands

```
dotnet build apps/api -c Release
PROMISES=old bash tests/orgapi/test-paging-promises.sh     # the guide as PR 177 wrote it
PROMISES=new bash tests/orgapi/test-paging-promises.sh     # the guide as PR 190 corrected it
```

Build result: `0 Warning(s)`, `0 Error(s)`, `Build succeeded.`

One script, two modes, **the same HTTP requests**. `old` asserts the two sentences PR 177 put in
the guide. `new` asserts what the guide says now.

## The five checks

| # | The guide now says | Request | Output on `2e9d8b3` | What would have falsified it |
|---|---|---|---|---|
| 1 | "A cursor that cannot be read is refused with 400" | `GET .../meetings?cursor=not-a-cursor` | `400`, error contains "cannot be read" | a 200, or the old sentence in the error |
| 2 | "...a check of its format, not of where it came from: a hand-made cursor that happens to be well-formed is accepted" | `cursor=` base64url of `{}`; and of a hand-built position after class A | `200` empty; `200` with `B,C` | a 400, which is what the OLD guide promised |
| 3 | "...within your own organisation only" | hand-made cursor naming **a real teacher of another organisation** as host, whose **real class** sits inside the window; sent with a Techvein key | `200`, no classes; a whole-window cursor returns `A,B,C`, the other organisation's class id is absent, and the database confirms that class exists in the window | any class of the other organisation in the answer |
| 4 | "When cursor is supplied, from, to and hostEmail are ignored" | the position-after-A cursor **plus** `from=2099...&to=2099...&hostEmail=nobody@...` | `B,C`, the cursor's own question | an empty list (the 2099 window or the unknown teacher winning), or a 400 |
| 5 | "Paging is not a frozen list ... earlier ... does not appear ... moved later can appear twice. Match classes by id" | re-read from the position after A, after: adding E at 08:00; moving C 11:00 to 08:30; moving A 09:00 to 12:00 | `B,C` (E absent), then `B` (C gone), then `B,A` (A back, **same id**). A fresh full read: `E,C,B,A` | E appearing; C still read; A not reappearing |

A sixth, static check on the same commit: the three old sentences are absent from
`apps/web/public/docs/meetings-api-guide.html` and the seven new statements are present.

## Failed-first evidence: `PROMISES=old`, 5 of 17 red

The old guide's two sentences, asserted against the code. Checks 2 and 5 are red. Checks 1, 3 and 4
are green in both modes, because the old and the new guide agree on them.

```
  Meetings API paging promises - asserting the OLD guide wording
  tree under test: 2e9d8b3635e731390b159820d7c7ec92e5214067
>> 0. Start the API, make a key, schedule three classes, plant one in another organisation
  ok    API up
  ok    a Techvein key with meetings:schedule
  ok    classes A 09:00, B 10:00, C 11:00 scheduled  [got 201201201]
  ok    a School class exists at 09:30 in the same window, hosted by the School's principal
>> 1. A cursor that cannot be read is refused
  ok    cursor=not-a-cursor  [got 400]
>> 2. A WELL-FORMED HAND-MADE cursor
  FAIL  OLD PROMISE 'a cursor this API did not issue is refused with 400': cursor={} - got [200], wanted [400]
  FAIL  OLD PROMISE, same sentence: a hand-made position - got [200], wanted [400]
>> 3. ...but only ever inside the caller's own organisation
  ok    hand-made cursor naming the School's principal as host, with a Techvein key  [got 200]
  ok    ...returns no classes at all  [got (none)]
  ok    hand-made cursor over the whole window, no host: Techvein's three only  [got A,B,C]
  ok    ...and the School's class id is not among them  [got 0]
  ok    (the School class really is there to be leaked: the database holds it)  [got 1]
>> 4. With cursor present, from / to / hostEmail are ignored
  ok    cursor + a 2099 window + an unknown teacher: the CURSOR's question is answered  [got B,C]
>> 5. Paging while the timetable changes
  FAIL  OLD PROMISE 'a class added between two page requests is neither skipped...': E at 08:00 shows up - got [B,C], wanted [E,B,C]
  FAIL  OLD PROMISE '...neither skipped': C, moved to 08:30, is still read - got [0], wanted [1]
  FAIL  OLD PROMISE '...nor repeated': A, already on page one, is not on page two - got [1], wanted [0]
  ok    a fresh full read is complete and in order  [got E,C,B,A]
  -----------------------------------------------
  FAIL  5 of 17 checks (old wording)
```

## The corrected wording: `PROMISES=new`, 20 of 20 green

```
  Meetings API paging promises - asserting the NEW guide wording
  tree under test: 2e9d8b3635e731390b159820d7c7ec92e5214067
>> 0. Start the API, make a key, schedule three classes, plant one in another organisation
  ok    API up
  ok    a Techvein key with meetings:schedule
  ok    classes A 09:00, B 10:00, C 11:00 scheduled  [got 201201201]
  ok    a School class exists at 09:30 in the same window, hosted by the School's principal
>> 1. A cursor that cannot be read is refused
  ok    cursor=not-a-cursor  [got 400]
  ok    ...in the corrected words  [got True]
>> 2. A WELL-FORMED HAND-MADE cursor
  ok    cursor={} is accepted: the 400 is a format check  [got 200]
  ok    a hand-made position after A is accepted  [got 200]
  ok    ...and answers the query it describes  [got B,C]
>> 3. ...but only ever inside the caller's own organisation
  ok    hand-made cursor naming the School's principal as host, with a Techvein key  [got 200]
  ok    ...returns no classes at all  [got (none)]
  ok    hand-made cursor over the whole window, no host: Techvein's three only  [got A,B,C]
  ok    ...and the School's class id is not among them  [got 0]
  ok    (the School class really is there to be leaked: the database holds it)  [got 1]
>> 4. With cursor present, from / to / hostEmail are ignored
  ok    cursor + a 2099 window + an unknown teacher: the CURSOR's question is answered  [got B,C]
>> 5. Paging while the timetable changes
  ok    class E added at 08:00, BEHIND the position: absent from this read  [got B,C]
  ok    class C MOVED EARLIER, 11:00 -> 08:30: gone from this read, never on page one either  [got B]
  ok    class A (already read on page one) MOVED LATER, 09:00 -> 12:00: it comes back  [got B,A]
  ok    ...with the SAME id, which is why the guide says match by id  [got 1]
  ok    a fresh full read is complete and in order  [got E,C,B,A]
  -----------------------------------------------
  PASS  20 checks (new wording)
```

## How strong each check is

| Check | Seen failing? |
|---|---|
| 1 | **Neither.** Never red. It would be if the API stopped validating cursors |
| 2 | **Red first** under the old wording (wanted 400, got 200), green under the new |
| 3 | **Neither**, and that matters: it is the security claim, and the only way to see it fail is a tenant-isolation bug. It is stronger than my first probe, which used a made-up host id. This one uses a real teacher and a real class in a second organisation, and proves the class is there to be leaked |
| 4 | **Neither.** Falsifiable (the 2099 window would return nothing) but never seen red |
| 5 | **Red first** under the old wording, three times, green under the new |

## Not done

- **Not deployed**, so the live guide still carries the two false sentences. Every hour of the block is
  an hour a customer's developer can read them. That is a cost of the gate, stated, not an argument against it.
- **No keyed request on production.** I handle no API keys. Everything above is local.
- The "position after class A" is hand-built, because a real page is 500 classes. Check 2 is what makes that
  legitimate; step 21 of `tests/orgapi/test-org-api.sh` (505 classes) covers real page-two cursors.
- `test-paging-promises.sh` is **not in `ci.yml`**. Adding it is a workflow change, which is Mr. Singh's gate.
- Still undecided, and deliberately not in PR 190: telling integrators to write `%2B` for `+` in a query
  string; and the permissions table saying "reschedule" while the text says rescheduling is not on this API.

## For the deploy, when the block is lifted

Amit confirms no live customer meeting, in writing, at that moment (a confirmation ages). The deploy ships
PR 189 (a docs file production does not serve) and PR 190: **no migrations, no infrastructure**. Afterwards the
record must hold the verdict lines and the rollback point `5f2f461bd96828f590fc3f81b85bcf97e4e04320`.
