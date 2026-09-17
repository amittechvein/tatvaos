# tests/

| Folder | Purpose |
|---|---|
| `isolation/` | ★ Proves one tenant cannot reach another's data |
| `invitations/` | Decision 0005 end to end against the local stack: invitation link, accept, expiry, resend, refusals, typed password, mail edge down. Needs `local/` up and the API on :5000 |
| `oidc/` | Decision 0004, the OpenID Connect provider, stage by stage against the local stack. `stage1-applications.sh`: stores, resolvers, the Applications API, secret shown once and in no log. Pass `TATVAOS_API_LOG=<the API's stdout>` for the log check |
| `e2e/` | Playwright — full user journeys |
| `load/` | Throughput and latency |

## isolation/ is the important one

**This suite is the tenant-isolation guarantee. The RLS policy is only its implementation.**

Add a case for **every** endpoint you write — authenticate as tenant A and assert an empty result or 404 for every tenant B resource: mailbox, message, attachment, search hit, presigned URL, admin endpoint.

A cross-tenant leak is the one bug this product does not recover from. One incident and the brand is finished. This suite growing alongside the code is what prevents it.

Run it against **real PostgreSQL** (Testcontainers). RLS cannot be tested against an in-memory provider — the policies simply do not exist there, so every test passes and proves nothing.
