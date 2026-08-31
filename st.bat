@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM == Generate timestamp for log folder ======
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "LOG_TS=%%a"
set "LOG_DIR=log\!LOG_TS!"
if not exist "!LOG_DIR!" mkdir "!LOG_DIR!"
set "OJ_LOG_DIR=!LOG_DIR!"

start "" /B "cloudflared.exe" tunnel --config tuncfg.yml run noldoj > "!LOG_DIR!\tunnel.log" 2>&1

start "" /B "start.bat"
