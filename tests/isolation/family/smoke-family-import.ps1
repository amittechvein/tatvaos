<#
    Import and export smoke test.

    ─────────────────────────────────────────────────────────────────────────
     WHAT THIS IS ACTUALLY FOR.

     The parsing is unit-testable in principle and is not tested here. What
     cannot be checked by reading the code is whether EF can translate the
     bulk duplicate lookup — `keys.Contains(e.EmailNormalised)` against a
     citext column — into SQL Npgsql will accept. That throws at request time,
     not at build time, and it is the single most likely thing to be wrong on
     the first real import.

     The strongest assertion here is the round trip: import a file, export it
     back, re-import the export as a dry run, and insist that NOTHING is new.
     If normalisation, labelling, primary-address ordering or the CSV writer
     disagree with the reader by even a little, that number is not zero.
    ─────────────────────────────────────────────────────────────────────────

    Usage, with the API running:

        .\tests\isolation\family\smoke-family-import.ps1 `
            -Email admin@techvein.in -Password "your-bootstrap-password"

    It creates four contacts and one label, then soft-deletes them and removes
    the label. Soft-deleted rows stay in the Bin, the same as the other smoke
    test — that is what makes the audit trail survive.
#>

param(
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$Password,
    [string]$BaseUrl = "http://localhost:5000"
)

$ErrorActionPreference = 'Stop'
$pass = 0; $fail = 0

function Try-Step {
    param([string]$Name, [scriptblock]$Body)
    Write-Host -NoNewline ("  {0,-52}" -f $Name)
    try {
        $r = & $Body
        Write-Host "OK" -ForegroundColor Green
        $script:pass++
        return $r
    } catch {
        Write-Host "FAILED" -ForegroundColor Red
        $script:fail++
        $msg = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
        Write-Host "      $msg" -ForegroundColor DarkYellow
        return $null
    }
}

function Api {
    param([string]$Method, [string]$Path, $Body)
    $a = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $script:H; ContentType = 'application/json' }
    if ($Body) { $a.Body = ($Body | ConvertTo-Json -Depth 6) }
    Invoke-RestMethod @a
}

# The file goes up as a raw body rather than a multipart form. Both are
# accepted, and -InFile works on Windows PowerShell 5.1 where -Form does not.
function Upload {
    param([string]$Path, [string]$Query, [string]$Name)
    $h = $script:H.Clone()
    $h['X-File-Name'] = $Name
    Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/family/contacts/import?$Query" `
        -Headers $h -ContentType 'text/csv' -InFile $Path
}

Write-Host "`nFamily import/export smoke test against $BaseUrl`n" -ForegroundColor Cyan

