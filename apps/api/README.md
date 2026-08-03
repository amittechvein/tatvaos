# apps/api — ASP.NET Core (.NET 10 LTS)

A **modular monolith**, not microservices. One deployable with clean internal boundaries.

## Layout

| Folder | Contents |
|---|---|
| `Modules/Tenancy/` | Organisations, domains, users, RLS plumbing |
| `Modules/Mail/` | Messages, folders, sync API, delivery |
| `Modules/Admin/` | Org admin and super-admin |
| `Modules/Billing/` | Plans, seats, invoices |
| `Modules/Search/` | Full-text search |
| `Workers/` | Background jobs — delivery, sync, push dispatch |
| `Shared/` | `TenantContext`, RLS plumbing, cross-cutting concerns |
| `Migrations/` | EF Core migrations |

## Why a monolith

Microservices at this team size means all the operational cost and none of the team-autonomy benefit. Module boundaries stay clean so extraction remains possible — extract only when a component genuinely needs independent scaling.

Two things already run outside the monolith because they scale and fail differently: the **mail edge** (Postfix/Dovecot/Rspamd on hosts with static IPs) and the **workers**.

## The rule that matters most

Every database connection sets `app.tenant_id` before any query. No code path may construct a `DbContext` without a resolved `TenantContext`. RLS is the enforcement; this is the mechanism.
