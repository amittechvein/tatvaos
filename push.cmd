@echo off
setlocal enabledelayedexpansion
title TatvaOS - backend push (no deploy)
cd /d "C:\Users\amitd\Downloads\tatvaOS"

echo ============================================================
echo    TatvaOS  -  build, commit, push   (BACKEND - no deploy)
echo ------------------------------------------------------------
echo    Deployment is done by the frontend developer.
echo    This only pushes your changes to GitHub, then reminds
echo    you to message the frontend dev.
echo ============================================================
echo.

REM ---- Commit message -------------------------------------------------------
set "MSG=%~1"
if "%MSG%"=="" set /p MSG=Commit message (leave blank for a timestamp):
if "%MSG%"=="" set "MSG=backend %date% %time%"

REM ---- 1. Build the web app (catches breakage before pushing) ---------------
echo.
echo [1/4] Building the web app...
call pnpm --filter @tatvaos/web build
if errorlevel 1 goto :buildfail

REM ---- 2. Build the API ----------------------------------------------------
echo.
echo [2/4] Building the API...
pushd apps\api
call dotnet build --nologo -v quiet
if errorlevel 1 ( popd & goto :buildfail )
popd

REM ---- 3. Commit -----------------------------------------------------------
echo.
echo [3/4] Committing...
git add -A
git commit -m "%MSG%"

REM ---- 4. Push -------------------------------------------------------------
echo.
echo [4/4] Pushing to GitHub...
git push origin main
if errorlevel 1 goto :pushfail

echo.
echo ============================================================
echo    PUSHED. NOT deployed.
echo.
echo    Now message the frontend developer:
echo      "Backend changes pushed to main and ready to deploy:
echo       %MSG%"
echo ============================================================
echo.
pause
exit /b 0

:buildfail
echo.
echo ------------------------------------------------------------
echo   BUILD FAILED. Nothing was committed or pushed.
echo   Fix the error above, then run this again.
echo ------------------------------------------------------------
echo.
pause
exit /b 1

:pushfail
echo.
echo ------------------------------------------------------------
echo   PUSH FAILED. The build was fine but the push did not go
echo   through. Check the message above and try again.
echo ------------------------------------------------------------
echo.
pause
exit /b 1