# ---- Sign in -------------------------------------------------------------
try {
    $auth = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" `
        -ContentType 'application/json' `
        -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
} catch {
    Write-Host "Sign-in failed. Run smoke-family.ps1 first - it explains why." -ForegroundColor Red
    exit 1
}
$script:H = @{ Authorization = "Bearer $($auth.accessToken)" }
Write-Host "Signed in as $Email`n" -ForegroundColor DarkGray

$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$label = "Smoke Import $stamp"

# ---------------------------------------------------------------------------
#  A deliberately awkward file.
#
#   - old Google column names (Given Name / Family Name / Group Membership)
#   - a quoted cell holding a comma AND a newline
#   - Google's ::: multi-value separator
#   - two rows that are one person once Gmail's dots and +tag are folded
#   - a row with no name, no company and no address
#   - a display name that a spreadsheet would treat as a formula
# ---------------------------------------------------------------------------
$csv = @'
Name,Given Name,Family Name,Organization Name,Organization Title,Notes,Group Membership,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value
Priya Sharma,Priya,Sharma,Acme Trading,Buyer,"Met at the Delhi fair, stand 14.
Prefers a call.",* myContacts ::: Suppliers,* Work,priya.sharma@example.com,* Mobile,+91 98765 43210
Anil Kumar,Anil,Kumar,Kumar Logistics,Owner,,* myContacts,* Work,anil@example.com ::: anil.k@example.com,* Work,022 2345 6789
Ravi G,Ravi,G,,,,,* Home,r.a.v.i@gmail.com,,
Ravi Gupta,Ravi,Gupta,,,,,* Home,ravi+work@gmail.com,,
,,,,,No name and no address at all,,,,* Mobile,99999 11111
=Danger Name,,,Formula Co,,,,* Work,danger@example.com,,
'@

$file = Join-Path $env:TEMP "tatvaos-smoke-$stamp.csv"
# Written WITH a byte-order mark on purpose: that is what Google's export has,
# and a BOM left on the first header cell stops "Name" matching.
[System.IO.File]::WriteAllText($file, $csv, [System.Text.UTF8Encoding]::new($true))
Write-Host "Test file: $file" -ForegroundColor DarkGray

$query = "ownership=personal&mode=skip&createLabels=false&label=$([uri]::EscapeDataString($label))"

# ---------------------------------------------------------------------------
Write-Host "`nDry run  (writes nothing; exercises the bulk duplicate lookup)"

$dry = Try-Step "POST /contacts/import?dryRun=true" {
    Upload -Path $file -Query "$query&dryRun=true" -Name "smoke.csv"
}

Try-Step "  reads 6 rows" {
    if ($dry.rowsRead -ne 6) { throw "rowsRead was $($dry.rowsRead), expected 6" }; "6"
}
Try-Step "  would add 4" {
    if ($dry.created -ne 4) { throw "created was $($dry.created), expected 4" }; "4"
}
Try-Step "  would skip 2  (Gmail fold + the nameless row)" {
    if ($dry.skipped -ne 2) { throw "skipped was $($dry.skipped), expected 2" }; "2"
}
Try-Step "  every skipped row carries a reason" {
    foreach ($p in $dry.problems) {
        if (-not $p.reason) { throw "row $($p.row) was skipped with no reason" }
    }
    "$($dry.problems.Count) reasons"
}
Try-Step "  nothing was written" {
    # A 404 from /lookup is the pass here, and Invoke-RestMethod treats it as a
    # terminating error, so the absence has to be caught rather than tested.
    $found = $true
    try { Api GET "/api/family/contacts/lookup?email=priya.sharma@example.com" | Out-Null }
    catch { $found = $false }
    if ($found) { throw "the dry run created a contact" }
    "clean"
}

# ---------------------------------------------------------------------------
Write-Host "`nReal import"

$real = Try-Step "POST /contacts/import" { Upload -Path $file -Query $query -Name "smoke.csv" }
Try-Step "  added 4" {
    if ($real.created -ne 4) { throw "created was $($real.created), expected 4" }; "4"
}
Try-Step "  the tag label was created" {
    $g = (Api GET "/api/family/groups") | Where-Object { $_.name -eq $label }
    if (-not $g) { throw "no group named $label" }
    $script:groupId = $g.id
    $g.id
}
Try-Step "  the file's own labels were NOT created (createLabels=false)" {
    $g = (Api GET "/api/family/groups") | Where-Object { $_.name -eq 'Suppliers' }
    if ($g) { throw "Suppliers was created despite createLabels=false" }
    "correct"
}
Try-Step "  the multi-line note survived" {
    $c = Api GET "/api/family/contacts/lookup?email=priya.sharma@example.com"
    $d = Api GET "/api/family/contacts/$($c.id)"
    if ($d.notes -notmatch 'Delhi fair, stand 14') { throw "the quoted cell did not round-trip" }
    if ($d.notes -notmatch 'Prefers a call')       { throw "the embedded newline was lost" }
    "intact"
}
Try-Step "  the ::: second address landed" {
    $c = Api GET "/api/family/contacts/lookup?email=anil.k@example.com"
    if (-not $c) { throw "anil.k@example.com was not saved" }
    $c.displayName
}
Try-Step "  source is 'import'" {
    $c = Api GET "/api/family/contacts/lookup?email=danger@example.com"
    if ($c.source -ne 'import') { throw "source was $($c.source)" }
    "import"
}

# ---------------------------------------------------------------------------
Write-Host "`nExport"

$out = Try-Step "GET  /contacts/export?format=csv" {
    Invoke-RestMethod -Method GET -Headers $script:H `
        -Uri "$BaseUrl/api/family/contacts/export?format=csv&groupId=$($script:groupId)"
}
Try-Step "  holds all four" {
    foreach ($n in @('Priya Sharma', 'Anil Kumar', 'Ravi G', 'Danger Name')) {
        if ($out -notmatch [regex]::Escape($n)) { throw "$n is missing from the export" }
    }
    "4"
}
Try-Step "  the formula name is defused" {
    if ($out -notmatch "'=Danger Name") { throw "a name starting with = was exported unguarded" }
    "guarded"
}
Try-Step "  the phone number kept its plus" {
    if ($out -notmatch '\+91 98765 43210') { throw "the leading + was mangled" }
    "+91 …"
}

$vcf = Try-Step "GET  /contacts/export?format=vcf" {
    Invoke-RestMethod -Method GET -Headers $script:H `
        -Uri "$BaseUrl/api/family/contacts/export?format=vcf&groupId=$($script:groupId)"
}
Try-Step "  four cards, each closed" {
    $begin = ([regex]::Matches($vcf, 'BEGIN:VCARD')).Count
    $end   = ([regex]::Matches($vcf, 'END:VCARD')).Count
    if ($begin -ne 4 -or $end -ne 4) { throw "$begin BEGIN and $end END, expected 4 and 4" }
    "4"
}

# ---------------------------------------------------------------------------
Write-Host "`nRound trip  (the real assertion)"

$back = Join-Path $env:TEMP "tatvaos-smoke-back-$stamp.csv"
[System.IO.File]::WriteAllText($back, $out, [System.Text.UTF8Encoding]::new($true))

$again = Try-Step "re-import the export as a dry run" {
    Upload -Path $back -Query "$query&dryRun=true" -Name "back.csv"
}
Try-Step "  nothing is new" {
    if ($again.created -ne 0) {
        $names = ($again.sample -join '; ')
        throw "$($again.created) would be created again: $names"
    }
    "0"
}
Try-Step "  all four recognised as already saved" {
    if ($again.skipped -ne 4) { throw "skipped was $($again.skipped), expected 4" }; "4"
}

# ---------------------------------------------------------------------------
Write-Host "`nCleanup"

Try-Step "delete the four contacts" {
    $page = Api GET "/api/family/contacts?groupId=$($script:groupId)&pageSize=200"
    foreach ($c in $page.items) { Api DELETE "/api/family/contacts/$($c.id)" | Out-Null }
    "$($page.items.Count) deleted"
}
Try-Step "delete the label" { Api DELETE "/api/family/groups/$($script:groupId)"; "gone" }
Try-Step "remove the temp files" {
    Remove-Item $file, $back -ErrorAction SilentlyContinue
    "done"
}

# ---------------------------------------------------------------------------
Write-Host ""
if ($fail -eq 0) {
    Write-Host "$pass passed, 0 failed." -ForegroundColor Green
    exit 0
}
Write-Host "$pass passed, $fail FAILED." -ForegroundColor Red
Write-Host "The soft-deleted contacts are in the Bin if you need to look at them." -ForegroundColor DarkYellow
exit 1
