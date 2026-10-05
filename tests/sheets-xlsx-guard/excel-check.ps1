# ============================================================================
#  A workbook written by Sheets, opened in REAL Excel.
#
#  Mr. Singh, 1 Oct 2026 (PR 342): "a file that passes our reader and breaks
#  in Excel is a file nobody will trust." Until now the .xlsx had only ever
#  been read back by our own reader.
#
#  For every ours--*.xlsx in the folder (tests/sheets-xlsx-guard/make-ours.ts
#  writes them, with what OUR engine says each cell is beside them):
#
#    opens     Excel opens it, without repairing it
#    inert     no VBA project, no links to other files, no data connections
#    agrees    Excel RECALCULATES every formula itself, and its answer is
#              compared with our engine's, cell by cell
#    text      a formula our writer stored as text (it calls out) is text
#              in Excel too, not a formula
#
#  Excel is started hidden, with macros FORCED OFF and link updating off,
#  and the file is opened read-only. Nothing is saved.
#
#  THE CONTROL: a copy with one sheet cut short must NOT pass "opens". If
#  it does, this script cannot tell a broken file from a good one.
#
#  Needs Excel on the machine, so it is never in CI. Run by hand:
#      pwsh tests/sheets-xlsx-guard/excel-check.ps1 <folder>
#  Exit: 0 all passed, 1 otherwise.
# ============================================================================
param([Parameter(Mandatory)][string]$Folder)

$ErrorActionPreference = 'Stop'
$passed = 0; $failed = 0
function Ok([string]$what, [bool]$good, [string]$detail = '') {
    if ($good) { $script:passed++; "    ok  $what" }
    else { $script:failed++; "  FAIL  $what"; if ($detail) { "          $detail" } }
}

$errors = @{ -2146826281 = '#DIV/0!'; -2146826246 = '#N/A'; -2146826259 = '#NAME?'; -2146826288 = '#NULL!'
             -2146826252 = '#NUM!'; -2146826265 = '#REF!'; -2146826273 = '#VALUE!' }

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
$xl.AutomationSecurity = 3      # msoAutomationSecurityForceDisable: no macro runs, whatever the file holds
$xl.AskToUpdateLinks = $false
""
"  Sheets' workbooks in real Excel ($($xl.Version), build $($xl.Build))"
"  ==================================================="

function Open-Book([string]$path) {
    # UpdateLinks 0 = never; ReadOnly. (Passing the later arguments as
    # "missing" failed for EVERY file, the control included - which made
    # the control pass for the wrong reason. Two arguments, and the control
    # now has to fail with Excel's own words about the file.)
    return $xl.Workbooks.Open($path, 0, $true)
}

