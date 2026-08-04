# TatvaOS — Product Structure

**Read this before anything else.** It explains what the products are and where the boundaries sit. Every other document assumes it.

---

## Two things, not one

```
┌─────────────────────────────────────────────────────────────┐
│  TATVAOS CORE — the platform                                │
│                                                             │
│  Super admin console          Client admin console          │
│  (Techvein onboards           (like admin.google.com —      │
│   customers)                   customers manage themselves) │
│                                                             │
│  Owns:  tenants · domains · USERS · categories              │
│         plans · billing · storage pools · audit             │
└───────────────┬─────────────────────────────────────────────┘
                │  every product plugs in here
     ┌──────────┼──────────┬──────────┬──────────┬───────────┐
     ▼          ▼          ▼          ▼          ▼           ▼
  ┌──────┐  ┌──────┐  ┌────────┐ ┌────────┐ ┌───────┐  ┌────────┐
  │ MAIL │  │DRIVE │  │ PEOPLE │ │PAYROLL │ │ SHEET │  │  WORD  │
  │ live │  │      │  │        │ │        │ │       │  │        │
  └──────┘  └──────┘  └────────┘ └────────┘ └───────┘  └────────┘
```

**TatvaOS Core** is not the admin section of Mail. It is the layer every product plugs into — the equivalent of Google Workspace admin, with Gmail, Drive and Docs sitting on top.

**TatvaOS Mail** is the first product. Send and receive mail, like Gmail.

---

## The decision that makes the rest cheap

**A person exists once, in Core.**

```
core.users
  id · tenant_id · email · password_hash · mfa · role · status
      │
      ├── mail.mailboxes      (user_id)   a store that receives mail
      ├── drive.accounts      (user_id)   a file store
      ├── people.employees    (user_id)   an HR record
      └── payroll.records     (user_id)   salary and compliance
```

What this buys, concretely:

| | |
|---|---|
| **One sign-on** | Sign in once, reach Mail, Drive, Payroll |
| **One password reset** | Not six |
| **One suspend** | An employee leaves; one action removes every product at once |
| **Cheap new products** | Adding Drive is a schema and a row in `core.products` — not a change to how tenants or users work |

The alternative — each product owning its own users — is simpler today and expensive on the day someone leaves. Six places to revoke, and the one you forget is the one that matters.

### Users and mailboxes are not the same thing

Worth stating because conflating them is the natural mistake:

| `core.users` | `mail.mailboxes` |
|---|---|
| A person who can sign in | A store that receives mail |
| Has a password and MFA | Has a quota and an address |
| Exists for a Payroll-only employee | Exists for `support@` with no person behind it |

Three real cases need them separate:

- **Shared mailboxes.** `support@` receives mail; nobody signs in as it.
- **Departed employees.** Suspend the user, retain the mailbox for the legal window.
- **Payroll-only staff.** A factory worker needs a payslip and no email account.

---

## Storage — one pool, split by the customer

The customer buys **one number**. Their admin decides the split.

```
ABC School buys 2 TB
        │
        ├── Mail    1.5 TB   ████████████████░░░░
        ├── Drive   0.4 TB   ████░░░░░░░░░░░░░░░░
        └── People  0.1 TB   █░░░░░░░░░░░░░░░░░░░
                             rebalance any time
```

`core.storage_pools` holds the total; `core.storage_allocations` holds the per-product split.

**Why not one free-for-all pool:** Mail fills it and Drive silently stops working, with no warning the admin could have acted on.

**Why not separate purchases:** the customer has to guess the split before they have used the product, and will guess wrong.

An allocation of `NULL` means "draw from whatever is left" — useful for products a customer does not want to think about.

---

## Where the code lives

```
apps/
├── api/                    ONE deployable — modular monolith
│   └── Modules/
│       ├── Core/           tenancy, identity, billing, storage
│       └── Mail/           mailboxes, messages, delivery
│                           (Drive/, People/ … added the same way)
│
└── web/
    └── app/
        ├── mail/           TatvaOS Mail — the Gmail-like client
        ├── admin/          Core — super admin (Techvein)
        └── org/            Core — client admin (customers)
```

Database schemas mirror it:

| Schema | Owns |
|---|---|
| `core` | tenants, domains, users, categories, plans, billing, storage, audit |
| `mail` | mailboxes, aliases, folders, messages, attachments |
| `drive`, `people`, `payroll`, `sheet`, `word` | added later, same pattern |

Postgres schemas rather than table prefixes because grants are per-schema — a compromised product cannot read another's tables even by accident.

---

## Adding the second product

The test of whether Core was built right. Adding Drive should be:

1. A row in `core.products`
2. A `drive` schema with tables keyed on `core.users.id`
3. A `Modules/Drive/` in the API
4. A `drive` allocation in `core.storage_allocations`
5. `apps/web/app/drive/`

**Nothing in Core changes.** No new user table, no second login, no separate billing. If adding Drive requires touching how tenants or users work, Core was built wrong and it is worth stopping to fix.

---

## Tenant isolation, unchanged

The property the whole platform exists to provide, now spanning products:

| | Tables | RLS | Mail edge access |
|---|---|---|---|
| **Routing** | `core.tenants`, `core.domains`, `core.users`, `mail.mailboxes` | No | `SELECT` |
| **Content** | `mail.messages`, `core.audit_logs`, `core.subscriptions` | Enabled **and forced** | **None** |

Routing data carries no RLS because the MTA must resolve a recipient before any tenant is known — an inbound SMTP connection arrives with no context. Content is RLS-forced and out of the mail edge's reach entirely.

A compromised mail edge leaks the address list, not the mail, not the billing, not the HR records. As products are added, that boundary matters more, not less: `payroll.records` must be as unreachable from Postfix as `mail.messages` is.

---

## What this changes about the plan

The delivery plan stands. Phase 1 builds Core and Mail together, because Mail is unusable without tenants and users — but the boundary is now explicit, so Phase 6's "differentiation" work becomes a sequence of products rather than features bolted onto a mail app.

**One thing worth saying plainly:** this is a Google Workspace competitor, not an email product. That is a considerably larger undertaking, and the reason to build Core properly now is that the second product is where the ambition either becomes cheap or becomes impossible. Mail alone would not have justified this structure. Six products do.
