@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
echo [..] Stopping NoldOJ server on port 3000...
set "KILLED=0"
rem Only kill node.exe/nodejs.exe listening on 3000, never an unrelated service that happens to share the port.
rem The same PID can appear twice (IPv4 + IPv6); re-checking tasklist after the kill keeps the output honest.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    set "IMG="
    set "EXISTS="
    for /f "tokens=1,2" %%n in ('tasklist /FI "PID eq %%a" 2^>nul') do (
        if /I not "%%n"=="Image" if /I not "%%n"=="INFO:" if /I not "%%n"=="Note:" (
            set "EXISTS=1"
            if /I "%%n"=="node.exe" set "IMG=%%n"
            if /I "%%n"=="nodejs.exe" set "IMG=%%n"
        )
    )
    if defined IMG (
        echo [OK] Killing !IMG! PID: %%a
        taskkill /F /PID %%a >nul 2>&1
        set "KILLED=1"
    ) else if defined EXISTS (
        echo [SKIP] PID %%a holds port 3000 but is not node.exe - left untouched.
    )
)
if "!KILLED!"=="0" echo [OK] No NoldOJ node process found on port 3000.
echo [OK] NoldOJ server stopped.
pause
