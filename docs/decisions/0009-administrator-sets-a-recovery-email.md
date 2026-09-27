# 0009 — An administrator can set a person's recovery email

**Status:** accepted by Mr. Singh, 24 Sept 2026, option 2 with the corrections in his ruling at the end of this record. **Nothing is built yet.**
**Date:** 2026-09-21
**Asked by** Amit through Mr. Singh's ruling of 21 September: "administrators should
be able to set a recovery email on an existing person, and it is the missing half
of 195 … design that one and send it to me before building."

## Context

PR 195 (merged, not deployed) gives an administrator two rescues, **Send
invitation** and **Send sign-in link**. Both email a one-use link to the person's
recovery address. A person with no recovery address cannot be rescued except by
**Reset password**, where the administrator sees the password and hands it over.
Today a recovery address can only be set at creation, or by the person themselves
from their account page (`POST /api/auth/recovery-email`, which asks for their
current password, mails a confirmation link, and tells their sign-in mailbox).

Mr. Singh named the danger: **an administrator who can write another person's
recovery address can point it at themselves, send a sign-in link, and own the
account.**

## The condition that does not do what it seems to

Mr. Singh's first condition: "the new address must be verified by mail to that
address before it becomes usable for recovery." That is necessary, and it is
**not sufficient against the attack it is meant to stop.** If the administrator
types an address they control, the confirmation goes to them, and they confirm it.
Verification proves an address can receive mail. It says nothing about whose it
is. Every other condition in the ruling — audit, hierarchy, notice to both
addresses — detects the takeover; none prevents it, because an administrator can
move faster than the person reads their mail.

So this design adds one thing the ruling did not ask for: **time**.

## What is proposed

1. **Where.** A "Recovery email" field in the People → Edit dialog, with its own
   Save, beside the two rescue buttons. `PUT /api/org/users/{id}/recovery-email`.
2. **Who.** The same guards as Reset password and Send sign-in link: not yourself
   (your own goes through your account page and your current password), and only
   down the hierarchy (`GuardActOn`), and not a closed account.
3. **The new address is verified** by a confirmation link mailed to it, exactly
   as the self-service flow does. Until confirmed it is not the recovery address.
