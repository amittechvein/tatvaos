# tests/oidc — the OpenID Connect provider, proven over HTTP

Decision 0004. Three scripts, one per stage, each acting as a real relying
party against an API this folder starts or expects running:

| Script | Proves | Needs |
|---|---|---|
| `stage1-applications.sh` | stores, schema, the Applications console API, RLS on the four tables | an API already on :5000 |
| `stage2-discovery.sh` | keys, rotation, discovery pinned to the issuer under a spoofed host, the key set | starts its own API on :5077 |
| `stage3-flow.sh` | the ten steps of 0004 "What proves it": authorize, consent, code, tokens, userinfo, revocation, cross-tenant refusal, replay, redirect and PKCE mistakes, suspension, nothing secret in the log, RLS | starts its own API on :5078 |

`verify-id-token.js` is the relying party's half of step 1: it verifies an
ID token against the published key set by `kid`, then `iss`, `aud`,
`nonce`, `exp`, `sub` and `tid`. Node imports a JWK natively, so it has no
dependency.

## Running on the laptop without Docker (from 17 Sept 2026)

PostgreSQL 18 runs natively in WSL Ubuntu; Docker Desktop stays off. Stage 3
finds it on its own: it holds one `wsl sleep` open for the run (WSL stops
its VM seconds after the last `wsl` process ends, and Postgres with it),
reads the VM's address with `wsl hostname -I`, and points the API at it
through `ConnectionStrings__Postgres`. psql runs as `wsl -u postgres`.

```bash
dotnet build apps/api/TatvaOS.Api.csproj -c Release
bash tests/oidc/stage3-flow.sh
```

The schema is the same `local/postgres/init/*.sql`, applied in C-locale
order into a database named `tatvaos_mail` (only the `.sql` files: the
directory holds a README). The seed gives nobody a phone; the script sets
them in its step 0. (Until 17 Sept 2026 the seed also gave the owner the
role `owner` where the OrgAdmin policy wants `org_owner`; production carries
no `owner` rows, so the seed was corrected rather than a migration written.)

Elsewhere — a Docker `tv-postgres`, or CI — set `TATVAOS_PSQL`,
`TATVAOS_PSQL_APP` and `TATVAOS_PG_HOST` to match. All three scripts take
them; stage 1 also needs an API already listening (`TATVAOS_API`, default
:5000) and reads its log through `TATVAOS_API_LOG`.

## In CI (from 17 Sept 2026)

The `Verification scripts` job in `.github/workflows/ci.yml` runs all three
stages and the Connect picture-in-picture check on every push, against a
Postgres service with the same init SQL applied — the same scripts as
here, only the connection details differ. A red there names which script.

## The two red-first runs (0004)

Both were done on 17 Sept 2026 by patching the source, rebuilding, running,
restoring — never by a switch in the shipped code:

- **A debug line printing the code** at the token endpoint: step 9 found it
  three times (one per code exchanged). The check that would have missed it
  is a check that greps for nothing.
- **Userinfo without its liveness check**: the first version of step 8 still
  passed, because refresh-token reuse detection had already revoked the very
  token it then presented — a 401 with nothing to do with liveness. Step 8
  now takes a fresh authorization after the reuse check and before the
  suspension, and the same patched build fails it.

The unpatched build passes all steps. On the first unpatched run, step 9
itself found OpenIddict's dispatcher logging PKCE verifiers in the clear at
Information level; `appsettings.json` now holds OpenIddict at Warning.
