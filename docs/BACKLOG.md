# Core backend — backlog

What the Core lane has shipped, what is queued, and why each queued item is where it is.
Mail and UI keep their own lanes; this file is Core's.

Status is verified against the tree, not remembered — anything marked **not started** has
been checked for and genuinely does not exist yet.

---

## Shipped

| Feature | Where |
|---|---|
| Session survives reload (token-rotation FK) | `AppDbContext` self-FK on `replaced_by` |
| Domain verification via authoritative NS | `Modules/Core/DomainVerifier.cs` |
| People: status, roles, password reset by admin, hide deleted | `Modules/Admin/Endpoints/UserEndpoints.cs` |
| Plan CRUD, platform-wide | `Modules/Admin/Endpoints/OrganisationEndpoints.cs` |
| SMS provider selector (Infobip / MSG91) | `Shared/Notify/Notify.cs` |
| Welcome email — create, signup owner, bulk | `Shared/Notify/WelcomeEmail.cs` |
| Profile photos, self-or-admin | `13-user-avatars.sql` |
| Forgot password — email link + phone OTP | `14-password-reset.sql` |
| New-device sign-in alerts | `15-signin-alerts.sql` |

---

## Next up

Ordered by value per unit of effort. Nothing here is started.

### 1. MFA / TOTP enrolment — *small-to-medium*

`users.mfa_enabled` and `mfa_secret_ref` **already exist and are read in three places**, but
there is no enrol, verify or challenge flow anywhere — the columns are decorative today.

This is the single most common enterprise procurement question, and the sign-in alert work
just built the "something is wrong" half of the story; MFA is the "stop it happening" half.

Scope: enrol (QR + secret), verify at sign-in, recovery codes, and an org-level policy to
*require* it. Recovery codes matter as much as the TOTP itself — without them, a lost phone
becomes an admin ticket for every affected person.

### 2. Audit-log viewer — *small*

**29 write sites; zero read endpoints.** The full trail is being captured and there is no way
to look at it, which makes it worthless exactly when it matters.

Scope: a filtered, paged read endpoint plus an org and platform console page. Cheap, because
the hard part (capturing correctly, tamper-resistantly) is already done. Also the first thing
asked for in a DPDP-Act conversation.

### 3. Storage module — *medium*

`apps/web/app/org/storage/page.tsx` is a 13-line placeholder and there are **no storage
endpoints at all**. Plans already carry per-user and pooled quotas, so the data model is
half-built and currently unenforced.

Scope: real usage figures per user and per product, pool headroom, and enforcement when a
quota is hit. Enforcement is the part that turns quotas from decoration into a product.

### 4. Employee offboarding — *medium*

Today, removing someone who has left is several separate actions with no single path, and
missing one leaves access alive.

Scope: one operation that revokes sessions and product access, then either forwards, transfers
or retains the mailbox for a legal window. This is the operation admins dread and that
Workspace handles poorly — doing it cleanly is a genuine differentiator, not just parity.

### 5. Billing — *large*

`Modules/Billing/` contains only a `.gitkeep`; `org/billing/page.tsx` is a 13-line placeholder.
Razorpay credentials are already stored in platform settings.

Scope: checkout, subscription lifecycle, invoices, payment method, dunning. **Build GSTIN and
the tax breakdown into the invoice from day one** — Indian orgs require it, `tenants.gstin` is
already captured, and retrofitting tax onto issued invoices is genuinely painful.

---

## Known debts

- **No API smoke test in CI.** CI never boots the API against a database, which is how three
  production-only bugs shipped (`department_id`, `DkimKeys` schema, token-rotation FK). A job
  that starts API + Postgres and hits a handful of endpoints would have caught all three.
- **`AuthEndpoints.cs` and `Entities.cs` are edited by more than one lane.** Edits have been
  silently reverted mid-session by concurrent writes. Re-verify after any parallel work.
- **Empty scaffolding with no spec:** `Modules/Family/`, `Modules/Search/` — directories and,
  for Family, logo assets, but no code and no handover document.

### Outside the Core lane

- Linode **SMTP-unblock ticket** — until it lands, outbound mail to the public internet does
  not deliver. Reset links and sign-in alerts to external addresses are affected; delivery to
  hosted `@tatvaos.com` mailboxes works today.
- Replace the `tv2026a._domainkey` TXT record once `tatvaos.com` is added.
