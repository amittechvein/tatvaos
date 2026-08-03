<#
.SYNOPSIS
    TatvaOS Mail - install the full Windows development environment.
    Installs only what is missing. Safe to run repeatedly.

.DESCRIPTION
    Single self-contained script. No companion files required.

    Detection is three-way, so nothing already on your machine gets reinstalled
    even if you installed it manually rather than through winget:
        1. winget package registry
        2. the executable being on PATH
        3. known install locations on disk

    Installs:
      Core       Git, PowerShell 7, Windows Terminal, VS Code, GitHub CLI,
                 7-Zip, PowerToys
      Runtimes   .NET 10 SDK (LTS), Node.js 22 LTS, pnpm
      Containers Docker Desktop, WSL2 + Ubuntu 24.04
      Mail       Thunderbird, Tailscale, cloudflared
      Data       DBeaver, Bruno
      Mobile     Android Studio
      Ops        Terraform, Bitwarden, WinSCP
      Browsers   Firefox

    Then provisions Ubuntu: build tools, swaks, dig, psql, redis-cli, openssl,
    Node 22 via fnm, pnpm, and the .NET 10 SDK.

.PARAMETER Skip
    Groups to leave out, e.g.  -Skip Mobile,Ops

.PARAMETER SkipWsl
    Do not touch WSL. Not recommended - the mail stack is Linux-only.

.PARAMETER Upgrade
    Upgrade what is already installed instead of skipping it.

.PARAMETER DryRun
    Report every action. Change nothing.

.EXAMPLE
    .\setup-dev-env.ps1 -DryRun
    .\setup-dev-env.ps1
    .\setup-dev-env.ps1 -Skip Mobile
    .\setup-dev-env.ps1 -Upgrade

.NOTES
    Run from an ELEVATED PowerShell prompt.
    Allow 45-60 minutes and ~50 GB of disk.
    A reboot is required the first time WSL2 installs; re-run afterwards.
#>

