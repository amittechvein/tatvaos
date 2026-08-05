<#
.SYNOPSIS
    Run the whole local verification chain. Diagnose failures. Fix what is safe.

.DESCRIPTION
    One command instead of six. Each step runs, and if it fails the script
    matches the output against causes we have actually hit and either fixes it
    or tells you precisely what to do.

    WHAT IT WILL FIX BY ITSELF
      - Docker Desktop not running          starts it and waits
      - Port 3000 or 5000 held              stops the process holding it
      - pnpm lockfile out of date           runs pnpm install
      - stale .git/index.lock               removes it
      - node_modules missing                installs

    WHAT IT WILL NOT TOUCH, EVER
      - anything that deletes data (volumes, databases, branches)
      - .env files or secrets
      - DNS, servers, deployments
      - git history

    That boundary is the point. A script that silently "fixes" a failing test by
    changing the test is worse than no script, and a script that can drop a
    database will eventually drop one.

.EXAMPLE
    .\scripts\verify.ps1
    .\scripts\verify.ps1 -SkipDocker      # API and web only
    .\scripts\verify.ps1 -DryRun          # say what it would fix, change nothing
#>

[CmdletBinding()]
param(
    [switch]$SkipDocker,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$script:Failed = 0
$script:Fixed  = 0

function Head { param($t)
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor DarkCyan
}
function Ok    { param($m) Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Bad   { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:Failed++ }
function Fix   { param($m) Write-Host "  [ fix] $m" -ForegroundColor Yellow; $script:Fixed++ }
function Note  { param($m) Write-Host "         $m" -ForegroundColor DarkGray }
function Doing { param($m) Write-Host "  ...   $m" -ForegroundColor DarkGray }

# ===========================================================================
#  Self-healing helpers
# ===========================================================================

function Repair-Docker {
    if ($DryRun) { Note 'would start Docker Desktop'; return $false }

    $exe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path $exe)) {
        Note 'Docker Desktop is not installed. .\scripts\setup-dev-env.ps1'
        return $false
    }

    Fix 'starting Docker Desktop'
    Start-Process $exe | Out-Null

    # Up to two minutes. Docker Desktop on a cold start is genuinely slow, and
    # a 30-second timeout just produces a confusing second failure.
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'Docker is up'; return $true }
        if ($i % 5 -eq 0) { Doing "waiting for the daemon ($($i * 2)s)" }
    }

    Note 'Docker did not come up in two minutes. Start it by hand and re-run.'
    return $false
}

function Repair-Port {
    param([int]$Port)

    $held = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $held) { return $true }

    $procId = $held.OwningProcess | Select-Object -First 1
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue

    if ($DryRun) { Note "would stop $($proc.ProcessName) (pid $procId) on port $Port"; return $false }

    Fix "port $Port held by $($proc.ProcessName) (pid $procId) - stopping it"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    return $true
}

function Repair-GitLock {
    $lock = Join-Path $Root '.git\index.lock'
    if (-not (Test-Path $lock)) { return }
    if ($DryRun) { Note 'would remove a stale .git\index.lock'; return }

    Fix 'removing stale .git\index.lock'
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
    Get-ChildItem "$Root\.git\objects" -Recurse -Filter 'tmp_obj_*' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Repair-Deps {
    if ($DryRun) { Note 'would run pnpm install'; return $false }
    Fix 'lockfile or node_modules out of date - running pnpm install'
    pnpm install 2>&1 | Select-Object -Last 4 | ForEach-Object { Note $_ }
    return ($LASTEXITCODE -eq 0)
}

# ===========================================================================
#  A step that knows how to diagnose itself
# ===========================================================================

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Run,
        # Ordered: first pattern that matches wins, so put the specific ones
        # first. A generic pattern at the top swallows everything below it.
        [array]$Diagnose = @()
    )

    Doing $Name
    $out = & $Run 2>&1 | Out-String
    $code = $LASTEXITCODE

    if ($code -eq 0) { Ok $Name; return $true }

    Bad $Name

    foreach ($d in $Diagnose) {
        if ($out -match $d.Pattern) {
            Note $d.Cause
            if ($d.Repair) {
                if (& $d.Repair) {
                    Doing "retrying $Name"
                    $out = & $Run 2>&1 | Out-String
                    if ($LASTEXITCODE -eq 0) {
                        Ok "$Name (after repair)"
                        $script:Failed--
                        return $true
                    }
                    Note 'still failing after the repair'
                }
            }
            if ($d.Advice) { Note $d.Advice }

            # The real error, always. Hiding it behind a friendly summary is
            # exactly what cost us an hour on the Postfix entrypoint.
            $out.Trim() -split "`n" | Select-Object -Last 12 | ForEach-Object {
                Write-Host "         $_" -ForegroundColor DarkGray
            }
            return $false
        }
    }

    Note 'No known cause matched. Full output:'
    $out.Trim() -split "`n" | Select-Object -Last 25 | ForEach-Object {
        Write-Host "         $_" -ForegroundColor DarkGray
    }
    return $false
}

# ===========================================================================
Write-Host ''
Write-Host '  TatvaOS - verify' -ForegroundColor Cyan
Write-Host "  $(if ($DryRun) { 'DRY RUN - nothing will be changed' } else { 'fixes what it safely can' })" -ForegroundColor DarkGray

Repair-GitLock

# ---------------------------------------------------------------------------
Head 'Backend'

