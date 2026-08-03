# Contributing

Conventions that keep the repo navigable. Short on purpose.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Folders | lowercase, hyphens | `api-client/` |
| React components | PascalCase | `MessageList.tsx` |
| Hooks | camelCase, `use` prefix | `useMailbox.ts` |
| Other TS files | camelCase | `parseAddress.ts` |
| C# files | PascalCase | `TenantContext.cs` |
| Database tables/columns | snake_case, plural tables | `messages`, `tenant_id` |
| Env variables | SCREAMING_SNAKE | `DATABASE_URL` |

## Branches and commits

```
feat/mailbox-search
fix/imap-uid-drift
docs/runbook-dkim-rotation
```

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## Before you open a PR

- [ ] `tests/isolation/` has a case for any new endpoint — **no exceptions**
- [ ] No secrets committed (check `git diff --staged`)
- [ ] Shared logic went into `packages/core/`, not copy-pasted between apps
- [ ] Postfix/Dovecot changes made in **both** `infra/` and `local/`
- [ ] New env variables added to `.env.example`

## Things that will be rejected

- An endpoint touching tenant data with no isolation test
- Message content in a push notification payload
- Hand-edits to `packages/api-client/` or `packages/types/` (both generated)
- `console.log` left in application code
- A migration that drops a column without a documented rollback

## Adding a dependency

Ask: does this need to exist? Every package is something to patch, audit and eventually migrate off. For anything touching mail parsing, crypto or auth, prefer the boring well-maintained option over the clever new one.
