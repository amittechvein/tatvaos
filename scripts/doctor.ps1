<#
.SYNOPSIS
    Diagnose the TatvaOS Mail development environment and print exact fixes.

.DESCRIPTION
    Read-only. Changes nothing. Checks each layer in the order that things
    actually break, and stops guessing once it finds the root cause.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$script:Problems = [System.Collections.Generic.List[string]]::new()

function Section { param($t) Write-Host "`n$('-'*68)" -ForegroundColor DarkCyan
                             Write-Host "  $t"        -ForegroundColor Cyan
                             Write-Host $('-'*68)     -ForegroundColor DarkCyan }
function Good { param($m) Write-Host "  [ ok ] $m"  -ForegroundColor Green }
function Warn { param($m) Write-Host "  [warn] $m"  -ForegroundColor Yellow }
function Bad  { param($m,$fix) Write-Host "  [BAD ] $m" -ForegroundColor Red
                if ($fix) { $script:Problems.Add($fix) } }
function Note { param($m) Write-Host "         $m"  -ForegroundColor DarkGray }

Write-Host "`n  TatvaOS Mail - environment doctor" -ForegroundColor Cyan
Write-Host "  Read-only. Nothing will be changed.`n" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
Section 'PowerShell'

Write-Host "  PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Gray

$effective = Get-ExecutionPolicy
if ($effective -in 'Restricted','AllSigned') {
    Bad "Execution policy is '$effective' - this blocks .ps1 scripts" @'
Execution policy is blocking scripts. Either run once without changing anything:

    powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev-env.ps1

or allow local scripts permanently for your user:

    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
    Unblock-File .\scripts\*.ps1
'@
} else {
    Good "Execution policy: $effective"
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Good 'Running elevated'
} else {
    Warn 'Not elevated - fine for this doctor, required for setup-dev-env.ps1'
}

# blocked files (mark-of-the-web)
$blocked = @(Get-ChildItem -Path (Join-Path $PSScriptRoot '*.ps1') -ErrorAction SilentlyContinue |
             Where-Object { Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue })
if ($blocked.Count) {
    Bad "$($blocked.Count) script(s) marked as downloaded and will be blocked" `
        "Unblock-File .\scripts\*.ps1"
} else {
    Good 'No scripts blocked by mark-of-the-web'
}

# ---------------------------------------------------------------------------
Section 'Tooling'

$tools = @(
    @{ Cmd='winget';    Name='winget';        Fix='Install "App Installer" from the Microsoft Store' }
    @{ Cmd='git';       Name='Git' }
    @{ Cmd='dotnet';    Name='.NET SDK' }
    @{ Cmd='node';      Name='Node.js' }
    @{ Cmd='docker';    Name='Docker CLI' }
    @{ Cmd='wsl';       Name='WSL' }
    @{ Cmd='code';      Name='VS Code' }
)

$missing = @()
foreach ($t in $tools) {
    $c = Get-Command $t.Cmd -ErrorAction SilentlyContinue
    if ($c) {
        $v = ''
        try {
            $v = switch ($t.Cmd) {
                'dotnet' { (dotnet --version 2>$null) }
                'node'   { (node --version   2>$null) }
                'git'    { ((git --version   2>$null) -replace 'git version ','') }
                default  { '' }
            }
        } catch { }
        Good ("{0}{1}" -f $t.Name, $(if ($v) { " $v" } else { '' }))
    } else {
        Bad "$($t.Name) not found" $(if ($t.Fix) { $t.Fix } else { "Run: .\scripts\setup-dev-env.ps1" })
        $missing += $t.Name
    }
}

# ---------------------------------------------------------------------------
Section 'WSL'

$wslOk = $false
try { $null = wsl --status 2>&1; $wslOk = ($LASTEXITCODE -eq 0) } catch { }

if (-not $wslOk) {
    Bad 'WSL2 not installed or not working' @'
Install WSL2 (elevated), then REBOOT:

    wsl --install -d Ubuntu-24.04

After rebooting, launch Ubuntu once from the Start menu to create your Linux user.
'@
} else {
    Good 'WSL responding'
    $distros = ((wsl --list --quiet) | Out-String) -replace "`0", ''
    if ($distros -match 'Ubuntu') {
        Good "Ubuntu present"
        $whoami = (wsl -- bash -c 'whoami' 2>$null)
        if ($whoami) { Good "Linux user: $($whoami.Trim())" }
        else { Bad 'Ubuntu installed but no user created' 'Launch Ubuntu once from the Start menu to create your Linux user.' }
    } else {
        Bad 'No Ubuntu distro' 'wsl --install -d Ubuntu-24.04    (then reboot)'
    }
}