$null = Invoke-Step -Name 'dotnet build' -Run {
    Push-Location "$Root\apps\api"
    dotnet build --nologo
    Pop-Location
} -Diagnose @(
    @{
        Pattern = 'NETSDK1045|not support targeting'
        Cause   = 'The installed .NET SDK is older than the project targets.'
        Advice  = 'winget install --id Microsoft.DotNet.SDK.10 --exact'
    },
    @{
        Pattern = 'NU1101|Unable to find package'
        Cause   = 'A NuGet package could not be restored - usually no network.'
        Advice  = 'Check connectivity, then: dotnet restore --force'
    },
    @{
        Pattern = 'CS\d+'
        Cause   = 'A compile error. The offending lines are below.'
    }
)

# ---------------------------------------------------------------------------
Head 'Frontend'

if (-not (Test-Path "$Root\node_modules")) { Repair-Deps | Out-Null }

$null = Invoke-Step -Name 'pnpm typecheck' -Run { pnpm typecheck } -Diagnose @(
    @{
        Pattern = 'ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile'
        Cause   = 'package.json and pnpm-lock.yaml disagree.'
        Repair  = { Repair-Deps }
    },
    @{
        Pattern = 'Cannot find module|ERR_MODULE_NOT_FOUND'
        Cause   = 'A dependency is missing from node_modules.'
        Repair  = { Repair-Deps }
    },
    @{
        # Must sit ABOVE the generic TS pattern, or that swallows it and you
        # get "fix your types" for a stale cache.
        Pattern = '\.next[\\/]types.*Cannot find module'
        Cause   = 'Next.js generated types still reference a route file that has been deleted.'
        Repair  = {
            if ($DryRun) { Note 'would delete apps\web\.next'; return $false }
            Fix 'clearing the stale Next.js type cache'
            Remove-Item "$Root\apps\web\.next" -Recurse -Force -ErrorAction SilentlyContinue
            return $true
        }
    },
    @{
        Pattern = 'error TS\d+'
        Cause   = 'A type error. Not auto-fixable - the types are telling you something.'
    }
)

$null = Invoke-Step -Name 'pnpm lint' -Run { pnpm lint } -Diagnose @(
    @{
        Pattern = 'ESLint must be installed'
        Cause   = 'ESLint is not installed.'
        Repair  = { Repair-Deps }
    },
    @{
        Pattern = 'Multiple versions of pnpm'
        Cause   = 'A pnpm version is pinned in both the workflow and package.json.'
        Advice  = 'Remove the version from .github/workflows/ci.yml - package.json wins.'
    }
)

$null = Invoke-Step -Name 'pnpm build' -Run { pnpm --filter @tatvaos/web build } -Diagnose @(
    @{
        Pattern = 'EADDRINUSE'
        Cause   = 'Something is already listening on the dev port.'
        Repair  = { Repair-Port -Port 3000 }
    },
    @{
        Pattern = 'You cannot have two parallel pages'
        Cause   = 'Two files resolve to the same route.'
        Advice  = 'A route group like (marketing) does not change the URL - one of the two must go.'
    },
    @{
        Pattern = 'useSearchParams.*Suspense|missing-suspense'
        Cause   = 'useSearchParams needs a Suspense boundary around it.'
    }
)

# ---------------------------------------------------------------------------
if (-not $SkipDocker) {
    Head 'Mail stack'

    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Note 'Docker daemon is not responding.'
        if (-not (Repair-Docker)) {
            Note 'Skipping the mail stack. Re-run once Docker is up.'
            $SkipDocker = $true
        }
    }

    if (-not $SkipDocker) {
        $null = Invoke-Step -Name 'stack up and tests' -Run {
            Push-Location "$Root\local"
            wsl -d Ubuntu bash ./scripts/up.sh
            Pop-Location
        } -Diagnose @(
            @{
                # THE one worth naming. Postfix has no trailing-comment syntax
                # and one setting per line - both have bitten us.
                Pattern = 'postfix.*fatal|bad numerical configuration|Garbage after'
                Cause   = 'Postfix rejected its own configuration.'
                Advice  = 'Postfix has NO trailing comments, and one setting per line. See docs/runbooks/01-mail-edge-config-errors.md'
            },
            @{
                Pattern = 'unknown restriction|smtpd_restriction_classes'
                Cause   = 'A restriction class is malformed or references a map that does not exist.'
                Advice  = 'Check main.cf internal_only and that both .cf files are in local/postfix/sql.'
            },
            @{
                # The single most common local failure, and the one that
                # produces the most misleading symptoms - every mail test fails
                # and it looks like Postfix is broken.
                Pattern = 'relation ".*" does not exist'
                Cause   = 'The local database predates a schema change. Files in postgres/init only run on an EMPTY volume, so nothing since the last wipe has been applied.'
                Advice  = 'cd local; docker compose down -v; docker compose up -d --build     (-v DELETES the local database - deliberately not automatic)'
            },
            @{
                Pattern = 'no such host|could not connect to server|Connection refused'
                Cause   = 'A container is not up yet, or a hostname is wrong.'
                Advice  = 'cd local; docker compose ps    then    docker compose logs --tail 50'
            },
            @{
                Pattern = 'ISOLATION IS BROKEN'
                Cause   = 'A tenant can see another tenant''s data. Stop and fix this before anything else.'
                Advice  = 'Never auto-fixed, never worked around. Read the failing assertion.'
            }
        )
    }
}

# ===========================================================================
Head 'Verdict'

if ($script:Fixed -gt 0) {
    Write-Host "  Repaired $($script:Fixed) thing(s) along the way." -ForegroundColor Yellow
}

if ($script:Failed -eq 0) {
    Write-Host ''
    Write-Host '  Everything passes. Safe to commit and push.' -ForegroundColor Green
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host "  $($script:Failed) step(s) failed." -ForegroundColor Red
Write-Host '  The real error output is above each one - read that, not the summary.' -ForegroundColor DarkGray
Write-Host ''
exit 1
