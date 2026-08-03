# Architecture Decision Records

One file per decision: `NNNN-short-title.md`

## Template

```markdown
# NNNN — Title

**Status:** proposed | accepted | superseded by NNNN
**Date:** YYYY-MM-DD

## Context
What is the situation? What forces are at play?

## Options
1. Option A — pros, cons
2. Option B — pros, cons

## Decision
What we chose.

## Consequences
What becomes easier. What becomes harder. What we accept.

## Revisit when
The specific condition that should make us reopen this.
```

## Decisions already made (write these up)

- Shared-schema multi-tenancy with RLS, not database-per-tenant
- Postfix + Dovecot rather than writing our own MTA
- React Native + Expo rather than Flutter, MAUI or native
- Modular monolith rather than microservices
- Relay-first outbound rather than own IPs at launch
- Postgres FTS at v1, OpenSearch deferred
- Postgres `SKIP LOCKED` queue rather than RabbitMQ at v1