[CmdletBinding()]
param(
    [ValidateSet('Core','Runtimes','Containers','Mail','Data','Mobile','Ops','Browsers')]
    [string[]]$Skip = @(),

    [switch]$SkipWsl,
    [switch]$Upgrade,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$script:Results      = [System.Collections.Generic.List[object]]::new()
$script:UbuntuDistro = $null

$PF    = ${env:ProgramFiles}
$PF86  = ${env:ProgramFiles(x86)}
$LOCAL = $env:LOCALAPPDATA

# ===========================================================================
#  Catalogue
#    Id     winget package id
#    Cmd    executable that proves it is installed (checked on PATH)
#    Paths  fallback locations for installs done outside winget
# ===========================================================================

$Catalogue = [ordered]@{

    Core = @(
        @{ Id='Git.Git'; Name='Git'; Cmd='git'
           Paths=@("$PF\Git\cmd\git.exe", "$PF86\Git\cmd\git.exe") }

        @{ Id='Microsoft.PowerShell'; Name='PowerShell 7'; Cmd='pwsh'
           Paths=@("$PF\PowerShell\7\pwsh.exe") }

        @{ Id='Microsoft.WindowsTerminal'; Name='Windows Terminal'; Cmd='wt' }

        @{ Id='Microsoft.VisualStudioCode'; Name='VS Code'; Cmd='code'
           Paths=@("$LOCAL\Programs\Microsoft VS Code\Code.exe",
                   "$PF\Microsoft VS Code\Code.exe") }

        @{ Id='GitHub.cli'; Name='GitHub CLI'; Cmd='gh'
           Paths=@("$PF\GitHub CLI\gh.exe") }

        @{ Id='7zip.7zip'; Name='7-Zip'
           Paths=@("$PF\7-Zip\7z.exe") }

        @{ Id='Microsoft.PowerToys'; Name='PowerToys'
           Paths=@("$LOCAL\PowerToys\PowerToys.exe",
                   "$PF\PowerToys\PowerToys.exe") }
    )

    Runtimes = @(
        @{ Id='Microsoft.DotNet.SDK.10'; Name='.NET 10 SDK (LTS)'; Cmd='dotnet'
           Paths=@("$PF\dotnet\dotnet.exe") }

        @{ Id='OpenJS.NodeJS.LTS'; Name='Node.js 22 LTS'; Cmd='node'
           Paths=@("$PF\nodejs\node.exe") }
    )

    Containers = @(
        @{ Id='Docker.DockerDesktop'; Name='Docker Desktop'; Cmd='docker'
           Paths=@("$PF\Docker\Docker\Docker Desktop.exe") }
    )

    Mail = @(
        @{ Id='Mozilla.Thunderbird'; Name='Thunderbird (IMAP test client)'
           Paths=@("$PF\Mozilla Thunderbird\thunderbird.exe") }

        @{ Id='tailscale.tailscale'; Name='Tailscale'; Cmd='tailscale'
           Alt=@('Tailscale.Tailscale','Tailscale.tailscale')
           Paths=@("$PF\Tailscale\tailscale.exe") }

        @{ Id='Cloudflare.cloudflared'; Name='cloudflared (webhook tunnel)'; Cmd='cloudflared' }
    )

    Data = @(
        @{ Id='DBeaver.DBeaver.Community'; Name='DBeaver (Postgres client)'
           Alt=@('dbeaver.dbeaver','DBeaver.DBeaver')
           Paths=@("$PF\DBeaver\dbeaver.exe") }

        @{ Id='Bruno.Bruno'; Name='Bruno (API client)'
           Paths=@("$LOCAL\Programs\Bruno\Bruno.exe") }
    )

    Mobile = @(
        @{ Id='Google.AndroidStudio'; Name='Android Studio (~12 GB)'
           Paths=@("$PF\Android\Android Studio\bin\studio64.exe") }
    )

    Ops = @(
        @{ Id='Hashicorp.Terraform'; Name='Terraform'; Cmd='terraform' }

        @{ Id='Bitwarden.Bitwarden'; Name='Bitwarden'
           Paths=@("$LOCAL\Programs\Bitwarden\Bitwarden.exe") }

        @{ Id='WinSCP.WinSCP'; Name='WinSCP'
           Paths=@("$PF86\WinSCP\WinSCP.exe", "$PF\WinSCP\WinSCP.exe") }
    )

    Browsers = @(
        @{ Id='Mozilla.Firefox'; Name='Firefox (cross-browser testing)'
           Paths=@("$PF\Mozilla Firefox\firefox.exe") }
    )
}

# Optional extras - add to a group above if you want them:
#   JetBrains.Rider     stronger C# refactoring than VS Code
#   Postman.Postman     if you prefer it to Bruno
#   Google.Chrome

# ===========================================================================
#  Output
# ===========================================================================

function Write-Banner {
    param([string]$Text)
    Write-Host ''
    Write-Host ('-' * 74) -ForegroundColor DarkCyan
    Write-Host "  $Text"   -ForegroundColor Cyan
    Write-Host ('-' * 74) -ForegroundColor DarkCyan
}
function Write-Step { param($m) Write-Host "`n  $m"           -ForegroundColor White }
function Write-Ok   { param($m) Write-Host "    [ ok ] $m"    -ForegroundColor Green }
function Write-Skip { param($m) Write-Host "    [have] $m"    -ForegroundColor DarkGray }
function Write-Note { param($m) Write-Host "    [note] $m"    -ForegroundColor Yellow }
function Write-Bad  { param($m) Write-Host "    [FAIL] $m"    -ForegroundColor Red }
function Write-Dry  { param($m) Write-Host "    [dry ] $m"    -ForegroundColor Magenta }

function Add-Result {
    param([string]$Item, [string]$Status, [string]$Detail = '')
    $script:Results.Add([pscustomobject]@{ Item=$Item; Status=$Status; Detail=$Detail })
}

# ===========================================================================
#  Detection - three independent checks
# ===========================================================================

function Test-InWinget {
    param([string]$Id)
    try {
        $out = winget list --id $Id --exact --accept-source-agreements 2>$null | Out-String
        return $out -match [regex]::Escape($Id)
    } catch { return $false }
}

function Test-OnPath {
    param([string]$Cmd)
    if (-not $Cmd) { return $false }
    return [bool](Get-Command $Cmd -ErrorAction SilentlyContinue)
}

function Test-OnDisk {
    param([string[]]$Paths)
    if (-not $Paths) { return $false }
    foreach ($p in $Paths) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $true }
    }
    return $false
}

function Get-AppPresence {
    param([hashtable]$Pkg)
    if (Test-OnPath  $Pkg.Cmd)   { return 'PATH' }
    if (Test-OnDisk  $Pkg.Paths) { return 'disk' }
    if (Test-InWinget $Pkg.Id)   { return 'winget' }
    return $null
}

