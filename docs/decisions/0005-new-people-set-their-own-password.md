# 0005 — New people set their own password: an invitation link, or a password the admin types

**Status:** built 16 Sept 2026 (Core), on the four proposals below as
proposed — Amit has not yet said otherwise. Proven by
`tests/invitations/test-invitations.sh` against the local stack (61 checks,
including a red-first calibration of the single-use rule). Two departures
from the text, both deliberate: the bulk import mails its invitations after
the response, as it already did the welcomes, and writes each outcome to the
row (`invite_delivered`) so the people list says "not delivered" rather than
the results table — 200 synchronous sends would time the import out; and
there is no `invite_attempts` column, because nothing counts attempts on a
token that is found by its 256-bit hash (the reset's counter exists for the
six-digit phone code).
**Date:** 2026-09-15

## Context

When an admin adds people today — one at a time or many from a spreadsheet —
a blank password makes TatvaOS generate one
(`Modules/Admin/Endpoints/UserEndpoints.cs`, `CreateAsync` and
`BulkCreateAsync`). The admin sees it once, can download the whole list as a
CSV, and hands each password over by hand, chat or printed slip. The person
must change it at first sign-in. A welcome email goes to the person's new
TatvaOS mailbox, deliberately without the password — which means it lands
somewhere the person cannot open until they already have the password.

So TatvaOS never tells anyone their password; the admin does. For a school
adding forty people that is a spreadsheet of working passwords on an admin's
laptop, passed around by whatever is to hand. It is the weakest step in
onboarding.

**Amit's decision, 15 Sept 2026:**

- Recovery info exists → auto-generate, and send a "set your password" link
  to the recovery address.
- No recovery info → the admin must type a password in the upload; it cannot
  be left blank. They hand it out from the list.

**What already exists and is reused**, read on 15 Sept:

- Password reset: a high-entropy token from `TokenIssuer`, stored only as a
  hash in `core.users.password_reset_hash`, with `password_reset_sent_at` and
  an attempt counter (`0014-password-reset.sql`); a one-hour email link and a
  five-minute phone code (`AuthEndpoints.cs`, the forgot and reset handlers).
- Recovery email: stored with `recovery_email_verified_at`; the forgot-by-
  recovery flow only trusts a verified address
  (`20260904-user-recovery-email.sql`, `ForgotPasswordViaRecoveryAsync`).
  The reset handler already records that a used email link proves the
  address is readable.
- Email: `SystemMailer` in `apps/api/Shared/Notify/Notify.cs`.
- Text messages: `SmsSender` in the same file sends only a six-digit code
  (`SendOtpAsync`). There is no way to send a link by text today.
- Both existing token links carry the token in the query string
  (`/reset-password?token=…`, `/verify-recovery-email?token=…`). Decision
  0003 moved credential codes into the URL fragment for the handoff; the
  invitation link follows 0003, not the older pattern.

## Options

1. **Keep the handed-over password.** No work. The password list is the risk.
2. **Invitation links where recovery info exists; an admin-typed password
   where it does not** — Amit's rule. No generated password is ever seen by
   anyone; the admin types only the passwords they will hand out themselves.
3. **Text the generated password to the recovery phone.** Less work than 2,
   but a working password sits in an SMS.

## Decision

Option 2.

**The rule, per person, in both the bulk upload and the single "add person"
form:**

| Recovery email | Recovery phone | Password column | What happens |
|---|---|---|---|
| present | either | blank | Account created with no usable password; invitation emailed to the recovery email |
| absent | present | blank | Account created with no usable password; invitation texted to the recovery phone — once the SMS template exists (see below) |
| absent | absent | blank | **Refused.** "No recovery email or phone for this person — type a password to hand to them." |
| any | any | typed | Typed password used, must be changed at first sign-in, no invitation; the admin hands it out |

The last row is a proposal for Amit to confirm: when an admin types a
password for someone who also has recovery info, the typed password wins and
no invitation is sent, because the admin has said how this person will get
in. The rule applies to the single-person form as well as the upload, also
for Amit to confirm, so there is one rule for "how a new person gets in", not
two.

The refusal is enforced by the API, not only by the browser: the preview
shows it as the row's problem, and `BulkCreateAsync` and `CreateAsync` refuse
it on their own if a request arrives without the browser's checks.

**The invitation.**

- New additive columns on `core.users`: `invite_token_hash`,
  `invite_sent_at`, `invite_channel`, `invite_attempts`,
  `invite_accepted_at`. Separate from the reset columns on purpose: a
  "forgot password" request must not overwrite a pending invitation, and an
  invitation must not be mistaken for a reset.
