# =============================================================================
#  lane-overlap.ps1 - which files two different lanes are both editing
# =============================================================================
#
#  Run this BEFORE any merge into main.
#
#  ASCII ONLY IN THIS FILE - see setup-lanes.ps1 for why. PowerShell 5.1 reads
#  a UTF-8 file with no BOM as ANSI and one em dash becomes an unterminated
#  string on a line with nothing wrong with it.
#
#  ---------------------------------------------------------------------------
#  WHAT THIS EXISTS FOR, AND WHAT IT CANNOT DO
#
#  On 19 August, Space and Core independently added a client wrapper for the
#  same endpoint to the same file - settingsApi and spaceSettingsApi in
#  lib/space.ts. The two branches MERGED CLEANLY. Git put both in the file:
#  two exported clients for one endpoint, one of them on a trailing-slash
#  path, and no conflict marker anywhere to make a human look.
#
#  A conflict stops somebody. A clean merge that produces a duplicate stops
#  nobody. That is the failure this script is aimed at, and the whole
#  signature of that failure is that git says nothing at all.
#
#  So: this tells you WHERE TO LOOK, never what is wrong. It cannot read the
#  file and it cannot tell a duplicate from two unrelated edits. A name on
#  this list means one thing - open it after merging and read it. That
#  reading is the actual control; this is only the pointer.
#
#  Suggested by the Space developer, whose branch was one of the two.
#  ---------------------------------------------------------------------------

# NOT 'Stop'. Under Stop, PowerShell 5.1 turns ANY stderr output from a native
# command into a terminating NativeCommandError - even a harmless one, and even
# with 2>$null, which does not suppress it. On this script's first real run git
# printed "warning: multiple merge bases" for an archived branch and the whole
# thing died on a line that had done nothing wrong.
#
# git tells us success through its EXIT CODE. Its stderr is commentary.
$ErrorActionPreference = 'Continue'

function Step($m) { Write-Host ""; Write-Host ">> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   [ ok ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   [warn] $m" -ForegroundColor Yellow }

# Run git and hand back only stdout. Stderr is dropped on purpose - see above.
function GitOut {
    $out = & git @args 2>$null
    if ($null -eq $out) { return @() }
    return @($out)
}

# Which lane owns a branch, by its name. feature/mail-away is Mail's,
# lane/space is Space's. Anything that does not match is reported as its own
# lane rather than guessed at - a branch nobody can attribute is worth seeing.
function LaneOf($branch) {
    $n = $branch -replace '^origin/', ''
    if ($n -match '^(feature|fix|chore)/(mail|space|connect|core)-') { return $Matches[2] }
    if ($n -match '^lane/(mail|space|connect|core)$')                { return $Matches[1] }
    return "unattributed:$n"
}

Step "Fetching"
GitOut fetch --all --prune --quiet | Out-Null
Ok "fetched"

# Every remote branch that is not main, and is not already merged. An already
# merged branch cannot collide with anything - it IS main.
# archive/* is, by definition, not active work. Scanning it produces noise and
# - because those branches have diverged far enough to have several merge bases
# - the warnings git emits about them are what killed the first run.
$branches = @(GitOut branch -r --no-merged origin/main |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -notmatch 'HEAD' -and $_ -ne 'origin/main' -and $_ -notmatch '^origin/archive/' })

if ($branches.Count -eq 0) {
    Ok "no unmerged branches - nothing can collide"
    exit 0
}

Step "Unmerged branches"
foreach ($b in $branches) {
    Write-Host ("   {0,-46} {1}" -f $b, (LaneOf $b))
}

# file -> set of lanes touching it
$touched = @{}
foreach ($b in $branches) {
    $lane = LaneOf $b
    $files = GitOut diff --name-only "origin/main...$b"
    foreach ($f in $files) {
        if (-not $f) { continue }
        if (-not $touched.ContainsKey($f)) { $touched[$f] = @{} }
        if (-not $touched[$f].ContainsKey($lane)) { $touched[$f][$lane] = @() }
        $touched[$f][$lane] += $b
    }
}

# Only CROSS-lane overlap is a signal. Two branches of your own touching one
# of your own files is ordinary work.
$overlaps = $touched.Keys | Where-Object { $touched[$_].Keys.Count -gt 1 } | Sort-Object

Step "Files more than one lane is editing"

if (-not $overlaps) {
    Ok "none - no two lanes are touching the same file"
    Write-Host ""
    exit 0
}

foreach ($f in $overlaps) {
    Warn $f
    foreach ($lane in ($touched[$f].Keys | Sort-Object)) {
        Write-Host ("          {0,-10} {1}" -f $lane, ($touched[$f][$lane] -join ', ')) -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "  These merge cleanly more often than they conflict." -ForegroundColor Yellow
Write-Host "  Open each one AFTER merging and read it. Look for two things"    -ForegroundColor Yellow
Write-Host "  doing one job: two wrappers for an endpoint, two helpers with"   -ForegroundColor Yellow
Write-Host "  different names, the same constant twice."                       -ForegroundColor Yellow
Write-Host ""

# Exit 0 deliberately. This is a pointer, not a gate: making it fail a merge
# would train people to skip it, and most overlaps are entirely fine.
exit 0