# ===========================================================================
#  Preflight
# ===========================================================================

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Preflight {
    Write-Banner 'Preflight'
    $blocking = 0

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Ok "winget present"
    } else {
        Write-Bad "winget not found - install 'App Installer' from the Microsoft Store"
        $blocking++
    }

    if (Test-Admin) { Write-Ok 'Running elevated' }
    else {
        Write-Bad 'NOT elevated - WSL and Docker installs will fail'
        $blocking++
    }

    $build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
    if ($build -ge 19041) { Write-Ok "Windows build $build" }
    else { Write-Bad "Windows build $build too old for WSL2 (need 19041+)"; $blocking++ }

    $ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
    if     ($ramGb -ge 32) { Write-Ok   "RAM ${ramGb} GB" }
    elseif ($ramGb -ge 16) { Write-Note "RAM ${ramGb} GB - workable, but you will swap in Phase 1. 32 GB recommended" }
    else                   { Write-Bad  "RAM ${ramGb} GB - too little for the full stack" }

    $sysDrive = ($env:SystemDrive).TrimEnd(':')
    $freeGb   = [math]::Round((Get-PSDrive -Name $sysDrive).Free / 1GB)
    $needGb   = if ($Skip -contains 'Mobile') { 25 } else { 50 }
    if ($freeGb -ge $needGb) { Write-Ok "Free disk ${freeGb} GB (need ~${needGb} GB)" }
    else { Write-Bad "Free disk ${freeGb} GB - need about ${needGb} GB"; $blocking++ }

    if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent) {
        Write-Ok 'Hardware virtualisation enabled'
    } else {
        Write-Note 'Virtualisation not detected - enable VT-x/AMD-V in BIOS, or WSL2 and the Android emulator will not run'
    }

    return $blocking
}

# ===========================================================================
#  Install
# ===========================================================================

function Install-Package {
    param([hashtable]$Pkg)

    $found = Get-AppPresence -Pkg $Pkg

    if ($found -and -not $Upgrade) {
        Write-Skip "$($Pkg.Name)  (found via $found)"
        Add-Result $Pkg.Name 'already present' "via $found"
        return
    }

    $verb = if ($found) { 'upgrade' } else { 'install' }

    if ($DryRun) {
        Write-Dry "would $verb $($Pkg.Name)  [$($Pkg.Id)]"
        Add-Result $Pkg.Name "would $verb"
        return
    }

    Write-Host "    ...    $verb $($Pkg.Name)" -ForegroundColor Gray

    # Try the primary id, then any known alternates. Package ids get renamed
    # and re-cased upstream; -1978335212 (0x8A150014) means "no package found",
    # which is almost always a stale or changed id rather than a real problem.
    $ids = @($Pkg.Id) + @($Pkg.Alt | Where-Object { $_ })
    $last = $null

    foreach ($id in $ids) {
        try {
            $wingetArgs = @('--id', $id, '--exact', '--silent',
                            '--accept-package-agreements', '--accept-source-agreements')
            if ($found) { winget upgrade @wingetArgs 2>&1 | Out-Null }
            else        { winget install @wingetArgs 2>&1 | Out-Null }
            $last = $LASTEXITCODE

            # 0 ok | -1978335189 no applicable upgrade | -1978335135 already installed
            if ($last -in 0, -1978335189, -1978335135) {
                if ($id -ne $Pkg.Id) { Write-Ok "$($Pkg.Name)  (via alternate id $id)" }
                else                 { Write-Ok $Pkg.Name }
                Add-Result $Pkg.Name 'installed' $(if ($id -ne $Pkg.Id) { "id: $id" } else { '' })
                return
            }
        }
        catch {
            $last = $_.Exception.Message
        }
    }

    # Everything failed - look up what winget actually has, so the fix is obvious
    $hint = "exit $last"
    if ($last -eq -1978335212) {
        $term = ($Pkg.Name -split ' ')[0]
        try {
            $found2 = winget search $term --accept-source-agreements 2>$null |
                      Select-Object -Skip 2 -First 4 | Out-String
            if ($found2.Trim()) { $hint = "id not found. winget search $term returned:`n$($found2.Trim())" }
            else                { $hint = "no package matching '$term' in your winget sources. Try: winget source update" }
        } catch { }
    }

    Write-Bad "$($Pkg.Name) - $hint"
    Add-Result $Pkg.Name 'FAILED' $hint
}

