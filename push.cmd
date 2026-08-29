@echo off
setlocal enabledelayedexpansion
title TatvaOS - build, commit, push (lane-safe)

REM ============================================================================
REM  REWRITTEN 19 August 2026. The previous version had three lines in it that
REM  between them caused most of the twelve cross-lane incidents, including an
REM  hour of production downtime. They were:
REM
REM    cd /d "C:\Users\amitd\Downloads\tatvaOS"
REM        Hardcoded. Whatever folder you ran it from, it committed in that ONE
REM        tree. It would have defeated the worktree split entirely.
REM
REM    git add -A
REM        Swept every modified file into the commit, including other people's
REM        work in progress. This is how Space's audit work ended up inside a
REM        Mail branch, and how three lanes' changes landed in one commit.
REM
REM    git push origin main
REM        Pushed main REGARDLESS of the branch you had just committed to. Work
REM        committed on a feature branch went nowhere, and looked pushed.
REM
REM  This version stays where you are, commits only what you name, and pushes
REM  the branch you are actually on.
REM ============================================================================

REM ---- Refuse to commit on main ----------------------------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"

if /i "%BRANCH%"=="main" (
    echo.
    echo  ------------------------------------------------------------
    echo   You are on MAIN.
    echo.
    echo   main is integration only. Work happens on a feature branch
    echo   in your own lane folder:
    echo.
    echo       git checkout -b feature/^<lane^>-^<what-it-does^>
    echo.
    echo   Nothing was committed.
    echo  ------------------------------------------------------------
    echo.
    pause
    exit /b 1
)