- The token is the same kind the reset uses, stored only as a hash,
  single-use, and valid for **72 hours** — a proposal for Amit; a school
  onboarding before a weekend needs longer than the reset's one hour.
- The link is `https://core.tatvaos.com/welcome#t=<token>` — **in the
  fragment**, as 0003 decided. The page removes it from the address bar and
  history before anything else runs, asks for the new password, and sends
  both by POST to `/api/auth/invite/accept`.
- Accepting sets the password under the same policy as every other password,
  sets `password_changed_at`, clears the token, records `invite_accepted_at`,
  and — when the invitation went by email — sets `recovery_email_verified_at`,
  because following the link proves the address is readable.
- Until accepted, the account has no usable password, so sign-in refuses it
  with any password.

**The email.** A new template beside `ResetEmail`: the organisation's name,
the person's new TatvaOS address, a "Set your password" button, and when the
link expires. No password, ever. It goes to the recovery address; for invited
people it replaces the welcome email to the new mailbox.

**The text message.** `SmsSender` gains a method to send an invitation link.
Commercial SMS in India normally has to match a template registered with the
provider, and a template carrying a link may need its own registration. Until
that template is approved, a phone-only person is treated as having **no**
recovery info: the admin types a password. That is a launch rule, not the end
state, and registering the template is Amit's task with the SMS provider.

**Nothing about delivery is silent.** Today's welcome emails are best-effort
and their failures are swallowed. An invitation is how a person gets into
their account, so:

- the upload's results table says, per person, "invitation sent to
  r•••@gmail.com" or "not sent: <reason>", with the address masked;
- the people list shows "Invited — not signed in yet", "Invitation expired",
  or "Invitation not delivered";
- the admin can **Resend invitation** (a new token; the old link dies) or
  **Set a password instead** (the typed-password path) for anyone not yet
  signed in;
- an expired or used link says "This invitation has expired. Ask your
  administrator to send a new one." — the person cannot use "forgot
  password", because their recovery email is not yet verified.

**What no longer exists.** The downloadable list of generated passwords goes
away, because nothing is generated for an admin to see. The results list
still names typed passwords as "the one you typed", as today.

**Audit.** `user.invitation_sent` (channel, masked address),
`user.invitation_resent`, `user.invitation_accepted`. Never the token.

## What proves it

API tests against the local stack, whose Mailpit catches the email:

1. A row with a recovery email and a blank password: the account exists with
   no usable password; sign-in with any password is refused; Mailpit holds
   one invitation containing a link with the token in the fragment and no
   password anywhere in the message.
2. Accepting the link with a valid new password: sign-in now works;
   `recovery_email_verified_at` is set; a second accept with the same token
   answers 401.
3. A token accepted after 72 hours: 401, and the expired message.
4. **Resend:** the first link now answers 401; the new one works.
5. A row with no recovery email or phone and a blank password: refused by the
   API with the reason above, even when posted directly without the preview.
6. A row with a typed password: created, must change at first sign-in, and
   Mailpit receives no invitation.
7. Mail delivery failing (SMTP pointed at a dead port): the results row says
   "not sent", and the people list says "Invitation not delivered".
8. In a browser, after the welcome page loads, `location.href` contains no
   token.

Red first: remove the single-use clause from the accept query and watch test
2's second accept succeed; remove the server-side refusal and watch test 5's
direct post create an account with no way in.

## Consequences

Easier: no generated password is ever seen, downloaded or forwarded; a
recovery email becomes verified by the act of joining; the admin can see who
has not got in yet.

Harder: onboarding now depends on email and text delivery. A mistyped
recovery email means the person never receives the invitation — which is why
"not delivered" and "not signed in yet" must be visible and "Set a password
instead" must exist. The bounce pipeline is not yet proven on production, so
for now a silent non-delivery shows up as "not signed in yet" rather than
"not delivered". Phone invitations wait on an SMS template.

Accepted: a person with no recovery details still gets a password from their
admin. That is Amit's rule, and it is honest about where the risk remains.

**Follow-up, not in this record:** the existing reset and recovery-verify
links still carry their tokens in the query string. Moving them to the
fragment is a separate change for the CTO.

## Open for Amit

1. Typed password and recovery info both present: typed password wins, no
   invitation (proposed).
2. Invitation lifetime: 72 hours (proposed).
3. The same rule for adding a single person (proposed).
4. Phone-only people before the SMS template is approved: treated as having
   no recovery info (proposed).

## Revisit when

An organisation signs its people in through its own identity provider, or
through TatvaOS as one (0004) — then some people never need a TatvaOS
password at all. Or when the bounce pipeline can tell an admin that an
invitation email bounced.