# ===========================================================================
#  WSL
# ===========================================================================

function Get-UbuntuDistro {
    # An existing WSL install may be named 'Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04'
    # or something custom. Hardcoding a name is how you get WSL_E_DISTRO_NOT_FOUND.
    try {
        $raw = ((wsl --list --quiet) | Out-String) -replace "`0", ''
    } catch { return $null }

    $names = $raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }

    foreach ($preferred in 'Ubuntu-24.04', 'Ubuntu') {
        $hit = $names | Where-Object { $_ -eq $preferred } | Select-Object -First 1
        if ($hit) { return $hit }
    }
    return ($names | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1)
}

function Install-Wsl {
    Write-Banner 'WSL2 + Ubuntu'
    Write-Host '  Postfix, Dovecot and Rspamd are Linux-only. This is the foundation' -ForegroundColor Gray
    Write-Host '  of the environment, not an optional extra.' -ForegroundColor Gray

    if ($DryRun) {
        Write-Dry 'would install WSL2 + Ubuntu 24.04 and write .wslconfig'
        Add-Result 'WSL2 + Ubuntu' 'would install'
        return $false
    }

    $needsReboot = $false
    $hasWsl = $false
    try { $null = wsl --status 2>&1; $hasWsl = ($LASTEXITCODE -eq 0) } catch { $hasWsl = $false }

    if (-not $hasWsl) {
        Write-Step 'Installing WSL2'
        wsl --install -d Ubuntu-24.04 2>&1 | Out-Null
        Write-Note 'REBOOT REQUIRED. After rebooting, launch Ubuntu once to create'
        Write-Note 'your Linux user, then re-run this script to finish.'
        Add-Result 'WSL2' 'installed - REBOOT NEEDED'
        $needsReboot = $true
    }
    else {
        $script:UbuntuDistro = Get-UbuntuDistro

        if (-not $script:UbuntuDistro) {
            Write-Step 'Adding Ubuntu 24.04'
            wsl --install -d Ubuntu-24.04 2>&1 | Out-Null
            Write-Note 'Launch Ubuntu once to create your Linux user, then re-run.'
            Add-Result 'Ubuntu 24.04' 'installed - launch it once'
            $needsReboot = $true
        } else {
            Write-Skip "WSL2 present, distro: $($script:UbuntuDistro)"
            Add-Result 'WSL2 + Ubuntu' 'already present' "distro: $($script:UbuntuDistro)"

            # An existing distro may be a WSL1 install; the mail stack needs WSL2.
            $ver = ((wsl --list --verbose) | Out-String) -replace "`0", ''
            $line = ($ver -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($script:UbuntuDistro) } | Select-Object -First 1)
            if ($line -and $line -match '\s1\s*$') {
                Write-Note "$($script:UbuntuDistro) is running on WSL1. Convert it:"
                Write-Note "  wsl --set-version $($script:UbuntuDistro) 2"
                Add-Result 'WSL version' 'ACTION NEEDED' 'distro is WSL1, needs WSL2'
            }
        }
        wsl --set-default-version 2 2>&1 | Out-Null
    }

    Write-Step 'WSL resource limits'
    $wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
    if (Test-Path $wslConfig) {
        Write-Skip '.wslconfig exists - leaving your settings alone'
        Add-Result '.wslconfig' 'already present'
    }
    else {
        $totalGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
        $wslGb   = [math]::Max(4, [math]::Floor($totalGb / 2))
        $logical = [int]$env:NUMBER_OF_PROCESSORS
        $cores   = [math]::Max(2, [math]::Floor($logical * 0.75))

        @"
# TatvaOS Mail dev environment
# Caps WSL2 so it cannot consume the whole machine.
[wsl2]
memory=${wslGb}GB
processors=$cores
swap=8GB
localhostForwarding=true
"@ | Set-Content -Path $wslConfig -Encoding UTF8

        Write-Ok "Wrote .wslconfig - ${wslGb} GB RAM, $cores cores (of ${totalGb} GB / $logical logical)"
        Add-Result '.wslconfig' 'created' "${wslGb}GB / $cores cores"
    }

    return $needsReboot
}

# --- Ubuntu provisioning, embedded so this script stands alone --------------

