# 0013 — Internal-only departments: enforce them, or stop offering them

**Status:** accepted as the design (Mr. Singh, 2 October 2026). Whether to build it, or to leave the console's honest "coming soon" (#371), is Amit's decision. The bounce precondition below is built (#373).
**Date:** 2026-10-01

## Context

`core.departments.can_send_external` is saved, shown with an "internal only" badge, and was described to administrators as "Off means they can only email colleagues". No sending path reads it. Every school that signs up gets a default "Students" department set to internal-only, so the product made the promise by itself. PR 371 makes the screens honest meanwhile, and house rule 7a forbids it happening again. **Production, 1 Oct:** 2 such departments, in 2 organisations that are not live, with 0 active people. Nobody has relied on it yet.

## Where the check lives: one place, the sender gate

Postfix already runs one sender check on **both** submission ports, the API's (10587) and mail clients' (587). The check is `check_sender_access` against `sql/sender-external-gate.cf`, over the view `mail.senders_allowed_external` (migration 0006). A sender missing from the view falls into the `internal_only` class: the organisation's own domains are allowed, everything else gets a 550.

**Proposal:** a mailbox whose owner (`mail.mailboxes.user_id` → `core.users.department_id`) sits in a department with `can_send_external = false` is left out of that view. The view runs as its owner, so the mail edge still needs no grant on departments (PR 363). The gate query returns a second class, `internal_only_department`, so the refusal says *why* (wording below). The domain reason keeps today's text.

## Every path, checked on 1 October 2026

| Path | How it sends | Meets the gate? |
|---|---|---|
| Webmail and the phone app | `MailSender` → port 10587, sender = the mailbox | yes |
| Mail apps (Thunderbird and the like) | port 587, SASL, sender = the mailbox | yes |
| Automatic replies (`VacationReplyWorker`) | port 10587, sender = the mailbox | yes |
| Calendar invitations (`CalendarInvitationMailer`) | `MailSender`, the organiser's mailbox | yes |
| Mail filters that forward / Dovecot redirect / aliases pointing outside | none of these exists | n/a |
| **Organisation send API, with bounce tracking on** | sender = a **signed bounce address**, which is not a mailbox | **no**: the gate finds no row and lets it pass |

**The last row is a precondition, independent of this decision.** With bounce tracking on, the existing verified-domain rule is skipped for the send API as well. It is **off today** (production 1 Oct: bounce domain set, no signing key), so nothing is exposed. It switches on the day a signing key is added for the bounce-routing work. **Fix first**, with one of two options:

- **(a) The gate resolves the bounce address.** The send id inside the address leads to the mailbox that send is from, and the same rule applies.
- **(b) The send API checks the view itself** before submitting, for the From mailbox, whenever it sets its own envelope. One more caller of the same view, not a second rule.

I lean to (a): it keeps Postfix the only enforcer. Red first either way: bounce tracking on, an unverified domain, an outside recipient → refused.

**Built as (a) in #373, approved by Mr. Singh on 2 Oct 2026.** The decision lives in one function, `mail.sender_gate_class`, which the gate query calls. A bounce-shaped address with no send behind it is **refused** (fails closed).

The first draft of this section said to write the `mail.api_sends` row before the submit and update it after. **That does not work.** `api_sends` is append-only for the app (`20260905-mail-bounce-intake.sql` revokes UPDATE and DELETE), and #373's first green run failed every send with "permission denied for table api_sends".

What was built instead is a separate table, `mail.api_send_envelopes`. It holds only the send id, the tenant and the from-address, and the send API writes it before each bounce-tracked submit. It is append-only too: the migration grants the app SELECT and INSERT, revokes UPDATE and DELETE, and gives the mail edge no grant. The isolation suite checks the revoke, and is calibrated against it.

**Retention: none yet, and it can be pruned.** The gate needs a record only for the seconds a submit takes, so rows older than **one day** can be deleted without affecting it. Nothing deletes them today: the app has no DELETE on the table, so pruning would be a job running as the migration role. It is not built, and not needed at today's volume.

## What the sender sees: a clear refusal, never a silent drop

- **Webmail and phone:** before submitting, the API reads the **same view** (no second rule) and refuses the whole send, naming the outside recipients; nothing is sent and the draft is kept. Postfix stays the enforcer behind it.
- **Mail apps:** Postfix answers `550 5.7.1` at the outside recipient. Proposed text: *"Your department can email people inside your organisation only. Ask your administrator."* The wording is customer-facing, so it goes to Mr. Singh.
- **Automatic replies and invitations:** an outside one is skipped and logged once, never retried in a loop.

## Open questions

1. **Shared mailboxes.** An internal-only person who may send as a shared mailbox can reach outsiders through it. Close it (refuse send-as for internal-only people) or accept it? Amit and Mr. Singh.
2. **The send API sending as an internal-only person's mailbox:** refused, like every other path. Proposed: yes.
3. **The default "Students" department.** Keep it internal-only by default once this is enforced? It's a safeguarding default for schools. Amit.
4. **At switch-on:** mail already queued is not recalled. The screens' wording changes in the same PR as the enforcement (rule 7a).

## Proof before it ships (red first, each on its own throwaway database plus the mail stack)

For **every path in the table**: an internal-only person's outside mail is refused with the expected code and wording; their inside mail is delivered; a normal person is unaffected; a shared mailbox behaves as question 1 decides. Calibration: the same suite with the view unchanged lets every outside mail through. It runs in CI's Mail stack job, which already starts Postfix and Dovecot.
