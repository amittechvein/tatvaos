# Proving 20260924-d-domain-claims.sql

Not yet run. The repo's tool for a single migration against an
already-deployed database is `infra/scripts/verify-one-migration.py`, which
needs the `pgserver` package (it ships its own Postgres, no root, no Docker).
It is not installed on this laptop, and the local dev role cannot create a
scratch schema, so this is written down rather than claimed.

Run it with:

```
pip install --break-system-packages pgserver

python infra/scripts/verify-one-migration.py \
  local/postgres/init/20260924-d-domain-claims.sql \
  --stub    tests/domain-claims/migration/stub.sql \
  --arrange tests/domain-claims/migration/arrange.sql \
  --runs 2 \
  --expect "select count(*)::text from pg_constraint where conname='domains_fqdn_key'=0" \
  --expect "select count(*)::text from pg_indexes where indexname='idx_core_domains_verified_unique'=1" \
  --expect "select count(*)::text from core.domains where fqdn='school.test'=2" \
  --expect "select refused::text from probe where what='second verified row'=true" \
  --calibrate tests/domain-claims/migration/broken.sql
```

- **stub.sql** is core.domains as it stood *before* this migration, with
  `fqdn` unique outright — the rule being replaced.
- **arrange.sql** is the already-deployed state: two organisations holding a
  pending claim on one name (impossible before this migration), a verified
  domain, and a probe recording whether a *second* verified row for one name
  is refused. It must be.
- **broken.sql** is this migration with the `DROP CONSTRAINT` line removed.
  The run must FAIL against it, or the expectations are not measuring
  anything.
