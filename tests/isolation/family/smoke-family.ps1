<#
    Family API smoke test.

    Compilation proves the C# is well-formed. It proves nothing about whether
    EF can turn these queries into SQL — a LINQ expression the provider cannot
    translate throws at request time, not at build time. This script signs in,
    then hits every route that carries that risk.

    Usage, with the API running:

        .\tests\isolation\family\smoke-family.ps1 `
            -Email admin@techvein.in -Password "your-bootstrap-password"

    It creates one contact named "Smoke Test <random>" and soft-deletes it at
    the end, so it leaves a single deleted row and its audit trail behind.
    Nothing else is written.
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
    Write-Host -NoNewline ("  {0,-48}" -f $Name)
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

Write-Host "`nFamily API smoke test against $BaseUrl`n" -ForegroundColor Cyan

# ---- Sign in -------------------------------------------------------------
try {
    $auth = Invoke-RestMethod -Method POST -Uri "$BaseUrl/api/auth/login" `
        -ContentType 'application/json' `
        -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
} catch {
    # Say what actually happened. A bare "sign-in failed" sends people hunting
    # for a wrong password when the API is simply not running.
    Write-Host "Sign-in failed." -ForegroundColor Red

    $status = $null
    if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }

    if (-not $status) {
        Write-Host "  No HTTP response at all - nothing is listening on $BaseUrl." -ForegroundColor DarkYellow
        Write-Host "  Start the API:  cd apps\api  then  dotnet run" -ForegroundColor DarkYellow
    }
    elseif ($status -eq 401) {
        Write-Host "  401 - the API is running, but this email/password is wrong." -ForegroundColor DarkYellow
        Write-Host "  List the accounts that exist:" -ForegroundColor DarkYellow
        Write-Host "    docker exec tv-postgres psql -U postgres -d tatvaos_mail -c \"SELECT email, role, status FROM core.users;\"" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  HTTP $status" -ForegroundColor DarkYellow
    }

    if ($_.ErrorDetails.Message) { Write-Host "  $($_.ErrorDetails.Message)" -ForegroundColor DarkYellow }
    else { Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkYellow }
    exit 1
}
$script:H = @{ Authorization = "Bearer $($auth.accessToken)" }
Write-Host "Signed in as $Email`n" -ForegroundColor DarkGray

Write-Host "Reads"
Try-Step "GET  /bootstrap"                          { Api GET "/api/family/bootstrap" }
Try-Step "GET  /contacts        (Summary projection)" { Api GET "/api/family/contacts?page=1&pageSize=5" }
Try-Step "GET  /contacts?ownership=personal"        { Api GET "/api/family/contacts?ownership=personal" }
Try-Step "GET  /contacts?favourite=true"            { Api GET "/api/family/contacts?favourite=true" }
Try-Step "GET  /groups"                             { Api GET "/api/family/groups" }
Try-Step "GET  /settings"                           { Api GET "/api/family/settings" }

Write-Host "`nSearch  (the three EF-translation risks)"
Try-Step "GET  /contacts/search       (tsvector Matches)" { Api GET "/api/family/contacts/search?q=test" }
Try-Step "GET  /contacts/autocomplete (ILike prefix)"     { Api GET "/api/family/contacts/autocomplete?q=te" }
Try-Step "GET  /contacts/lookup       (404 is correct)"   {
    try { Api GET "/api/family/contacts/lookup?email=nobody@example.invalid"; throw "expected 404, got a contact" }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { "404" } else { throw } }
}

Write-Host "`nWrites  (RLS WITH CHECK, insert ordering, the audit row)"
$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$created = Try-Step "POST /contacts  (contact+email+phone+audit, one save)" {
    Api POST "/api/family/contacts" @{
        displayName = "Smoke Test $stamp"
        companyName = "Smoke Industries"
        jobTitle    = "Test Subject"
        email       = "smoke$stamp@gmail.com"
        phone       = "+91 98765 43210"
    }
}

if ($created) {
    $id = $created.id
    Try-Step "GET   /contacts/{id}        (three Includes)" { Api GET "/api/family/contacts/$id" }
    Try-Step "PATCH /contacts/{id}"                         { Api PATCH "/api/family/contacts/$id" @{ jobTitle = "Updated"; isFavourite = $true } }
    Try-Step "GET   /contacts/{id}/audit"                   { Api GET "/api/family/contacts/$id/audit" }
    Try-Step "POST  /contacts/{id}/interactions"            { Api POST "/api/family/contacts/$id/interactions" @{ type = "note"; notes = "smoke" } }
    Try-Step "GET   /contacts/{id}/interactions"            { Api GET "/api/family/contacts/$id/interactions" }
    Try-Step "GET   /contacts/search finds it"              {
        $r = Api GET "/api/family/contacts/search?q=Smoke"
        if (-not ($r | Where-Object { $_.id -eq $id })) { throw "the new contact was not returned by search" }
        "found"
    }
    Try-Step "GET   /contacts/lookup finds it"              { Api GET "/api/family/contacts/lookup?email=smoke$stamp@gmail.com" }

    # The whole Gmail normalisation rule, end to end. Dots folded, +tag
    # stripped, so this MUST collide with the address created above.
    Try-Step "POST  duplicate dotted+tagged  (expect 409)"  {
        $dotted = ($stamp.ToCharArray() -join '.')
        try {
            Api POST "/api/family/contacts" @{ displayName = "Dupe"; email = "smoke$dotted+work@gmail.com" }
            throw "DUPLICATE ACCEPTED - normalisation is not matching"
        } catch {
            if ($_.Exception.Response.StatusCode.value__ -eq 409) { "409" } else { throw }
        }
    }

    $g = Try-Step "POST  /groups"                           { Api POST "/api/family/groups" @{ name = "Smoke $stamp"; colour = "#c2410c" } }
    if ($g) {
        Try-Step "PUT   /groups/{g}/members/{id}"           { Api PUT "/api/family/groups/$($g.id)/members/$id" }
        Try-Step "GET   /contacts?groupId= (join filter)"   { Api GET "/api/family/contacts?groupId=$($g.id)" }
        Try-Step "DELETE /groups/{g}"                       { Api DELETE "/api/family/groups/$($g.id)" }
    }

    Try-Step "PUT   /settings"                              { Api PUT "/api/family/settings" @{ autoSaveReceived = $true; autoSaveSent = $false; autoSaveReply = $true } }
    Try-Step "DELETE /contacts/{id}  (soft)"                { Api DELETE "/api/family/contacts/$id" }
    Try-Step "GET   audit survives the delete"              { Api GET "/api/family/contacts/$id/audit" }
    Try-Step "GET   deleted contact is gone from search"    {
        $r = Api GET "/api/family/contacts/search?q=Smoke"
        if ($r | Where-Object { $_.id -eq $id }) { throw "a soft-deleted contact is still in search results" }
        "gone"
    }
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
if ($fail) {
    Write-Host "'could not be translated'  -> an EF/LINQ problem in ContactEndpoints.cs" -ForegroundColor DarkYellow
    Write-Host "'row-level security' / 'permission denied' -> policy and query disagree" -ForegroundColor DarkYellow
    Write-Host ""
    exit 1
}
