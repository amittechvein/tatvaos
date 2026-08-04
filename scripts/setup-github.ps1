<#
.SYNOPSIS
    Push the repo to GitHub and wire up CI/CD.

.DESCRIPTION
    Does the parts that can be automated and walks you through the rest.

      1. Safety scan - refuses to push if a secret would go up
      2. Creates a PRIVATE repo and pushes
      3. Generates a dedicated deploy SSH key
      4. Sets the four Actions secrets
      5. Tells you the two things only you can do in the browser

    Safe to re-run. Skips anything already done.

.EXAMPLE
    .\scripts\setup-github.ps1
    .\scripts\setup-github.ps1 -RepoName tatvaos -ServerHost 172.105.57.198
#>

[CmdletBinding()]
param(
    [string]$RepoName   = 'tatvaos',
    [string]$ServerHost = '172.105.57.198',
    [string]$DeployUser = 'deploy',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path $PSScriptRoot -Parent

function Head { param($t)
    Write-Host ''
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('-' * 70) -ForegroundColor DarkCyan
}
function Ok   { param($m) Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Skip { param($m) Write-Host "  [have] $m" -ForegroundColor DarkGray }
function Warn { param($m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Bad  { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Note { param($m) Write-Host "         $m" -ForegroundColor DarkGray }

Set-Location $Root
Write-Host "`n  TatvaOS - GitHub setup`n" -ForegroundColor Cyan

# ===========================================================================
Head '1/6  Safety scan'
# ---------------------------------------------------------------------------
#  A secret pushed to GitHub is in the history forever. Rewriting it out is
#  possible and unpleasant, and the credential must be rotated regardless.
#  Cheaper to check first.
# ---------------------------------------------------------------------------

$blocked = $false

# The DKIM private key signs mail as every customer domain. If it leaks,
# anyone can forge mail from any tenant.
$dkimIgnored = (git check-ignore infra/dkim/tv2026a.key 2>$null)
if ($dkimIgnored) { Ok 'DKIM private key is gitignored' }
else { Bad 'DKIM PRIVATE KEY IS NOT IGNORED - stopping'; $blocked = $true }

$envFiles = @(git ls-files --cached --others --exclude-standard 2>$null |
              Where-Object { $_ -match '(^|/)\.env$' })
if ($envFiles) {
    Bad "A real .env would be pushed:"
    $envFiles | ForEach-Object { Note $_ }
    $blocked = $true
} else {
    Ok 'no .env files staged (only .example)'
}

$keyFiles = @(git ls-files --cached --others --exclude-standard 2>$null |
              Where-Object { $_ -match '\.(key|pem|p8|pfx|jks|keystore)$' })
if ($keyFiles) {
    Bad "Key material would be pushed:"
    $keyFiles | ForEach-Object { Note $_ }
    $blocked = $true
} else {
    Ok 'no key material staged'
}

if ($blocked) {
    Write-Host "`n  Fix the above before pushing. Nothing has been sent.`n" -ForegroundColor Red
    exit 1
}

# ===========================================================================
Head '2/6  GitHub CLI'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Bad 'gh not found'
    Note 'winget install --id GitHub.cli --exact'
    exit 1
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Warn 'Not signed in to GitHub'
    Note 'A browser window will open.'
    if (-not $DryRun) {
        gh auth login --hostname github.com --git-protocol https --web
        gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Bad 'sign-in did not complete'; exit 1 }
    }
}
$account = (gh api user --jq .login 2>$null)
Ok "signed in as $account"

# ===========================================================================
Head '3/6  Commit and push'

$dirty = @(git status --porcelain 2>$null)
if ($dirty.Count -gt 0) {
    Note "$($dirty.Count) uncommitted change(s)"
    if (-not $DryRun) {
        git add -A
        git commit -m "feat(core): TatvaOS Core schema, cloud environments, CI/CD" | Out-Null
        Ok 'committed'
    }
} else {
    Skip 'working tree clean'
}

$hasRemote = (git remote get-url origin 2>$null)
if ($hasRemote) {
    Skip "remote already set: $hasRemote"
} elseif (-not $DryRun) {
    # PRIVATE. The repo holds infrastructure config, deployment procedures and
    # the product itself. Nothing here belongs in public.
    gh repo create $RepoName --private --source=. --remote=origin --push
    if ($LASTEXITCODE -eq 0) { Ok "created and pushed $account/$RepoName (private)" }
    else { Bad 'repo creation failed'; exit 1 }
}

if ($hasRemote -and -not $DryRun) {
    git push -u origin main 2>&1 | Select-Object -Last 2 | ForEach-Object { Note $_ }
    Ok 'pushed'
}

# ===========================================================================
Head '4/6  Deploy SSH key'
# ---------------------------------------------------------------------------
#  A dedicated key, not your personal one. If CI is ever compromised you
#  revoke this key alone, and it reaches only the deploy user.
# ---------------------------------------------------------------------------

$keyPath = Join-Path $env:USERPROFILE '.ssh\tatvaos_deploy'

if (Test-Path $keyPath) {
    Skip "deploy key exists at $keyPath"
} elseif (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keyPath) | Out-Null
    ssh-keygen -t ed25519 -C 'github-actions-deploy' -f $keyPath -N '""' 2>&1 | Out-Null
    if (Test-Path $keyPath) { Ok "generated $keyPath" } else { Bad 'ssh-keygen failed'; exit 1 }
}

if (Test-Path "$keyPath.pub") {
    Write-Host ''
    Note 'Add this PUBLIC key to the server:'
    Write-Host ''
    Write-Host (Get-Content "$keyPath.pub") -ForegroundColor White
    Write-Host ''
    Note "ssh root@$ServerHost"
    Note "  mkdir -p /home/$DeployUser/.ssh"
    Note "  nano /home/$DeployUser/.ssh/authorized_keys     # paste it"
    Note "  chmod 700 /home/$DeployUser/.ssh && chmod 600 /home/$DeployUser/.ssh/authorized_keys"
    Note "  chown -R ${DeployUser}:${DeployUser} /home/$DeployUser/.ssh"
}

# ===========================================================================
Head '5/6  Actions secrets'

if (-not $DryRun) {
    $secrets = @{
        TESTING_HOST    = $ServerHost
        PRODUCTION_HOST = $ServerHost
        DEPLOY_USER     = $DeployUser
    }

    foreach ($k in $secrets.Keys) {
        $secrets[$k] | gh secret set $k 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok "$k" } else { Bad "$k" }
    }

    if (Test-Path $keyPath) {
        Get-Content $keyPath -Raw | gh secret set DEPLOY_SSH_KEY 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'DEPLOY_SSH_KEY' } else { Bad 'DEPLOY_SSH_KEY' }
    }
}

