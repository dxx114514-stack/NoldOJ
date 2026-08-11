@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title WinOJ

echo ==========================================
echo       WinOJ - Windows Online Judge
echo ==========================================
echo.

cd /d "%~dp0"

if not exist "log" mkdir log
if exist "log\server.log" del /q "log\server.log"
for %%f in (log\*) do del /q "%%f" 2>nul
echo [OK] Log directory cleared.

where node >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js: %NODE_VER%

REM == Sandbox compile (始终重编译，确保与 sandbox_runner.cpp 同步) ======
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

echo.
echo [..] Starting WinOJ server...
echo [..] Logs: log\server.log
echo.

start "" http://localhost:3000

node backend\src\server.js > "log\server.log" 2>&1

pause
