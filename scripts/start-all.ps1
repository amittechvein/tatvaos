<#
.SYNOPSIS
    Start everything: mail stack, database schema, API, web app.

.DESCRIPTION
    One command to go from a fresh reboot to a working system.

    Docker containers survive a terminal closing - they are a service. The API
    and the web app do not; each needs a live process, so this opens a window
    for each and leaves them running.

.PARAMETER SkipWeb
    Do not start the Next.js dev server.

.PARAMETER SkipApi
    Do not start the .NET API.

.EXAMPLE
    .\scripts\start-all.ps1
    .\scripts\start-all.ps1 -SkipWeb
#>

[CmdletBinding()]
param(
    [switch]$SkipWeb,
    [switch]$SkipApi
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent

function Step { param($m) Write-Host "`n>> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "   [ ok ] $m" -ForegroundColor Green }
function Bad  { param($m) Write-Host "   [FAIL] $m" -ForegroundColor Red }
function Note { param($m) Write-Host "   $m" -ForegroundColor DarkGray }

Write-Host "`n  TatvaOS Mail - starting everything`n" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
Step '1/5  Docker'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Bad 'Docker CLI not found'
    exit 1
}

docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Note 'Docker daemon not responding - starting Docker Desktop...'
    $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dd) {
        Start-Process $dd
        Note 'Waiting for the engine (up to 90 seconds)...'
        for ($i = 0; $i -lt 45; $i++) {
            Start-Sleep -Seconds 2
            docker info 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
        }
    }
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Bad 'Docker still not ready. Start Docker Desktop manually and re-run.'
        exit 1
    }
}
Ok 'Docker engine ready'

# ---------------------------------------------------------------------------
Step '2/5  Mail stack'

Push-Location "$Root\local"
docker compose --profile testers up -d 2>&1 | Where-Object { $_ -match 'Error|error' } | ForEach-Object { Note $_ }
docker compose --profile testers up -d 2>&1 | Out-Null

# Containers can report 'running' a moment before they are usable, and a
# crash-looping container passes through 'running' on its way round the loop.
# Require the state to hold rather than trusting one sample.
$settled = 0
for ($i = 0; $i -lt 30; $i++) {
    $pg = docker inspect -f '{{.State.Health.Status}}' tv-postgres 2>$null
    $pf = docker inspect -f '{{.State.Status}}' tv-postfix 2>$null
    $dc = docker inspect -f '{{.State.Status}}' tv-dovecot 2>$null
    if ($pg -eq 'healthy' -and $pf -eq 'running' -and $dc -eq 'running') {
        $settled++
        if ($settled -ge 3) { break }
    } else { $settled = 0 }
    Start-Sleep -Seconds 2
}

if ($settled -ge 3) {
    Ok 'postgres healthy, postfix and dovecot stable'
} else {
    Bad "services did not stabilise (postgres=$pg postfix=$pf dovecot=$dc)"
    Note 'Diagnose:  wsl -d Ubuntu bash ./scripts/diagnose.sh'
}

# ---------------------------------------------------------------------------
Step '3/5  Database schema'

# postgres/init/*.sql only runs on an EMPTY volume, so an existing database
# never sees new migrations. Applying them by hand every start is cheap
# because each script is idempotent.
wsl -d Ubuntu bash ./scripts/apply-schema.sh 2>&1 |
    Where-Object { $_ -match 'applied|FAILED|NOTICE|ERROR' } |
    ForEach-Object { Note $_.Trim() }
Pop-Location

# ---------------------------------------------------------------------------
Step '4/5  API'

if ($SkipApi) {
    Note 'skipped'
} else {
    # The signing key lives in the environment, not in a committed file. It is
    # lost when a terminal closes, which is why it is set here rather than
    # expected to persist - and why there is deliberately no default in
    # Program.cs that could ship to production.
    $apiCmd = @"
`$env:JWT_SIGNING_KEY = 'dev-only-key-at-least-32-characters-long'
Set-Location '$Root\apps\api'
Write-Host 'TatvaOS API - http://localhost:5000' -ForegroundColor Cyan
dotnet run
"@
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $apiCmd
    Ok 'API starting in a new window'
    Note 'http://localhost:5000/health'
}

# ---------------------------------------------------------------------------
Step '5/5  Web app'

if ($SkipWeb) {
    Note 'skipped'
} elseif (-not (Test-Path "$Root\node_modules")) {
    Note 'Dependencies not installed yet. Run once:  pnpm install'
} else {
    $webCmd = @"
Set-Location '$Root'
Write-Host 'TatvaOS Web - http://localhost:3000' -ForegroundColor Cyan
pnpm web
"@
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $webCmd
    Ok 'Web app starting in a new window'
}

# ---------------------------------------------------------------------------
Write-Host "`n$('-' * 62)" -ForegroundColor Cyan
Write-Host @'
  Everything is up. Give the API and web windows ~15 seconds.

    Web client       http://localhost:3000
    Super admin      http://localhost:3000/admin
    Org admin        http://localhost:3000/org
    Tester webmail   http://localhost:8000
    Caught mail      http://localhost:8025
    API health       http://localhost:5000/health

  Verify the mail stack:
    cd local
    wsl -d Ubuntu bash ./scripts/up.sh

  Stop everything:
    cd local ; docker compose down
    (close the API and web windows)

'@ -ForegroundColor Gray
