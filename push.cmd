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
echo [1/4] What you are about to commit:
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

echo.
echo  Anything NOT staged is left alone:
git status --short -- . | findstr /b /c:" M" /c:"??"
echo.
set /p CONFIRM=Commit the staged files above? (y/N):
if /i not "%CONFIRM%"=="y" (
    echo  Cancelled. Nothing was committed.
    pause
    exit /b 1
)

REM ---- 2. Build the web app ---------------------------------------------------
echo.
echo [2/4] Building the web app...
call pnpm --filter @tatvaos/web build
if errorlevel 1 goto :buildfail

REM ---- 3. Build the API -------------------------------------------------------
echo.
echo [3/4] Building the API...
pushd apps\api
call dotnet build --nologo -v quiet
if errorlevel 1 ( popd & goto :buildfail )
popd

REM ---- 4. Commit and push THIS branch -----------------------------------------
echo.
echo [4/4] Committing and pushing %BRANCH%...
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
