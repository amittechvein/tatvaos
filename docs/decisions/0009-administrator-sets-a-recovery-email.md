# 0009 — An administrator can set a person's recovery email

**Status:** proposed design, for Mr. Singh's sign-in gate. **Nothing is built.**
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
