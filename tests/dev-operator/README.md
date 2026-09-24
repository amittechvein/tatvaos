# tests/dev-operator — the development-only operator sign-in

Mr. Singh's ruling, 24 Sept 2026: the platform operator console
(`apps/web/app/admin/organisations`) must be verifiable in a local browser
without anyone typing the operator's password for an agent. Two
operator-facing controls (the Docs and Sheets per-organisation switches)
shipped unseen because nobody could reach that console locally.

The code: `apps/api/Modules/Auth/Endpoints/DevOperatorSignIn.cs` (the
endpoint, and why) and `DevOperatorGate.cs` (every decision about whether it
may exist or answer, in one place).

## The gates, and which ones hold alone

Mr. Singh approved PR 281 on 25 Sept 2026 with four conditions. The fourth
was to stop overstating the gates. **Three are each sufficient alone**,
because they depend only on the process's own environment and code:

1. the API refuses to boot with the switch on outside Development;
2. the route is mapped only in Development **with** the switch (CI runs as
   Development and has no route);
3. the handler asks again.

**Two are defence in depth, not sufficient alone**, because both depend on
network topology:

4. the caller's connection address must be loopback, and forwarded headers
   are never believed. Put Caddy and the API on the host network, though,
   and Caddy's requests *are* loopback;
5. the database host must resolve entirely to loopback. **Deliberately no
   private ranges:** production's database is `postgres` on the compose
   network, a private address, so a private-range rule would pass in
   production and protect nothing.

On production, `verify-live.sh` asks for the route on every deploy and
requires **exactly 404** on GET and POST. A 405 means the route is mapped,
and counts as a failure. Production is the only environment that script
verifies.

*Correction to the 25 Sept ruling as first written, confirmed by Mr. Singh
the same day:* its closing line called the `verify-live` check "condition
four's". Condition four is the wording above. The `verify-live` check was
his yes to a separate question.

## Using it on your own machine

1. In the API's launcher (e.g. `.tmp/run-api.cmd`), **never** in an
   `appsettings*.json` file (CI runs as Development and reads
   `appsettings.Development.json`):

   ```
   set ASPNETCORE_ENVIRONMENT=Development
   set DevOperatorSignIn__Enabled=true
   set ConnectionStrings__Postgres=Host=localhost;Port=5432;Database=tatvaos_mail;...
   ```

   **`Host=localhost`, not the WSL address.** Gate 5 refuses a database that
   is not on loopback, and the WSL address is a private one. WSL forwards
   `localhost` to its Postgres (`localhostForwarding=true`), but only while
   the WSL VM is running, so keep the launcher's `start /b wsl -e sleep 7200`
   line.

   The API logs `DEVELOPMENT ONLY: /api/dev/operator-session is mapped` at
   start. If that line is missing, the route is not there.

2. With the web app open in the browser at its own origin, run once in the
   page (the browser pane's JavaScript tool, or the devtools console):

   ```js
   await fetch('http://localhost:<api port>/api/dev/operator-session',
               { method: 'POST', credentials: 'include' }).then(r => r.status)
   ```

   `200`, then navigate to `/admin/organisations`. A `409` names the reason
   (usually a database host that is not loopback). The session is an
   ordinary one: it signs in `dev-operator@tatvaos.test`, a super_admin with
   no password and no phone, created on first use in the oldest
   organisation. It is never the bootstrap operator and is never asked to
   change a password.

The caller must be on the same machine (loopback). A local Docker stack
behind Caddy does not qualify, by design: production looks exactly like that.

## The checks

| | What it proves | Run | CI |
|---|---|---|---|
| `gates/` | Every answer of `DevOperatorGate.cs`, compiled from the production file: boot refusal (including a non-boolean switch value); closed in Development without the switch; production's own caller address refused; **a forwarded header claiming loopback, on Caddy's connection, refused**; **production's database host (`postgres` → 172.18.x), the WSL address and every private or multi-host form refused, while both `127.0.0.1` and `::1` pass** | `dotnet run --project tests/dev-operator/gates`, last line `PASS n` | Backend |
| `check-signin-tail.sh` | `CompleteSignInAsync` (the tail every sign-in shares, `internal` since PR 281) is referenced only from the known sign-in paths, listed by file and method with a reason each. It also fails if it cannot find every listed path, so a search that saw nothing cannot pass | `bash tests/dev-operator/check-signin-tail.sh` | Backend |
| `test.sh` | The built API, six configurations. Production and Staging with the switch on refuse to start **for that reason**. Production and Development with it off start with the route unmapped (GET 404, not 405). Development with it on issues a real operator session that opens `/api/admin/organisations`, is not forced into a reset, and is audited; a loopback caller claiming a remote address in forwarded headers is still served (no header moves the address gate 4 reads). The same database reached by a non-loopback address is refused (409), with no session and no audit row | `bash tests/dev-operator/test.sh`, which needs a Release build and local Postgres | Verification |

Not exercised: a real remote socket against gate 4. That needs the API
listening on a LAN address, which raises a Windows Firewall prompt.
`gates/` covers the decision; the one wiring line
(`IsLocalCaller(http)` → `http.Connection.RemoteIpAddress`) is now inside
the gate file and exercised by `gates/` too. Accepted by Mr. Singh on 25 Sept.

## Calibration

Each gate and each check was broken on purpose, and the checks were run
against the break. The table of results (which break, which lines went red,
and why that was the right reason) is in the PR 281 description.
