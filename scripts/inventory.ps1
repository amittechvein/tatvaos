<#
.SYNOPSIS
    Confirm what is installed and explain what each tool is for.

.DESCRIPTION
    Read-only. Checks every tool the project depends on — Windows side, WSL side
    and Docker — reports its version, and states what it is actually used for and
    at which phase.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\inventory.ps1
    .\scripts\inventory.ps1 -Missing      # only show what is NOT installed
#>

[CmdletBinding()]
param([switch]$Missing)

$ErrorActionPreference = 'SilentlyContinue'

$PF = ${env:ProgramFiles}; $PF86 = ${env:ProgramFiles(x86)}; $LOC = $env:LOCALAPPDATA

function Section { param($t)
    Write-Host ''
    Write-Host ('─' * 78) -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('─' * 78) -ForegroundColor DarkCyan
}

$script:Found = 0; $script:Gone = 0

function Show {
    param(
        [string]$Name,
        [string]$Cmd,
        [string[]]$Paths,
        [string]$VersionArg = '--version',
        [Parameter(Mandatory)][string]$Purpose,
        [string]$Phase = ''
    )

    $ver = $null; $present = $false

    if ($Cmd -and (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
        $present = $true
        try { $ver = (& $Cmd $VersionArg 2>$null | Select-Object -First 1) } catch {}
    }
    elseif ($Paths) {
        foreach ($p in $Paths) { if ($p -and (Test-Path -LiteralPath $p)) { $present = $true; break } }
    }

    if ($present) {
        $script:Found++
        if ($Missing) { return }
        $v = if ($ver) { ($ver -replace '\s+', ' ').Trim() } else { 'installed' }
        if ($v.Length -gt 34) { $v = $v.Substring(0, 34) }
        Write-Host ("  {0,-20} " -f $Name) -NoNewline -ForegroundColor White
        Write-Host ("{0,-36}" -f $v) -NoNewline -ForegroundColor DarkGray
        Write-Host "OK" -ForegroundColor Green
    }
    else {
        $script:Gone++
        Write-Host ("  {0,-20} " -f $Name) -NoNewline -ForegroundColor White
        Write-Host ("{0,-36}" -f 'not found') -NoNewline -ForegroundColor DarkGray
        Write-Host "MISSING" -ForegroundColor Red
    }

    if (-not $Missing -or -not $present) {
        Write-Host ("      {0}" -f $Purpose) -ForegroundColor DarkGray
        if ($Phase) { Write-Host ("      used from: {0}" -f $Phase) -ForegroundColor DarkGray }
    }
}

Write-Host "`n  TatvaOS Mail — software inventory" -ForegroundColor Cyan
Write-Host "  What is installed, and what each thing is for.`n" -ForegroundColor DarkGray

# ===========================================================================
Section 'Core — you touch these every day'

Show -Name 'Git' -Cmd git -Purpose 'Version control. The repo, branches, history.' -Phase 'day 1'
Show -Name 'VS Code' -Cmd code -Paths @("$LOC\Programs\Microsoft VS Code\Code.exe") `
     -Purpose 'Editor. With the WSL extension it edits files inside Linux transparently.' -Phase 'day 1'
Show -Name 'Windows Terminal' -Cmd wt -Purpose 'Tabbed terminal that handles WSL properly.' -Phase 'day 1'
Show -Name 'PowerShell 7' -Cmd pwsh -Purpose 'The setup and doctor scripts assume 7, not the built-in 5.1.' -Phase 'day 1'
Show -Name 'GitHub CLI' -Cmd gh -Purpose 'Create repos, open PRs, manage releases without leaving the terminal.' -Phase 'day 1'
Show -Name '7-Zip' -Paths @("$PF\7-Zip\7z.exe") -Purpose 'Archives. Needed for release bundles and log exports.' -Phase 'occasional'
Show -Name 'PowerToys' -Paths @("$LOC\PowerToys\PowerToys.exe","$PF\PowerToys\PowerToys.exe") `
     -Purpose 'Window management and a fast launcher. Quality of life, not required.' -Phase 'optional'

# ===========================================================================
Section 'Runtimes — what the product is built with'

Show -Name '.NET 10 SDK' -Cmd dotnet -Purpose 'The backend API. LTS, supported to Nov 2028. Not .NET 9 — that goes EOL 10 Nov 2026.' -Phase 'Phase 1'
Show -Name 'Node.js 22' -Cmd node -Purpose 'Runs Next.js (web) and Expo (mobile). LTS.' -Phase 'Phase 1'
Show -Name 'pnpm' -Cmd pnpm -Purpose 'Monorepo package manager. Faster and stricter than npm about phantom dependencies.' -Phase 'Phase 1'

# ===========================================================================
Section 'Containers — the local mail platform'

Show -Name 'Docker Desktop' -Cmd docker -Purpose 'Runs the whole local stack: Postgres, Redis, Postfix, Dovecot, Mailpit.' -Phase 'now'
Show -Name 'Docker Compose' -Cmd docker -VersionArg 'compose version' `
     -Purpose 'Defines and starts the five-container stack in local/docker-compose.yml.' -Phase 'now'

# ===========================================================================
Section 'Mail — testing and operations'

Show -Name 'Thunderbird' -Paths @("$PF\Mozilla Thunderbird\thunderbird.exe") `
     -Purpose 'A real IMAP client. Proves your server works with software you did not write — the only honest test.' -Phase 'now'
Show -Name 'Tailscale' -Cmd tailscale -Paths @("$PF\Tailscale\tailscale.exe") `
     -Purpose 'Private network to the Linode. Lets you reach it without exposing SSH to the internet.' -Phase 'Sprint 0.1'
Show -Name 'cloudflared' -Cmd cloudflared `
     -Purpose 'Tunnels a public URL to localhost. Needed to receive bounce and complaint webhooks from a relay during development.' -Phase 'Phase 1'

# ===========================================================================
Section 'Data and API'

Show -Name 'DBeaver' -Paths @("$PF\DBeaver\dbeaver.exe") `
     -Purpose 'Postgres GUI. Inspect tenant data, test RLS policies by hand, read the schema.' -Phase 'now'
Show -Name 'Bruno' -Paths @("$LOC\Programs\Bruno\Bruno.exe") `
     -Purpose 'API client. Stores collections as files in the repo, so requests are version-controlled alongside the API.' -Phase 'Phase 1'

# ===========================================================================
Section 'Mobile'

Show -Name 'Android Studio' -Paths @("$PF\Android\Android Studio\bin\studio64.exe") `
     -Purpose 'Android SDK, emulator and adb. Not the editor — you write the app in VS Code.' -Phase 'Phase 2 (~month 7)'

# ===========================================================================
Section 'Operations'

Show -Name 'Terraform' -Cmd terraform -Purpose 'Linode instances, DNS records and storage as code, so the server is reproducible.' -Phase 'Phase 3'
Show -Name 'Bitwarden' -Paths @("$LOC\Programs\Bitwarden\Bitwarden.exe") `
     -Purpose 'Secrets. The DKIM private key belongs here, not only in the repo folder.' -Phase 'now'
Show -Name 'WinSCP' -Paths @("$PF86\WinSCP\WinSCP.exe","$PF\WinSCP\WinSCP.exe") `
     -Purpose 'Drag-and-drop file transfer to the Linode when scp is more friction than it is worth.' -Phase 'Sprint 0.2'
Show -Name 'Firefox' -Paths @("$PF\Mozilla Firefox\firefox.exe") `
     -Purpose 'Second browser. The web client must work outside Chrome, and you want to find that out early.' -Phase 'Phase 1'

# ===========================================================================
Section 'WSL — where the Linux work happens'

$wsl = $false
try { $null = wsl --status 2>&1; $wsl = ($LASTEXITCODE -eq 0) } catch {}

if (-not $wsl) {
    Write-Host "  WSL not available" -ForegroundColor Red
} else {
    $distro = ((wsl --list --quiet) | Out-String) -replace "`0",'' -split "`r?`n" |
              ForEach-Object { $_.Trim() } | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1
    Write-Host "  distro: $distro`n" -ForegroundColor DarkGray

    $tools = @(
        @{n='dig';      c='dig -v 2>&1 | head -1';        p='DNS lookups. You will run this hundreds of times verifying SPF, DKIM, DMARC and PTR.'}
        @{n='swaks';    c='swaks --version 2>/dev/null | head -1'; p='Scripted SMTP testing. Sends crafted messages to reproduce delivery failures. THE mail debugging tool.'}
        @{n='psql';     c='psql --version';                p='Postgres client. Query the database directly, run the isolation checks by hand.'}
        @{n='redis-cli';c='redis-cli --version';           p='Inspect the cache and job queue.'}
        @{n='openssl';  c='openssl version';               p='Generates DKIM keys, inspects TLS certificates.'}
        @{n='jq';       c='jq --version';                  p='Parse JSON in shell scripts and API responses.'}
        @{n='node';     c='node --version';                p='Node inside Linux — where builds actually run.'}
        @{n='pnpm';     c='pnpm --version';                p='Package manager inside Linux.'}
        @{n='dotnet';   c='$HOME/.dotnet/dotnet --version';p='.NET SDK inside Linux — where the API is built and run.'}
        @{n='telnet';   c='which telnet';                  p='Raw port and SMTP conversation testing. Crude and irreplaceable.'}
        @{n='git';      c='git --version';                 p='Version control inside WSL.'}
    )

    foreach ($t in $tools) {
        $out = (wsl -d $distro -- bash -lc "$($t.c) 2>/dev/null" 2>$null)
        $out = if ($out) { ($out -join ' ').Trim() } else { $null }
        if ($out) {
            $script:Found++
            if ($Missing) { continue }
            if ($out.Length -gt 34) { $out = $out.Substring(0,34) }
            Write-Host ("  {0,-20} " -f $t.n) -NoNewline -ForegroundColor White
            Write-Host ("{0,-36}" -f $out) -NoNewline -ForegroundColor DarkGray
            Write-Host "OK" -ForegroundColor Green
        } else {
            $script:Gone++
            Write-Host ("  {0,-20} " -f $t.n) -NoNewline -ForegroundColor White
            Write-Host ("{0,-36}" -f 'not found') -NoNewline -ForegroundColor DarkGray
            Write-Host "MISSING" -ForegroundColor Red
        }
        if (-not $Missing -or -not $out) { Write-Host ("      {0}" -f $t.p) -ForegroundColor DarkGray }
    }
}

# ===========================================================================
Section 'Docker images — the local mail platform'

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $imgs = @(
        @{n='postgres:17';       p='Tenant data, RLS policies, mailbox and routing tables.'}
        @{n='redis:7';           p='Cache, sessions, and the job queue.'}
        @{n='mailpit';           p='Catches ALL outbound mail. The reason nothing escapes to the real internet.'}
        @{n='local-postfix';     p='The MTA. Receives on 25, submits on 587, looks up recipients in Postgres.'}
        @{n='local-dovecot';     p='IMAP server and mail store. Authenticates against Postgres, writes maildirs.'}
    )
    $have = (docker images --format '{{.Repository}}:{{.Tag}}' 2>$null) -join "`n"
    foreach ($i in $imgs) {
        $key = ($i.n -split ':')[0]
        if ($have -match [regex]::Escape($key)) {
            Write-Host ("  {0,-20} " -f $i.n) -NoNewline -ForegroundColor White
            Write-Host ("{0,-36}" -f 'built/pulled') -NoNewline -ForegroundColor DarkGray
            Write-Host "OK" -ForegroundColor Green
        } else {
            Write-Host ("  {0,-20} " -f $i.n) -NoNewline -ForegroundColor White
            Write-Host ("{0,-36}" -f 'not built') -NoNewline -ForegroundColor DarkGray
            Write-Host "—" -ForegroundColor Yellow
        }
        Write-Host ("      {0}" -f $i.p) -ForegroundColor DarkGray
    }
} else {
    Write-Host "  docker not available" -ForegroundColor Red
}

