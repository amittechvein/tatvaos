# =============================================================================
#  setup-lanes.ps1 - give every lane its own working directory
# =============================================================================
#
#  One machine, four lanes, ONE checkout was the cause of twelve incidents:
#  work committed to another lane's branch, a fix pushed onto a feature branch
#  and lost, and on 19 August an hour of production downtime.
#
#  A git worktree is a second working directory backed by the same repository.
#  It has its OWN HEAD and its OWN index, which is exactly what was missing -
#  four people were sharing one of each.
#
#  Run this ONCE, from the existing checkout:
#      cd C:\Users\amitd\Downloads\tatvaOS
#      powershell -ExecutionPolicy Bypass -File infra\scripts\setup-lanes.ps1
#
#  It is safe to run again: existing worktrees are reported and skipped.
#  ASCII ONLY IN THIS FILE. Windows PowerShell 5.1 reads a script saved as
#  UTF-8 WITHOUT a BOM using the system ANSI code page, so any multi-byte
#  character arrives mangled - and a mangled byte inside a quoted string ends
#  it in the wrong place. The symptom is a parse error pointing at a line with
#  nothing wrong on it ("unterminated string"). Do not put an em dash, a smart
#  quote or an arrow in here.
# =============================================================================

$ErrorActionPreference = 'Stop'

$Root   = 'C:\Users\amitd\Downloads\tatvaOS'
$Parent = Split-Path $Root -Parent

# Siblings, not subfolders, and short names on purpose. Windows still has a
# 260-character path limit in enough places to matter, and node_modules inside
# a deeply nested worktree is how you meet it.
$Lanes = @(
    @{ Name = 'core';    Dir = "$Parent\tatvaos-core";    Branch = 'lane/core'    },
    @{ Name = 'mail';    Dir = "$Parent\tatvaos-mail";    Branch = 'lane/mail'    },
    @{ Name = 'space';   Dir = "$Parent\tatvaos-space";   Branch = 'lane/space'   },
    @{ Name = 'connect'; Dir = "$Parent\tatvaos-connect"; Branch = 'lane/connect' }
)

function Step($m) { Write-Host ""; Write-Host ">> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   [ ok ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   [warn] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "   [FAIL] $m" -ForegroundColor Red }

Set-Location $Root

# -----------------------------------------------------------------------------
Step "Checking the integration tree is clean"

$dirty = git status --porcelain
if ($dirty) {
    Bad "There are uncommitted changes in $Root."
    Write-Host ""
    Write-Host $dirty
    Write-Host ""
    Write-Host "  Commit them to a branch, or stash them, before splitting the tree."
    Write-Host "  Do NOT run 'git add -A' - check whose work each file is first."
    exit 1
}
Ok "working tree is clean"

git fetch --all --quiet
Ok "fetched"

# -----------------------------------------------------------------------------
Step "Putting the integration tree on main"

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
    git checkout main
    Ok "moved $Root from '$branch' to main"
} else {
    Ok "already on main"
}

# -----------------------------------------------------------------------------
Step "Creating a worktree for each lane"

foreach ($lane in $Lanes) {
    $dir    = $lane.Dir
    $br     = $lane.Branch

    if (Test-Path $dir) {
        Warn "$dir already exists - skipping"
        continue
    }

    # A branch may only be checked out in ONE worktree at a time. That is a
    # feature: it makes "two lanes on the same branch" impossible rather than
    # merely discouraged.
    $exists = git show-ref --verify --quiet "refs/heads/$br"; $existsCode = $LASTEXITCODE
    if ($existsCode -eq 0) {
        git worktree add $dir $br | Out-Null
    } else {
        git worktree add -b $br $dir main | Out-Null
    }
    Ok "$($lane.Name.PadRight(8)) -> $dir  (on $br)"
}

# -----------------------------------------------------------------------------
Step "Where things stand"

git worktree list

Write-Host ""
Write-Host "  Next, once per lane folder (each needs its own node_modules):" -ForegroundColor White
Write-Host "      cd <lane folder>"
Write-Host "      pnpm install"
Write-Host ""
Write-Host "  pnpm keeps one content-addressed store and hard-links into each" -ForegroundColor DarkGray
Write-Host "  folder, so four copies cost far less disk than four downloads." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  RULES - read docs/WORKING_IN_LANES.md" -ForegroundColor Yellow
Write-Host "    1. $Root is for integration and reading. Never commit there."
Write-Host "    2. Work only in your own lane folder."
Write-Host "    3. Feature branches come off your lane branch."
Write-Host "    4. Never 'git add -A'. Name the paths."
Write-Host "    5. Only ONE lane runs the local docker stack at a time."
Write-Host ""
