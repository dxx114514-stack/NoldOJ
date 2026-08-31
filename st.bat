@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM == Generate timestamp for log folder ======
set "LOG_TS=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
set "LOG_TS=!LOG_TS: =0!"
set "LOG_DIR=log\!LOG_TS!"
if not exist "!LOG_DIR!" mkdir "!LOG_DIR!"
set "OJ_LOG_DIR=!LOG_DIR!"

start "" /B "cloudflared.exe" tunnel run NoldOJ > "!LOG_DIR!\tunnel.log" 2>&1

start "" /B "start.bat"