REM ---- Commit message ---------------------------------------------------------
set "MSG=%~1"
if "%MSG%"=="" set /p MSG=Commit message:
if "%MSG%"=="" (
    echo  A commit message is required. Nothing was committed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo    branch : %BRANCH%
echo    folder : %CD%
echo    message: %MSG%
echo ============================================================

REM ---- 1. Show what is actually staged ----------------------------------------
echo.
echo [1/5] What you are about to commit:
echo.
git diff --cached --stat
git diff --cached --quiet
if not errorlevel 1 (
    echo.
    echo  ------------------------------------------------------------
    echo   NOTHING IS STAGED.
    echo.
    echo   Stage your own files by name first - this script will not
    echo   run 'git add -A' for you, because that is what put other
    echo   people's work into your commits:
    echo.
    echo       git status --short
    echo       git add path\to\file  path\to\other
    echo.
    echo  ------------------------------------------------------------
    echo.
    pause
    exit /b 1
)

REM ---- 1b. Refuse when a staged file has been edited since staging -------------
REM
REM  22 August 2026. A green build shipped a stale commit, and the deploy that
REM  followed failed on the server with an error nobody could see locally.
REM
REM  The mechanism: `git add` takes a SNAPSHOT. The build below compiles the
REM  WORKING TREE. Edit a file after staging it and the two stop being the same
REM  thing — the build tests the good copy, the commit ships the old one, and
REM  every signal you have says it went fine. It has now cost two deploys.
REM
REM  `git diff --name-only`        = working tree vs index (edited since staged)
REM  `git diff --cached --name-only` = index vs HEAD       (staged)
REM
REM  A file in BOTH lists is a file whose staged copy is out of date. That is
REM  the whole bug, and it is two commands.
REM ------------------------------------------------------------------------------
set "DRIFT=0"
for /f "delims=" %%f in ('git diff --name-only') do (
    git diff --cached --name-only | findstr /x /c:"%%f" >nul
    if not errorlevel 1 set "DRIFT=1"
)

if "!DRIFT!"=="1" (
    echo.
    echo  ------------------------------------------------------------
    echo   A STAGED FILE HAS CHANGED ON DISK SINCE YOU STAGED IT.
    echo.
    echo   Committing now would ship the OLDER copy, while the build
    echo   below tests the newer one. Everything would look green and
    echo   the deploy would fail on the server.
    echo.
    echo   Staged from an older version:
    for /f "delims=" %%f in ('git diff --name-only') do (
        git diff --cached --name-only | findstr /x /c:"%%f" >nul
        if not errorlevel 1 echo       %%f
    )
    echo.
    echo   Fix: stage them again, then run this script again.
    echo.
    echo       git add ^<the files listed above^>
    echo.
    echo   Nothing was committed.
    echo  ------------------------------------------------------------
    echo.
    pause
    exit /b 1
)

echo.
echo  Anything NOT staged stays OUT of the commit - but is NOT left
echo  alone: the builds below compile the WHOLE working tree, these
echo  files included. A green build here can depend on a file this
echo  commit will not carry - the server then builds without it.
echo  (Same mechanism as the staleness guard above, other direction.)
git status --short -- . | findstr /b /c:" M" /c:"??"

REM ---- 1c. Untracked SOURCE files - work that exists in no commit --------------
REM
REM  An untracked .cs/.ts/.tsx/.sql is code the builds below will happily
REM  compile and the commit will silently omit. That is the exact shape of
REM  the 28 August rescue: finished work living only in one folder's working
REM  tree, one `reset --hard` away from gone. A warning, not a refusal -
REM  scratch files are legitimate - but it must be SEEN.
REM ------------------------------------------------------------------------------
set "ORPHANS=0"
for /f "delims=" %%f in ('git ls-files --others --exclude-standard ^| findstr /i /e ".cs .ts .tsx .sql"') do set "ORPHANS=1"
if "!ORPHANS!"=="1" (
    echo.
    echo  ------------------------------------------------------------
    echo   WARNING: untracked SOURCE files. They are in NO commit and
    echo   NO branch - a reset --hard deletes them with no way back:
    echo.
    for /f "delims=" %%f in ('git ls-files --others --exclude-standard ^| findstr /i /e ".cs .ts .tsx .sql"') do echo       %%f
    echo.
    echo   If they are real work:   git add ^<file^>   and re-run.
    echo   If they are scratch, carry on - but be sure.
    echo  ------------------------------------------------------------
)
echo.
set /p CONFIRM=Commit the staged files above? (y/N):
if /i not "%CONFIRM%"=="y" (
    echo  Cancelled. Nothing was committed.
    pause
    exit /b 1
)

REM ---- 2. Fast syntax pass before the slow build -------------------------------
REM
REM  The build below finds everything this finds, and more. This runs first
REM  anyway, because it takes a second where the build takes minutes, and
REM  because for the two failures that have actually bitten us it says what is
REM  wrong in words instead of "Expected a semicolon" pointing at a word in a
REM  comment.
REM
REM  Exit 1 = a real problem, stop. Exit 2 = the checker could not run at all
REM  (no typescript package yet), which must not block a push - the build is
REM  still the authority.
REM ------------------------------------------------------------------------------
echo.
echo [2/5] Quick syntax pass...
call node infra\scripts\web-syntax-check.js apps\web
if errorlevel 2 (
    echo   Skipped - the checker could not run. The build below still decides.
) else if errorlevel 1 (
    echo.
    echo   Fix the problems listed above. Nothing was committed.
    echo.
    pause
    exit /b 1
)

REM ---- 3. Build the web app ---------------------------------------------------
echo.
echo [3/5] Building the web app...
call pnpm --filter @tatvaos/web build
if errorlevel 1 goto :buildfail

REM ---- 4. Build the API -------------------------------------------------------
echo.
echo [4/5] Building the API...
pushd apps\api
REM  -v minimal, not -v quiet. Quiet emits NOTHING on success, which makes a
REM  build that ran and a build that never ran produce identical transcripts -
REM  and this log is what somebody reads to decide whether to trust the commit
REM  underneath it. Absence of output is indistinguishable from absence of
REM  execution. minimal prints "Build succeeded" and a timing line: still
REM  quiet, and it can testify.
call dotnet build --nologo -v minimal
if errorlevel 1 ( popd & goto :buildfail )
popd

REM ---- 5. Commit and push THIS branch -----------------------------------------
echo.
echo [5/5] Committing and pushing %BRANCH%...
git commit -m "%MSG%"
if errorlevel 1 goto :commitfail

git push -u origin %BRANCH%
if errorlevel 1 goto :pushfail

echo.
echo ============================================================
echo    PUSHED %BRANCH%. NOT deployed, and NOT on main.
echo.
echo    Tell Amit the branch is ready for review:
echo      "%BRANCH% pushed: %MSG%"
echo ============================================================
echo.
pause
exit /b 0

:buildfail
echo.
echo   BUILD FAILED. Nothing was committed or pushed.
echo   Your staged files are still staged. Fix the error and run again.
echo.
pause
exit /b 1

:commitfail
echo.
echo   COMMIT FAILED. Nothing was pushed. Read the message above.
echo.
pause
exit /b 1

:pushfail
echo.
echo   PUSH FAILED - but the COMMIT SUCCEEDED, so your work is safe
echo   on %BRANCH% locally. Check the message above and run:
echo       git push -u origin %BRANCH%
echo.
pause
exit /b 1