try {
    # ---- the control ---------------------------------------------------------
    $control = Join-Path $Folder 'control--cut-short.xlsx'
    if (Test-Path $control) {
        $opened = $false; $said = ''
        try { $wb = Open-Book $control; $opened = $true; $said = $wb.Name; $wb.Close($false) } catch { $said = $_.Exception.Message }
        ""
        "  Control"
        Ok 'a workbook with a sheet cut short does NOT open cleanly' (-not $opened) "Excel opened it as: $said"
        "        Excel said: $said"
        # The same call must then OPEN a good file, or the refusal above proves nothing.
        $good = Get-ChildItem $Folder -Filter 'ours--*.xlsx' | Select-Object -First 1
        $twin = $false; try { $wb = Open-Book $good.FullName; $twin = $true; $wb.Close($false) } catch { $said = $_.Exception.Message }
        Ok 'the same call opens a good workbook' $twin $said
    } else {
        Ok 'the control file is there' $false "missing: $control"
    }

    foreach ($file in Get-ChildItem $Folder -Filter 'ours--*.xlsx' | Sort-Object Name) {
        ""
        "  $($file.Name)"
        $want = Get-Content ($file.FullName -replace '\.xlsx$', '.expected.json') -Raw | ConvertFrom-Json -AsHashtable
        $wb = $null
        try { $wb = Open-Book $file.FullName } catch { Ok 'opens in Excel without repair' $false $_.Exception.Message; continue }
        try {
            Ok 'opens in Excel without repair' ($wb.Name -eq $file.Name) "Excel calls it: $($wb.Name)"
            $links = $wb.LinkSources(1)
            Ok 'no VBA project, no links to other files, no data connections' `
                ((-not $wb.HasVBProject) -and ($null -eq $links) -and ($wb.Connections.Count -eq 0)) `
                "VBA $($wb.HasVBProject), links $($links -join ','), connections $($wb.Connections.Count)"
            $names = @($wb.Worksheets | ForEach-Object { $_.Name })
            Ok "its sheets are $($want.Keys -join ', ')" (-not (Compare-Object $names @($want.Keys))) "Excel has: $($names -join ', ')"

            $xl.CalculateFullRebuild()   # Excel's own arithmetic, not a stored answer

            $cells = 0; $formulas = 0; $skipped = 0; $texts = 0; $wrong = @()
            foreach ($sheet in $want.Keys) {
                $ws = $wb.Worksheets.Item($sheet)
                foreach ($a1 in $want[$sheet].Keys) {
                    $w = $want[$sheet][$a1]
                    $cell = $ws.Range($a1)
                    $got = $cell.Value2
                    $cells++
                    if ($w.ContainsKey('text')) {
                        $texts++
                        if ($cell.HasFormula -or $got -ne $w.text) { $wrong += "$sheet!$a1 should be the TEXT $($w.text); Excel has formula=$($cell.HasFormula) value=$got" }
                        continue
                    }
                    if ($w.ContainsKey('formula')) {
                        $formulas++
                        if (-not $cell.HasFormula) { $wrong += "$sheet!$a1 is not a formula in Excel (ours: $($w.formula))"; continue }
                        if ($w.formula -match '(?i)\b(TODAY|NOW|RAND|RANDBETWEEN)\s*\(') { $skipped++; continue }
                    }
                    if ($w.ContainsKey('error')) {
                        $code = if ($got -is [int]) { $errors[$got] } else { "$got" }
                        if ($code -ne $w.error) { $wrong += "$sheet!$a1 ours $($w.error), Excel $code" }
                        continue
                    }
                    $v = $w.value
                    $same = if ($v -is [string]) { "$got" -ceq $v }
                            elseif ($v -is [bool]) { $got -eq $v }
                            elseif ($null -eq $v) { $null -eq $got -or "$got" -eq '' }
                            elseif ($got -is [int] -and $errors.ContainsKey($got)) { $false }
                            elseif (($got -is [double] -or $got -is [int]) -and ($v -is [double] -or $v -is [int] -or $v -is [long] -or $v -is [decimal])) {
                                [Math]::Abs([double]$got - [double]$v) -le 1e-9 * [Math]::Max(1, [Math]::Abs([double]$v)) }
                            else { $false }   # different kinds of thing: a mismatch, said below
                    if (-not $same) {
                        $shown = if ($got -is [int] -and $errors.ContainsKey($got)) { $errors[$got] } else { $got }
                        $wrong += "$sheet!$a1 ours [$v], Excel [$shown]$(if ($w.ContainsKey('formula')) { "   $($w.formula)" })"
                    }
                }
            }
            Ok "$cells cells, $formulas formulas recalculated by Excel: every answer agrees with ours$(if ($skipped) { " ($skipped that depend on today's date not compared)" })" `
                ($wrong.Count -eq 0 -and $cells -gt 0) (($wrong | Select-Object -First 8) -join "`n          ")
            if ($texts -gt 0) { "        ($texts formulas our writer stores as text are text in Excel)" }
        } finally {
            $wb.Close($false)
        }
    }
} finally {
    # Quit, and let go of every reference: a hidden Excel left running
    # holds the files open and is invisible to the person at the laptop.
    $wb = $null; $ws = $null; $cell = $null; $links = $null
    $xl.Quit()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($xl)
    $xl = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
}

""
"  $passed passed, $failed failed"
exit ($failed -eq 0 ? 0 : 1)