$WslBootstrap = @'
#!/usr/bin/env bash
set -uo pipefail
FAIL=0
ok()   { printf '    [ ok ] %s\n' "$1"; }
have() { printf '    [have] %s\n' "$1"; }
bad()  { printf '    [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n  == %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] && { echo "Do not run as root."; exit 1; }
sudo -v || { echo "sudo failed"; exit 1; }

hdr "System packages"
sudo apt-get update -qq && ok "apt index updated" || bad "apt update"
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq >/dev/null 2>&1 || true

for p in build-essential ca-certificates curl wget git unzip zip jq htop \
         dnsutils net-tools telnet swaks postgresql-client redis-tools \
         openssl pkg-config python3 python3-pip; do
    if dpkg -s "$p" >/dev/null 2>&1; then
        have "$p"
    else
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p" >/dev/null 2>&1 \
            && ok "$p" || bad "$p"
    fi
done

hdr "Node 22 + pnpm"
export FNM_DIR="$HOME/.local/share/fnm"; export PATH="$FNM_DIR:$PATH"
if [ -x "$FNM_DIR/fnm" ]; then
    have "fnm"
else
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell >/dev/null 2>&1 \
        && ok "fnm" || bad "fnm"
fi
if [ -x "$FNM_DIR/fnm" ]; then
    eval "$("$FNM_DIR/fnm" env --use-on-cd --shell bash 2>/dev/null || true)"
    if "$FNM_DIR/fnm" list 2>/dev/null | grep -q 'v22'; then
        have "Node 22"
    else
        "$FNM_DIR/fnm" install 22 >/dev/null 2>&1 && ok "Node 22" || bad "Node 22"
    fi
    "$FNM_DIR/fnm" default 22 >/dev/null 2>&1 || true
fi
if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 && ok "pnpm" || true
fi

hdr ".NET 10 SDK"
export DOTNET_ROOT="$HOME/.dotnet"
if [ -x "$DOTNET_ROOT/dotnet" ] && "$DOTNET_ROOT/dotnet" --list-sdks 2>/dev/null | grep -q '^10\.'; then
    have ".NET 10 SDK"
else
    if wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dn.sh; then
        chmod +x /tmp/dn.sh
        /tmp/dn.sh --channel 10.0 --install-dir "$DOTNET_ROOT" >/dev/null 2>&1 \
            && ok ".NET 10 SDK" || bad ".NET 10 SDK"
        rm -f /tmp/dn.sh
    else
        bad "download dotnet-install.sh"
    fi
fi

hdr "Shell configuration"
if grep -qF "# >>> tatvaos dev env >>>" "$HOME/.bashrc" 2>/dev/null; then
    have ".bashrc already configured"
else
    cat >> "$HOME/.bashrc" <<'RC'

# >>> tatvaos dev env >>>
export FNM_DIR="$HOME/.local/share/fnm"
if [ -d "$FNM_DIR" ]; then
    export PATH="$FNM_DIR:$PATH"
    eval "$(fnm env --use-on-cd --shell bash)"
fi
export DOTNET_ROOT="$HOME/.dotnet"
[ -d "$DOTNET_ROOT" ] && export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export TATVAOS_HOME="$HOME/code/tatvaOS"
alias tv='cd "$TATVAOS_HOME"'
# <<< tatvaos dev env <<<
RC
    ok ".bashrc updated"
fi

mkdir -p "$HOME/code" && ok "project dir ~/code"

hdr "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "Docker reachable from WSL"
else
    printf '    [note] Enable Docker Desktop > Settings > Resources > WSL Integration\n'
    printf '    [note] for this distro, then Apply & Restart.\n'
fi

hdr "Result"
[ "$FAIL" -eq 0 ] && printf '    Ubuntu provisioned.\n' || printf '    %d item(s) failed.\n' "$FAIL"
exit 0
'@

function Invoke-WslBootstrap {
    Write-Banner 'Provisioning Ubuntu'

    if ($DryRun) {
        Write-Dry 'would provision Ubuntu (apt tooling, fnm/Node 22, pnpm, .NET 10)'
        Add-Result 'WSL bootstrap' 'would run'
        return
    }

    # Never hardcode the distro name - an existing install is often just 'Ubuntu'
    $distro = if ($script:UbuntuDistro) { $script:UbuntuDistro } else { Get-UbuntuDistro }

    if (-not $distro) {
        Write-Bad 'No Ubuntu distro found in WSL'
        Write-Note 'Install one:  wsl --install -d Ubuntu-24.04   (then reboot)'
        Add-Result 'WSL bootstrap' 'FAILED' 'no Ubuntu distro'
        return
    }

    Write-Host "  Target distro: $distro"                                      -ForegroundColor Gray
    Write-Host '  apt tooling, swaks, dig, psql, Node 22, pnpm, .NET 10 SDK.'  -ForegroundColor Gray
    Write-Host '  You will be prompted for your Linux sudo password.'          -ForegroundColor Gray
    Write-Host ''

    # Write with LF endings - CRLF would break the shebang inside WSL
    $tmp = Join-Path $env:TEMP 'tatvaos-setup-wsl.sh'
    [IO.File]::WriteAllText($tmp, ($WslBootstrap -replace "`r`n", "`n"))

    $drive   = $tmp.Substring(0,1).ToLower()
    $rest    = $tmp.Substring(2).Replace('\','/')
    $wslPath = "/mnt/$drive$rest"

    wsl -d $distro -- bash -c "cp '$wslPath' /tmp/s.sh && chmod +x /tmp/s.sh && bash /tmp/s.sh"

    $code = $LASTEXITCODE
    Remove-Item $tmp -ErrorAction SilentlyContinue

    if ($code -eq 0) {
        Write-Ok "Ubuntu provisioned ($distro)"
        Add-Result 'WSL bootstrap' 'complete' "distro: $distro"
        return
    }

    Write-Bad "bootstrap exited $code"

    # Exit 1 here is nearly always a failed sudo password, so say how to fix it
    # rather than leaving a bare exit code.
    $who = (wsl -d $distro -- whoami 2>$null)
    if ($who) { $who = $who.Trim() }

    Write-Note 'If that was a sudo password failure, reset it - WSL lets you in as'
    Write-Note 'root with no password, so a forgotten password is never a problem:'
    Write-Note ''
    Write-Note "    wsl -d $distro -u root -- passwd $who"
    Write-Note ''
    Write-Note 'Then re-run this script. Note that Linux password prompts show'
    Write-Note 'nothing at all as you type - no dots, no asterisks. That is normal.'

    Add-Result 'WSL bootstrap' 'FAILED' "exit $code - if sudo failed: wsl -d $distro -u root -- passwd $who"
}

# ===========================================================================
#  Post-install
# ===========================================================================

function Install-Pnpm {
    Write-Step 'pnpm (Windows side, via corepack)'
    if ($DryRun) { Write-Dry 'would enable corepack and activate pnpm'; return }

    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Skip 'pnpm already available'
        Add-Result 'pnpm (Windows)' 'already present'
        return
    }
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
        Write-Note 'corepack not on PATH yet - open a new terminal and run: corepack enable'
        Add-Result 'pnpm (Windows)' 'manual' 'corepack enable'
        return
    }
    try {
        corepack enable 2>&1 | Out-Null
        corepack prepare pnpm@latest --activate 2>&1 | Out-Null
        Write-Ok 'pnpm activated'
        Add-Result 'pnpm (Windows)' 'installed'
    } catch {
        Write-Bad "pnpm - $($_.Exception.Message)"
        Add-Result 'pnpm (Windows)' 'FAILED' $_.Exception.Message
    }
}

