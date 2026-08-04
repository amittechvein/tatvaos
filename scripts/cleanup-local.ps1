<#
.SYNOPSIS
    Remove local tooling that the cloud workflow makes unnecessary.

.DESCRIPTION
    Two stages, because the order matters.

      -Stage Now
          Safe today. Nothing here is needed to build TatvaOS Core, and
          nothing here is needed by the cloud pipeline.

      -Stage AfterStaging
          Only once staging is deployed AND verified. These are the tools you
          currently depend on. Removing them before the cloud works leaves you
          with nothing to work on.

    Always shows what it will do and asks before each removal.
    -DryRun to preview.

.EXAMPLE
    .\scripts\cleanup-local.ps1 -Stage Now -DryRun
    .\scripts\cleanup-local.ps1 -Stage Now
    .\scripts\cleanup-local.ps1 -Stage AfterStaging
#>

[CmdletBinding()]
param(
    [ValidateSet('Now','AfterStaging')]
    [string]$Stage = 'Now',

    [switch]$DryRun,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'

function Head { param($t)
    Write-Host ''
    Write-Host ('-' * 74) -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('-' * 74) -ForegroundColor DarkCyan
}
function Ok   { param($m) Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Skip { param($m) Write-Host "  [skip] $m" -ForegroundColor DarkGray }
function Warn { param($m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Note { param($m) Write-Host "         $m" -ForegroundColor DarkGray }

# ===========================================================================
#  What each stage removes, and why it is safe
# ===========================================================================

$Now = @(
    @{ Id='Google.AndroidStudio'; Name='Android Studio'; Size='~12 GB'
       Why='Phase 2, around month 7. Reinstalling later takes an hour and it will be a newer version anyway.' }

    @{ Id='Mozilla.Thunderbird'; Name='Thunderbird'; Size='~200 MB'
       Why='An IMAP test client. Core has no mailboxes to test, and staging serves Roundcube when Mail resumes.' }

    @{ Id='Microsoft.PowerToys'; Name='PowerToys'; Size='~600 MB'
       Why='Convenience only. Never used by the project.' }

    @{ Id='Bruno.Bruno'; Name='Bruno'; Size='~300 MB'
       Why='API client. The OpenAPI page the API serves at /openapi covers the same ground.' }
)

$AfterStaging = @(
    @{ Id='Docker.DockerDesktop'; Name='Docker Desktop'; Size='~4 GB disk, 8 GB RAM'
       Why='Containers run on the Linode. THE significant one on a 16 GB machine.'
       Danger='Local database volumes are destroyed. Back up anything you care about first.' }

    @{ Id='DBeaver.DBeaver.Community'; Name='DBeaver'; Size='~500 MB'
       Why='Adminer on the staging box over an SSH tunnel does the same job.' }

    @{ Id='Cloudflare.cloudflared'; Name='cloudflared'; Size='small'
       Why='Tunnels a public URL to localhost. With no localhost, nothing to tunnel.' }
)

$KeepAlways = @(
    @{ Name='VS Code';           Why='With Remote-SSH this becomes your whole development environment' }
    @{ Name='Git';               Why='Push is now the deploy trigger' }
    @{ Name='Windows Terminal';  Why='You still need a shell' }
    @{ Name='PowerShell 7';      Why='The project scripts assume it' }
    @{ Name='Tailscale';         Why='Reach the servers without exposing SSH. More important now, not less' }
    @{ Name='Bitwarden';         Why='DKIM key and every production secret' }
    @{ Name='GitHub CLI';        Why='Watch CI runs and approve production deploys from the terminal' }
    @{ Name='Firefox';           Why='Second browser. The web client must work outside Chrome' }
    @{ Name='WSL2';              Why='Free once Docker is gone, and gives you real ssh, dig, scp and swaks' }
)

# ===========================================================================
Write-Host @"

  TatvaOS - local cleanup
  Stage: $Stage$(if ($DryRun) { '   [DRY RUN]' })

"@ -ForegroundColor Cyan

# ---------------------------------------------------------------------------
#  Guard. Removing your only working environment before the replacement exists
#  is the mistake this script is written to prevent.
# ---------------------------------------------------------------------------
if ($Stage -eq 'AfterStaging' -and -not $DryRun) {
    Head 'Before removing anything'

    Write-Host @'
  These are the tools you currently depend on. Confirm ALL of the following
  before continuing:

    [ ] Staging is deployed and reachable at https://app-test.tatvaos.com
    [ ] You have signed in to it and it works
    [ ] CI is green on main
    [ ] A deploy has run end to end at least once
    [ ] Anything you need from the local database is backed up

  If any of those is not true, stop. Removing Docker now leaves you with no
  working environment at all.

'@ -ForegroundColor Yellow

    if (-not $Yes) {
        Write-Host '  Type ' -NoNewline
        Write-Host 'staging-works' -NoNewline -ForegroundColor Cyan
        Write-Host ' to continue: ' -NoNewline
        $confirm = Read-Host
        if ($confirm -ne 'staging-works') {
            Write-Host "`n  Nothing removed. Come back once staging is verified.`n" -ForegroundColor Gray
            exit 0
        }
    }

    # Docker volumes hold the seeded tenants and 152 test messages. Losing them
    # is recoverable but annoying, and the warning costs nothing.
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Head 'Local Docker data'
        $vols = docker volume ls --format '{{.Name}}' 2>$null | Where-Object { $_ -match 'tatvaos' }
        if ($vols) {
            Warn "$($vols.Count) local volume(s) will be destroyed:"
            $vols | ForEach-Object { Note $_ }
            Note ''
            Note 'To keep the local database first:'
            Note '  cd local'
            Note '  docker exec tv-postgres pg_dumpall -U postgres > ..\backup-local.sql'
            Note ''
            if (-not $Yes) {
                Write-Host '  Press Enter to continue, Ctrl+C to stop and back up: ' -NoNewline
                Read-Host | Out-Null
            }
        } else {
            Skip 'no TatvaOS volumes found'
        }
    }
}

# ===========================================================================
function Remove-App {
    param([hashtable]$App)

    $installed = $false
    try {
        $out = winget list --id $App.Id --exact --accept-source-agreements 2>$null | Out-String
        $installed = $out -match [regex]::Escape($App.Id)
    } catch { }

    if (-not $installed) {
        Skip "$($App.Name) - not installed"
        return
    }

    Write-Host ''
    Write-Host "  $($App.Name)" -ForegroundColor White -NoNewline
    Write-Host "  ($($App.Size))" -ForegroundColor DarkGray
    Note $App.Why
    if ($App.Danger) { Warn $App.Danger }

    if ($DryRun) {
        Write-Host '  [dry ] would uninstall' -ForegroundColor Magenta
        return
    }

    if (-not $Yes) {
        Write-Host '  Remove it? [y/N] ' -NoNewline -ForegroundColor Cyan
        $a = Read-Host
        if ($a -notmatch '^[Yy]') { Skip 'kept'; return }
    }

    winget uninstall --id $App.Id --exact --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "removed $($App.Name)" }
    else { Bad "$($App.Name) - exit $LASTEXITCODE. Try Settings > Apps." }
}

# ===========================================================================
$list = if ($Stage -eq 'Now') { $Now } else { $AfterStaging }

Head "Stage: $Stage"
foreach ($app in $list) { Remove-App -App $app }

# ===========================================================================
Head 'Keep these - they are the whole environment now'
foreach ($k in $KeepAlways) {
    Write-Host ("  {0,-20}" -f $k.Name) -NoNewline -ForegroundColor White
    Write-Host $k.Why -ForegroundColor DarkGray
}

# ===========================================================================
Head 'Next'

if ($Stage -eq 'Now') {
    Write-Host @'
  Removed what the cloud workflow makes unnecessary today.

  DO NOT run -Stage AfterStaging yet. Those tools are what you are currently
  working with. Deploy staging, verify it, then come back:

    .\scripts\cleanup-local.ps1 -Stage AfterStaging

  Reinstalling anything:
    .\scripts\setup-dev-env.ps1

'@ -ForegroundColor Gray
} else {
    Write-Host @'
  Local development tooling removed. From here:

    Edit      VS Code -> Remote-SSH -> your Linode
    Deploy    git push (CI deploys to testing automatically)
    Database  ssh tunnel, or Adminer on the staging box
    Mail      Roundcube on staging

  If you need a local environment back:
    .\scripts\setup-dev-env.ps1

'@ -ForegroundColor Gray
}
