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
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js: %NODE_VER%

REM == 安全沙箱编译 ==================================================
if not exist "backend\sandbox\sandbox_runner.exe" (
    if exist "backend\sandbox\sandbox_runner.cpp" (
        where g++ >nul 2>&1
        if !errorlevel! equ 0 (
            echo [..] Building sandbox_runner.exe (Job Object security)...
            g++ -O2 -static -o "backend\sandbox\sandbox_runner.exe" "backend\sandbox\sandbox_runner.cpp" -lpsapi 2>nul
            if exist "backend\sandbox\sandbox_runner.exe" (
                echo [OK] sandbox_runner.exe built - Job Object isolation active
            ) else (
                echo [!!] sandbox_runner.exe build failed - using legacy mode
            )
        ) else (
            echo [!!] g++ not found - sandbox_runner.exe not built, using legacy mode
        )
    )
) else (
    echo [OK] sandbox_runner.exe found - Job Object isolation active
)

if not exist "backend\node_modules" (
    echo [..] Installing dependencies...
    cd backend
    call npm install
    cd ..
    if %errorlevel% neq 0 (
        echo [FAIL] Failed to install dependencies
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

where ollama >nul 2>&1
if %errorlevel% equ 0 (
    curl -s http://localhost:11434/api/tags >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Ollama is running
    ) else (
        echo [..] Starting Ollama...
        start "" ollama serve
        timeout /t 5 /nobreak >nul
        curl -s http://localhost:11434/api/tags >nul 2>&1
        if %errorlevel% equ 0 (
            echo [OK] Ollama started
        ) else (
            echo [!!] Ollama failed to start - AI code review disabled
        )
    )
) else (
    echo [!!] Ollama not found - AI code review disabled
    echo Download: https://ollama.com/
)

echo.
echo [..] Starting WinOJ server...
echo [..] Logs: log\server.log
echo.

start "" http://localhost:3000

node backend\src\server.js > "log\server.log" 2>&1

pause