# ---------------------------------------------------------------------------
Section 'Docker'

$dockerExe = Get-Command docker -ErrorAction SilentlyContinue
$ddPath    = "${env:ProgramFiles}\Docker\Docker\Docker Desktop.exe"
$ddRunning = [bool](Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)

if (-not $dockerExe -and -not (Test-Path $ddPath)) {
    Bad 'Docker Desktop is not installed' @'
Install it:

    winget install --id Docker.DockerDesktop --exact
'@
}
else {
    if (Test-Path $ddPath) { Good 'Docker Desktop installed' }

    if ($ddRunning) { Good 'Docker Desktop process running' }
    else {
        Bad 'Docker Desktop is NOT running' @'
Docker Desktop is installed but not started. This is the cause of:
    "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine"

Start it and wait for the whale icon to stop animating (30-60 seconds):

    Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"

Then: Settings > General > "Use the WSL 2 based engine"  (must be ticked)
      Settings > Resources > WSL Integration > enable Ubuntu-24.04
'@
    }

    if ($dockerExe) {
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Good 'Docker daemon reachable'
            $wslDocker = (wsl -- bash -c 'command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo yes' 2>$null)
            if ($wslDocker -match 'yes') {
                Good 'Docker reachable from inside WSL'
            } else {
                Bad 'Docker not reachable from WSL' @'
Docker Desktop > Settings > Resources > WSL Integration > enable Ubuntu-24.04
Then Apply & Restart. The local stack scripts run inside WSL and need this.
'@
            }
        } else {
            Bad 'Docker daemon not responding' 'Start Docker Desktop and wait for it to finish starting.'
        }
    }
}

# ---------------------------------------------------------------------------
Section 'Repository location'

$repo = Split-Path $PSScriptRoot -Parent
Write-Host "  Repo: $repo" -ForegroundColor Gray

if ($repo -match '^[A-Za-z]:\\') {
    Warn 'Repo is on the Windows filesystem'
    Note 'Fine for docs and config. For active development, move it inside WSL:'
    Note ''
    Note '    wsl'
    Note '    mkdir -p ~/code && cp -r /mnt/c/Users/amitd/Downloads/tatvaOS ~/code/'
    Note '    cd ~/code/tatvaOS && code .'
    Note ''
    Note 'Cross-filesystem I/O in WSL2 is roughly 10x slower. With a pnpm'
    Note 'monorepo and .NET builds you will feel it every day.'
}

# ---------------------------------------------------------------------------
Section 'Shell scripts'

Note 'The .sh files are Linux scripts. PowerShell cannot run them.'
Note ''
Note 'Wrong:   ./scripts/test-mail.sh          (from PowerShell)'
Note 'Right:   wsl bash ./scripts/test-mail.sh'
Note 'or:      wsl        then run them normally inside Ubuntu'

# ---------------------------------------------------------------------------
Write-Host "`n$('='*68)" -ForegroundColor Cyan

if ($script:Problems.Count -eq 0) {
    Write-Host "  Environment looks healthy." -ForegroundColor Green
    Write-Host @'

  Bring up the local mail stack:

      cd local
      docker compose up -d --build
      wsl bash ./scripts/test-mail.sh
      wsl bash ./scripts/test-isolation.sh

  Then open http://localhost:8025

'@ -ForegroundColor Gray
}
else {
    Write-Host "  $($script:Problems.Count) problem(s) found. Fix in this order:" -ForegroundColor Yellow
    $i = 1
    foreach ($p in $script:Problems) {
        Write-Host "`n  --- $i ---" -ForegroundColor Yellow
        Write-Host $p -ForegroundColor Gray
        $i++
    }
    Write-Host ''
}
