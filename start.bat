@echo off
cd /d "%~dp0"
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title NoldOJ

echo ==========================================
echo       NoldOJ - Windows Online Judge
echo ==========================================
echo.

cd /d "%~dp0"

REM == Auto git pull (if git is available) ======
where git >nul 2>&1
if !errorlevel! equ 0 (
    if exist ".git" (
        echo [..] Checking for updates (git pull)...
        git pull --ff-only 2>nul
        if !errorlevel! equ 0 (
            echo [OK] Up to date.
        ) else (
            echo [!!] git pull failed or has conflicts, using current version.
        )
    ) else (
        echo [..] Not a git repository, skipping update check.
    )
) else (
    echo [..] Git not found, skipping update check.
)

REM == Auto-migrate problems/ to backend/data/problems/ ======
if exist "problems" (
    if not exist "backend\data\problems" (
        echo [..] Migrating problems/ to backend/data/problems/...
        if not exist "backend\data" mkdir "backend\data"
        move "problems" "backend\data\problems" >nul 2>&1
        if !errorlevel! equ 0 (
            echo [OK] problems/ migrated to backend/data/problems/
        ) else (
            echo [!!] Failed to migrate problems/ (permission issue?)
        )
    ) else (
        echo [..] backend/data/problems/ already exists, skipping migration
        REM Optional: merge contents if needed
        if exist "problems" (
            echo [!!] Root problems/ exists but target also exists. Manual merge may be needed.
        )
    )
)

where node >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js: %NODE_VER%

REM == Sandbox compile (?????,??? sandbox_runner.cpp ??) ======
if exist "backend\sandbox\sandbox_runner.cpp" (
    where g++ >nul 2>&1
    if !errorlevel! equ 0 (
        echo [..] Building sandbox_runner.exe - Job Object security + AppContainer...
        g++ -O2 -static -o "backend\sandbox\sandbox_runner.exe" "backend\sandbox\sandbox_runner.cpp" -lpsapi -luserenv 2>nul
        if exist "backend\sandbox\sandbox_runner.exe" (
            echo [OK] sandbox_runner.exe rebuilt - Job Object isolation active
        ) else (
            echo [!!] sandbox_runner.exe build failed - using legacy mode
        )
    ) else (
        echo [!!] g++ not found - sandbox_runner.exe not rebuilt, using legacy mode
    )
) else (
    if exist "backend\sandbox\sandbox_runner.exe" (
        echo [OK] sandbox_runner.exe kept - Job Object isolation active
    ) else (
        echo [!!] sandbox_runner.exe missing - using legacy mode
    )
)
title NoldOJ
cd backend
call npm ls --silent
if !errorlevel! neq 0 (
    echo [..] Installing dependencies...

    call npm install
    if !errorlevel! neq 0 (
        echo [FAIL] Failed to install dependencies
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)
cd ..
REM == Generate timestamp for log folder ======
if defined OJ_LOG_DIR (
    set "LOG_DIR=%OJ_LOG_DIR%"
) else (
    for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value 2^>nul') do set "dt=%%a"
    set "LOG_TS=%dt:~0,4%-%dt:~4,2%-%dt:~6,2%_%dt:~8,2%-%dt:~10,2%-%dt:~12,2%"
    set "LOG_DIR=log\%LOG_TS%"
)
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo [OK] Log folder: %LOG_DIR%

title NoldOJ
echo.
echo [..] Starting NoldOJ server...
echo [..] Logs: %LOG_DIR%\server.log
echo.

start "" http://localhost:3000

node backend\src\server.js > "%LOG_DIR%\server.log" 2>&1

pause