# ===========================================================================
Head '6/6  Two things only you can do'

Write-Host @"

  A. Require approval for production deploys
  ------------------------------------------
     https://github.com/$account/$RepoName/settings/environments

     New environment -> name it 'production'
     Tick 'Required reviewers' -> add yourself -> Save

     The typed 'production' confirmation in the workflow is a speed bump.
     This is a second deliberate act, and it is what stops a 2am deploy
     that felt reasonable at the time.

     Add a second environment named 'testing' with no reviewers - that one
     should deploy itself.

  B. Check the first CI run
  -------------------------
     https://github.com/$account/$RepoName/actions

     Four jobs: frontend, backend, isolation, mail-stack.
     The isolation job is the one that matters - it runs against a real
     PostgreSQL and blocks the merge if one tenant can see another's data.

"@ -ForegroundColor Gray

Write-Host ('-' * 70) -ForegroundColor Cyan
Write-Host @"
  Next, on the server:

    ssh root@$ServerHost
    adduser --disabled-password --gecos "" $DeployUser
    usermod -aG docker $DeployUser
    mkdir -p /srv/tatvaos-testing && chown ${DeployUser}:${DeployUser} /srv/tatvaos-testing
    su - $DeployUser
    git clone https://github.com/$account/$RepoName /srv/tatvaos-testing
    cd /srv/tatvaos-testing
    cp infra/docker/.env.testing.example infra/docker/.env
    nano infra/docker/.env          # replace every CHANGE_ME
    echo testing > .environment
    ./infra/scripts/deploy.sh testing

  Generate each secret with:  openssl rand -base64 32

"@ -ForegroundColor Gray
