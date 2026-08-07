@echo off
setlocal enabledelayedexpansion
title TatvaOS - one click deploy
cd /d "C:\Users\amitd\Downloads\tatvaOS"

echo ============================================================
echo    TatvaOS  -  build, commit, push, deploy  (one click)
echo ============================================================
echo.

REM ---- Commit message -------------------------------------------------------
REM  Pass one on the command line, or type one when asked. Blank = timestamp.
set "MSG=%~1"
if "%MSG%"=="" set /p MSG=Commit message (leave blank for a timestamp):
if "%MSG%"=="" set "MSG=deploy %date% %time%"

REM ---- 1. Build the web app (the main gate) ---------------------------------
echo.
echo [1/5] Building the web app...
call pnpm --filter @tatvaos/web build
if errorlevel 1 goto :buildfail

REM ---- 2. Build the API (catches C# errors before the long Docker build) ----
echo.
echo [2/5] Building the API...
pushd apps\api
call dotnet build --nologo -v quiet
if errorlevel 1 ( popd & goto :buildfail )
popd

REM ---- 3. Commit ------------------------------------------------------------
echo.
echo [3/5] Committing...
git add -A
REM  git commit returns an error when there is nothing to commit - that is
REM  fine, we still want to push/deploy in that case, so we do not abort here.
git commit -m "%MSG%"

REM ---- 4. Push -------------------------------------------------------------
echo.
echo [4/5] Pushing to GitHub...
git push origin main
if errorlevel 1 goto :pushfail

REM ---- 5. Deploy on the Linode over SSH ------------------------------------
echo.
echo [5/5] Deploying on the server (you may be asked for the deploy password)...
ssh deploy@172.105.57.198 "cd /srv/tatvaos-production && git pull && CI=1 ./infra/scripts/deploy.sh production"
if errorlevel 1 goto :deployfail

echo.
echo ============================================================
echo    DONE  -  production is updated.
echo ============================================================
echo.
pause
exit /b 0

REM ==========================================================================
:buildfail
echo.
echo ------------------------------------------------------------
echo   BUILD FAILED. Nothing was committed, pushed or deployed.
echo   Fix the error shown above, then run this again.
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:pushfail
echo.
echo ------------------------------------------------------------
echo   PUSH FAILED. The build was fine but the push did not go
echo   through (network, or the remote moved on). Nothing was
echo   deployed. Check the message above.
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:deployfail
echo.
echo ------------------------------------------------------------
echo   DEPLOY FAILED. Code IS pushed to GitHub, but the server
echo   deploy did not finish. Read the output above; you can
echo   re-run this file to retry just the deploy.
echo ------------------------------------------------------------
echo.
pause
exit /b 1
