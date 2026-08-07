@echo off
setlocal
title TatvaOS Mail - one-click deploy
color 0a

REM ============================================================
REM   TatvaOS one-click deploy
REM   Double-click this file: it verifies, commits, pushes,
REM   then deploys to production over SSH. No typing needed.
REM
REM   Edit the four paths below only if something moves.
REM ============================================================
set "REPO=C:\Users\amitd\Downloads\tatvaOS"
set "KEY=C:\Users\amitd\.ssh\tatvaos_deploy"
set "SERVER=deploy@172.105.57.198"
set "REMOTE_DIR=/srv/tatvaos-production"
REM ============================================================

cd /d "%REPO%" || (echo Cannot find repo: %REPO% & pause & exit /b 1)

REM Auto commit message with a timestamp — no prompt, true one-click.
set "MSG=mail deploy %DATE% %TIME%"

echo.
echo =====================================================
echo    TatvaOS  -  build . commit . push . deploy
echo =====================================================
echo.

echo [1/6] Web typecheck . . .
call pnpm typecheck || goto fail

echo.
echo [2/6] API build . . .
call dotnet build apps\api\TatvaOS.Api.csproj -v quiet || goto fail

echo.
echo [3/6] git add + commit . . .
git add -A
REM keep this helper itself out of the repo
git reset -- mail.cmd >nul 2>&1
git commit -m "%MSG%"
if errorlevel 1 echo    (nothing new to commit - deploying current main)

echo.
echo [4/6] git push origin main . . .
git push origin main || goto fail

echo.
echo [5/6] Server: fetch + reset to origin/main . . .
echo [6/6] Server: deploy.sh production (build + schema + restart) . . .
echo    ---- server output below ----
ssh -i "%KEY%" %SERVER% "cd %REMOTE_DIR% && git fetch --all --prune && git reset --hard origin/main && CI=1 ./infra/scripts/deploy.sh production" || goto fail

echo.
echo =====================================================
echo    DONE  -  production updated.
echo    Hard-refresh mail.tatvaos.com  (Ctrl+Shift+R)
echo =====================================================
echo.
pause
exit /b 0

:fail
color 0c
echo.
echo -----------------------------------------------------
echo    STOPPED - the step above failed.
echo    Nothing after it ran, so nothing half-deployed.
echo    Fix the error, then double-click again.
echo -----------------------------------------------------
echo.
pause
exit /b 1