function Install-VsCodeExtensions {
    Write-Step 'VS Code extensions'

    $exts = @(
        'ms-vscode-remote.remote-wsl'
        'ms-dotnettools.csdevkit'
        'ms-azuretools.vscode-docker'
        'bradlc.vscode-tailwindcss'
        'dbaeumer.vscode-eslint'
        'esbenp.prettier-vscode'
        'expo.vscode-expo-tools'
        'ckolkman.vscode-postgres'
    )

    if ($DryRun) { Write-Dry "would ensure $($exts.Count) VS Code extensions"; return }

    if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
        Write-Note 'code not on PATH yet - open a new terminal and re-run to add extensions'
        Add-Result 'VS Code extensions' 'manual'
        return
    }

    $existing = @()
    try { $existing = code --list-extensions 2>$null } catch { }

    $added = 0
    foreach ($e in $exts) {
        if ($existing -contains $e) { continue }
        code --install-extension $e --force 2>&1 | Out-Null
        $added++
    }
    if ($added -gt 0) { Write-Ok "$added extension(s) installed" }
    else              { Write-Skip 'all extensions already present' }
    Add-Result 'VS Code extensions' 'ok' "$added added"
}

function Show-Report {
    param([bool]$RebootNeeded)

    Write-Banner 'Summary'
    Write-Host ''
    $script:Results | Format-Table -AutoSize | Out-String | Write-Host

    $installed = @($script:Results | Where-Object Status -match 'installed|complete|created')
    $present   = @($script:Results | Where-Object Status -match 'already present')
    $failed    = @($script:Results | Where-Object Status -eq 'FAILED')
    $manual    = @($script:Results | Where-Object Status -match 'manual|REBOOT|launch')

    Write-Host "  installed       : $($installed.Count)" -ForegroundColor Green
    Write-Host "  already present : $($present.Count)"   -ForegroundColor DarkGray
    Write-Host "  needs attention : $($manual.Count)"    -ForegroundColor Yellow
    Write-Host "  failed          : $($failed.Count)"    -ForegroundColor $(if ($failed.Count) {'Red'} else {'DarkGray'})

    if ($failed.Count) {
        Write-Host "`n  Failures:" -ForegroundColor Red
        foreach ($f in $failed) { Write-Host "    - $($f.Item): $($f.Detail)" -ForegroundColor Red }
        Write-Host "    Most winget failures are a renamed package id. Try: winget search <name>" -ForegroundColor DarkGray
    }

    Write-Banner 'Next steps'

    if ($RebootNeeded) {
        Write-Host @'
  1. REBOOT - WSL2 needs it.
  2. Launch Ubuntu from the Start menu once, create your Linux user.
  3. Re-run this script. It will skip everything already installed.
'@ -ForegroundColor Yellow
        return
    }

    $d = if ($script:UbuntuDistro) { $script:UbuntuDistro } else { 'Ubuntu' }

    Write-Host @"
  1. START DOCKER DESKTOP - it does not auto-start after installing.
     Wait for the whale icon to stop animating, then:
       Settings > General  > "Use the WSL 2 based engine"   (ticked)
       Settings > Resources > WSL Integration > enable $d
     Nothing containerised works until this is on.

  2. Keep the repo INSIDE WSL, never on /mnt/c:
       wsl
       cp -r /mnt/c/Users/$env:USERNAME/Downloads/tatvaOS ~/code/
       cd ~/code/tatvaOS && code .
     Cross-filesystem I/O is ~10x slower and you will feel it every day.

  3. Verify (inside WSL):
       dotnet --version && node --version && pnpm --version
       swaks --version && dig +short google.com
       docker run --rm hello-world

  4. Bring up the local mail stack:
       cd ~/code/tatvaOS/local
       docker compose up -d --build
       ./scripts/test-mail.sh
       ./scripts/test-isolation.sh

  5. Android Studio: open it once to finish the SDK download (~5 GB more).

  6. Accounts with real lead time - start these NOW:
       Microsoft SNDS ...... days, manual approval
       Apple Developer ..... `$99/yr, 1-2 weeks, may need a D-U-N-S number
       Razorpay KYC ........ 1-2 weeks
       Hosting ............. confirm IN WRITING that outbound port 25 is open
                             and rDNS is delegable. Phase 0 go/no-go.
"@ -ForegroundColor Gray
}

# ===========================================================================
#  Main
# ===========================================================================

Write-Host @"

  TatvaOS Mail - Development Environment
  Installs only what is missing.$(if ($DryRun) { '   [DRY RUN]' })$(if ($Upgrade) { '   [UPGRADE]' })
  $(if ($Skip.Count) { "Skipping: $($Skip -join ', ')" })

"@ -ForegroundColor Cyan

$blocking = Invoke-Preflight
if ($blocking -gt 0 -and -not $DryRun) {
    Write-Host "`n  $blocking blocking issue(s). Fix them and re-run.`n" -ForegroundColor Red
    exit 1
}

foreach ($group in $Catalogue.Keys) {
    if ($Skip -contains $group) { Write-Banner "$group (skipped)"; continue }
    Write-Banner $group
    foreach ($pkg in $Catalogue[$group]) { Install-Package -Pkg $pkg }
}

$rebootNeeded = $false
if (-not $SkipWsl) {
    $rebootNeeded = Install-Wsl
    if (-not $rebootNeeded) { Invoke-WslBootstrap }
} else {
    Write-Banner 'WSL (skipped)'
    Write-Note 'The mail stack cannot run without WSL2. The environment is incomplete.'
}

if (-not $rebootNeeded) {
    Write-Banner 'Post-install'
    Install-Pnpm
    Install-VsCodeExtensions
}

Show-Report -RebootNeeded $rebootNeeded
Write-Host ''