4. **It is not usable for a rescue for 48 hours after it is confirmed** — the
   cooling-off period. During it, Send invitation and Send sign-in link to that
   person are refused, and the dialog says so with the time it ends ("Recovery
   email changed by an administrator — links can be sent from 23 Sept 18:40").
   Reset password stays available, because it is visible: the person finds their
   password changed and knows.
5. **The person is told, at once, everywhere they can be reached:** their sign-in
   mailbox, the OLD recovery address if there was one, and the NEW one. The notice
   names the administrator, says the rescue links are held for 48 hours, and
   carries a **"this was not me" link** that, from the old address or the mailbox,
   cancels the change and restores the previous address. Using it writes an audit
   row and tells Mr. Singh's review queue.
6. **Audited with both values**, masked the way the rest of the audit log masks
   addresses (`r•••@gmail.com`): `user.recovery_set_by_admin`, before and after,
   actor, and whether the old address was verified.
7. **A new person's first address is not held.** Setting a recovery address for
   someone who has **never signed in and has no password** carries no takeover
   risk the creation form did not already carry — at creation the administrator
   typed it with no hold at all. So the 48 hours applies only when the person has
   a password, i.e. has something to take.

## Options

1. **Verify only**, as first asked. Simple. Does not stop the takeover (above).
2. **Verify + 48-hour hold + "this was not me"** (proposed). Stops the fast
   takeover; a person who reads any of three inboxes within two days can stop it;
   the 169 never-signed-in accounts are not delayed (point 7).
3. **Verify + a second administrator must approve the change.** Strongest. Most
   organisations here have one administrator; a two-person rule would make the
   feature unusable for them.

**Recommended: 2.**

## What would prove it — to run before merge, red first where it can be

| Case | Expected |
|---|---|
| An administrator sets an address for someone above them | 403 |
| For themselves | refused; points to their account page |
| For a person with a password: set, confirm, then Send sign-in link at once | refused, naming the time the hold ends |
| The same after 48 hours | sent |
| The same, for a person who never signed in | sent at once (point 7) |
| "This was not me" from the old address | change reverted, audit row, link then refused |
| The notice | reaches mailbox, old and new addresses; names the administrator; the full new address appears in none of them except the new address's own |
| Audit row | both values, masked; actor; verified flag |
| Any address in the People list response | never the full address (as PR 195's step 12) |

## Revisit when

- Anyone is locked out longer than they should be because of the hold.
- An organisation with two or more administrators asks for option 3.

## Questions for Mr. Singh

1. Option 2, and 48 hours?
2. Point 7: agreed that a never-signed-in person's first address is not held?
3. Should "this was not me" also suspend the administrator's ability to change
   recovery addresses until you have reviewed it?

---

## Addendum, 24 September: what the code showed while preparing to build

**Still nothing of 0009 is built.** Amit asked for 197 to start; this is
preparation only, because the ruling above asks for the design before any
building. `tests/recovery-admin/facts-before-0009.sh` pins each fact below by
running it on `main` (15/15 on f9e961f, run twice).

### A. The rescue buttons do not ask whether an address is confirmed

**Send sign-in link** and **Resend invitation** check only that
`recovery_email` is set, not `recovery_email_verified_at`. The script puts an
unconfirmed address on a person who has a password, presses Send sign-in link,
and the link arrives at that address.

**What it changes.** Point 3 above ("until confirmed it is not the recovery
address") only holds if the address an administrator types is kept **out of**
`recovery_email` until it is confirmed. It must be stored as pending
elsewhere. Written into `recovery_email` the way the self-service flow does it,
it would be usable at once, before confirmation and before any hold.

### B. There is a third rescue, and the hold does not cover it

The public **Forgot password → recovery email** page
(`POST /api/auth/password/forgot-recovery`) mails a password-reset link to a
**confirmed** recovery address. It is anonymous, and no administrator is
involved. The script shows the link arriving.

**What it changes.** Point 4 holds only the two administrator buttons. An
administrator who types their own address, confirms it and waits for nothing
can open the sign-in page, ask for a reset through the recovery address, and
take the account. **The hold has to cover this route too.** During the hold it
should give the same reply it gives today (so it reveals nothing) and send
nothing.

### C. The person's own change keeps no previous address

When someone changes their own recovery email, the new address replaces the
old one in `recovery_email` at once, and the old one is kept nowhere. The
script checks this: the old address is found on the row before the change,
and absent after it.

**What it changes.** "This was not me" (point 5) restores the previous
address, so the previous address has to be kept somewhere. The same gap exists
today for the person's own change: if someone changes it while signed in as
them, the notice goes out, but nothing can undo it.

### Build plan, for after the ruling

1. **Migration, additive:** one new table, `core.recovery_email_changes`, with
   forced RLS on `tenant_id`. One row per administrator change, holding:
   - person, administrator
   - old address and old confirmed-at
   - new address, its confirmation-token hash and sent-at, confirmed-at
   - `hold_until`
   - the "not me" token hash, reverted-at and reverted-by

   A table rather than columns, because it keeps the history, and it is where
   point 6's audit and "not me" read from. `recovery_email` changes only when
   the new address is confirmed.
2. **One hold check, called from three places:** Send sign-in link, Resend
   invitation, and `forgot-recovery`. It holds only if the person has a
   password (point 7).
3. **`PUT /api/org/users/{id}/recovery-email`:**
   - the same guards as Send sign-in link: not yourself, `GuardActOn`, not a
     closed account
   - a confirmation mailed to the new address
   - the notices of point 5
   - point 6's audit, masked
4. **"This was not me":** an anonymous route taking the token from the notice.
   It restores the old address and its confirmed-at, ends the hold, writes an
   audit row, and flags the change for review.
5. **The People → Edit dialog:** the field, and the hold's end time on the two
   buttons.
6. **Tests, red first:** 0009's table, plus B (forgot-recovery refused during
   the hold). This file, switched to assert the old behaviour, is the red half.

### Two more questions for Mr. Singh

4. **Send sign-in link to an unconfirmed address (A).** Should it be refused
   for someone who **has a password**? Today it sends. Invitations for people
   who have never signed in must keep working unconfirmed, because that is how
   a new person's first address is used (point 7).
5. **The hold on Forgot password → recovery email (B).** Should it be part of
   0009? Recommended yes; without it the hold does not stop the takeover it
   was added for.

---

## Ruling — Mr. Singh, 24 September 2026 (his words, transcribed exactly)

> **Ruling on decision 0009 — an administrator sets a recovery email. Mr. Singh, 24 Sept 2026.**
>
> Option 2, with a 48-hour hold. Accepted with three corrections and one further answer.
>
> First: during the hold, credential links go to the *old* address if one exists, rather than being refused. That removes the two-day lock-out, and an attacker gains nothing from mail sent to an address they do not control. Where there is no old address, the hold refuses and Reset password remains the fallback, as the record says.
>
> Second: point 7 is narrowed. The hold is skipped only when the recovery address is *empty* — null to value — never when it is being replaced. "Has no password" is not the test; a pending account with an existing recovery address is still worth stealing, and replacing that address is always the full-hold path.
>
> Third: the "this was not me" link is valid for thirty days, not for the 48 hours of the hold. Someone away for three days must still have a remedy. The link reverts only and never issues a session.
>
> On the third question: yes. A change reverted by the person suspends that administrator's ability to change recovery addresses until an owner reviews it. Honest mistake or attempt, the second try should not be possible.
>
> The hold covers every email-delivered credential path — reset, sign-in link, invitation — named explicitly. An owner's own recovery address is changeable only by that owner, with MFA where enabled, and the change notifies every other owner and administrator. Where the record says "Mr. Singh's review queue," it means the organisation's owner and the platform operator; I am a reader, not an alert recipient.
>
> Status: accepted, with the above attached.

### What the ruling changes in this record (lane's note, not the ruling)

The ruling came before the 24 September addendum above was read. Where they
differ, **the ruling wins**:

- **Point 4** ("links refused during the hold") → links go to the **old**
  address during the hold. Refused only where there is no old address.
- **Point 5**, "this was not me" → valid **30 days**; it reverts only and
  never signs anyone in.
- **Point 5**, "tells Mr. Singh's review queue" → tells **the organisation's
  owner and the platform operator**, and **suspends that administrator's
  ability to change recovery addresses** until an owner reviews it.
- **Point 7**, "never signed in and no password" → the hold is skipped **only
  when the address goes from empty to a value**. Replacing an address is
  always held.
- **New:** an owner's own recovery address is changeable only by that owner,
  with MFA where enabled, and the change notifies every other owner and
  administrator.
- **Addendum question 5** (hold Forgot password → recovery email) is
  **answered by the ruling**: "the hold covers every email-delivered credential
  path — reset, sign-in link, invitation — named explicitly".
- **Addendum question 4** (refuse Send sign-in link to an unconfirmed address
  for someone who has a password) is **answered 27 Sept: refuse**. His words
  are below.
- **Build plan step 2** becomes one hold check called from reset,
  forgot-recovery, sign-in link and invitation. During the hold it
  **redirects** to the old address rather than refusing.

## Further ruling — Mr. Singh, 27 September 2026 (his words, transcribed exactly)

> **The 0009 question: yes, refuse.** An unconfirmed address is not a recovery address; the record already says so. If the person has a password, no confirmed old address, and only an unconfirmed new one, Send sign-in link has nowhere safe to go. Refuse, with the reason shown, and Reset password stays as the visible fallback. Make the rule explicit rather than implied.

### The rule, made explicit (lane's note)

**Send sign-in link** goes only to a **confirmed** recovery address, and
during the hold only to the confirmed **old** one. So, for a person who has a
password:

| Confirmed old address | Unconfirmed new address | Send sign-in link |
|---|---|---|
| yes | any | sent to the **old** address (during the hold, per the 24 Sept ruling) |
| no | yes | **refused**, with the reason shown; Reset password is the fallback |
| no | no | refused, as today ("no recovery email") |

**Today's code does the opposite in row two**: it sends to whatever address is
on file (`facts-before-0009.sh`, step A). **Resend invitation** to someone who
has never signed in is not affected: a new person's first address is used
unconfirmed, and that is how it gets confirmed.