# ===========================================================================
Section 'Not installed, deliberately'

@(
    @{n='Kubernetes';  w='Cut for v1. Docker Compose on VMs carries you to hundreds of tenants. K8s is a part-time job.'}
    @{n='RabbitMQ';    w='Cut for v1. A Postgres queue with SKIP LOCKED gives transactional enqueue and zero new infrastructure.'}
    @{n='OpenSearch';  w='Cut for v1. Postgres full-text search handles mail well into the tens of GB.'}
    @{n='MinIO';       w='Never self-host object storage. If it loses data you have lost customer mail permanently.'}
    @{n='ClamAV';      w='Not on the 1 GB Linode — needs 1–2 GB for signatures alone. Add after resizing.'}
    @{n='Visual Studio';w='VS Code covers it. Add JetBrains Rider only if you feel the gap in C# refactoring.'}
) | ForEach-Object {
    Write-Host ("  {0,-20} " -f $_.n) -NoNewline -ForegroundColor DarkGray
    Write-Host $_.w -ForegroundColor DarkGray
}

# ===========================================================================
Write-Host ''
Write-Host ('─' * 78) -ForegroundColor DarkCyan
Write-Host ("  present: {0}    missing: {1}" -f $script:Found, $script:Gone) -ForegroundColor $(if ($script:Gone) {'Yellow'} else {'Green'})
if ($script:Gone -gt 0) {
    Write-Host "  Install what is missing:  .\scripts\setup-dev-env.ps1" -ForegroundColor DarkGray
}
Write-Host ''
