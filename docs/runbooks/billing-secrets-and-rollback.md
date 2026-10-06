# Billing: encrypted secrets, the rollback floor, refunds

Written 26 September 2026 from Mr. Singh's approval of PRs 320 and 322.
Read this before rolling back, before rotating `JWT_SIGNING_KEY`, and before
the first refund.

## What is encrypted, and with what

Secret platform settings — the Razorpay key secret and webhook secret, the
Infobip and MSG91 passwords, the Google client secret — are stored in
`core.platform_settings` encrypted with AES-GCM (`SettingsCrypto`). Saving a
secret from the Settings page **always** encrypts it. The settings API never
returns a secret; it says only whether one is set.

The key is derived from, in this order: `Settings__EncryptionKey`,
`Mfa__EncryptionKey`, `Jwt__SigningKey` (`JWT_SIGNING_KEY` in `.env`). On
production today that is **`JWT_SIGNING_KEY` in `infra/docker/.env`**, under a
label that makes it a different key from the one protecting TOTP secrets.

**If that key is ever lost or rotated, every stored secret becomes
unreadable.** Nothing breaks loudly: SMS OTP sends fail, Razorpay calls fail
with "keys missing". The fix is to type every secret in again on the Settings
page. Rotate the key only with the secrets to hand.

`.env` is in the backup set, and the backup is encrypted with the paper
passphrase. So encryption at rest protects against a leaked database dump or a
query that reads the settings table. It does **not** protect against someone
holding a whole decrypted backup, which contains both the table and the key.
That is acceptable because the backup passphrase is the control there — see
[backup-and-restore.md](backup-and-restore.md).

## Secrets saved before 26 September 2026

They are still in plain text until the operator presses **Encrypt stored
secrets** on the Settings page (the amber notice at the top; it disappears
when nothing is left in plain text). Sealing is a button, not a start-up step,
on purpose: an older build cannot read an encrypted value.

### Pressing it is a one-way door for rollbacks

Once stored secrets are encrypted — by the button, or by saving any secret
after this version is live — **the oldest safe rollback is the version that
carries `SettingsCrypto` (PR 322) or later.** Rolling back past it brings up an
API that reads `enc:v1:…` as "not set": SMS sign-in stops and Razorpay stops.

So:

1. Deploy 320 + 322 together, confirm the deploy good, **then** press the button.
2. Every deploy report after that names the rollback floor: *"do not roll
   back below `<the 322 deploy's commit>`; stored secrets are encrypted."*
3. If a rollback below the floor is unavoidable, be ready to re-enter the
   SMS and Razorpay secrets on the old version's Settings page immediately
   after.

## Payment-problem alerts

A Razorpay payment that TatvaOS did not record as paid — a different amount
(REVIEW), money for a voided invoice (REFUND NEEDED), a link no invoice has
(unmatched) — is emailed to every active super admin **from
`alerts@tatvaos.com`** and stays under **Payment problems** on the platform
dashboard until acknowledged. Amit's mail filter must keep `alerts@tatvaos.com`
out of Spam; that filter is the only reason the address is what it is.

If the mail server refuses that sender, the alert is still on the dashboard
and in `core.razorpay_events` (`alerted_at` stays null, and the API log has an
error). Check the dashboard first when a customer says they paid.

## Refunds — a known gap

A paid invoice cannot be voided; the database refuses it. That is correct:
under GST a paid invoice is corrected with a **credit note**, not by erasing
the invoice. Nothing issues credit notes yet. When the first refund is needed
(a REFUND NEEDED alert, or a customer overcharged), that is what gets built:
a credit note referencing the invoice, and the refund itself done in the
Razorpay dashboard. Until then, refund in Razorpay by hand and keep the
credit-note paperwork outside TatvaOS.
