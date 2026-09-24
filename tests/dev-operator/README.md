# tests/dev-operator — the development-only operator sign-in

Mr. Singh's ruling, 24 Sept 2026: the platform operator console
(`apps/web/app/admin/organisations`) must be verifiable in a local browser
without anyone typing the operator's password for an agent. Two
operator-facing controls (the Docs and Sheets per-organisation switches)
shipped unseen because nobody could reach that console locally.

The code: `apps/api/Modules/Auth/Endpoints/DevOperatorSignIn.cs` (the
endpoint, and why) and `DevOperatorGate.cs` (every decision about whether it
may exist, in one place).

## Using it on your own machine

1. Add to the API's launcher (e.g. `.tmp/run-api.cmd`) — **never** to an
   `appsettings*.json` file, because CI runs as Development and reads
   `appsettings.Development.json`:

   ```
   set ASPNETCORE_ENVIRONMENT=Development
   set DevOperatorSignIn__Enabled=true
   ```

   The API logs `DEVELOPMENT ONLY: /api/dev/operator-session is mapped` at
   start. If that line is missing, the route is not there.

2. With the web app open in the browser at its own origin, run once in the
   page (the browser pane's JavaScript tool, or the devtools console):

   ```js
   await fetch('http://localhost:<api port>/api/dev/operator-session',
               { method: 'POST', credentials: 'include' }).then(r => r.status)
   ```

   `200`, then navigate to `/admin/organisations`. The session is an
   ordinary one: it signs in `dev-operator@tatvaos.test`, a super_admin with
   no password and no phone, created on first use in the oldest
   organisation. It is never the bootstrap operator and is never asked to
   change a password.

The caller must be on the same machine (loopback). A local Docker stack
behind Caddy does not qualify, by design — production looks exactly like that.

## The two checks

| | What it proves | Run |
|---|---|---|
| `gates/` | Every answer of `DevOperatorGate.cs`, compiled from the production file: refuses to start outside Development with the switch on (including a non-boolean value); closed in Development without the switch (CI's case); refuses production's own caller address `::ffff:172.18.0.2` | `dotnet run --project tests/dev-operator/gates` — last line `PASS n` |
| `test.sh` | The built API, five runs: Production and Staging with the switch on refuse to start **for that reason**; Production and Development with it off start and the route is not mapped (GET 404, not 405); Development with it on issues a real operator session that opens `/api/admin/organisations`, is not forced into a reset, and is audited | `bash tests/dev-operator/test.sh` — needs a Release build and local Postgres |

`test.sh` does not exercise the loopback gate: that needs the API listening
on a LAN address, which raises a Windows Firewall prompt. `gates/` covers
that decision directly.

Neither is in CI: a workflow change goes to the CTO.

## Calibration

Each gate was broken in the production file and the checks were run
against the break. See the pull request for the table of results: which
break, which lines went red, and why that was the right reason.
