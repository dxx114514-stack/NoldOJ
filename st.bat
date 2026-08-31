@echo off

cd /d "%~dp0"

REM == Generate timestamp for log folder ======
for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value 2^>nul') do set "dt=%%a"
set "LOG_TS=%dt:~0,4%-%dt:~4,2%-%dt:~6,2%_%dt:~8,2%-%dt:~10,2%-%dt:~12,2%"
set "LOG_DIR=log\%LOG_TS%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "OJ_LOG_DIR=%LOG_DIR%"

start "" /B "cloudflared.exe" tunnel run NoldOJ > "%LOG_DIR%\tunnel.log" 2>&1

start "" /B "start.bat"


