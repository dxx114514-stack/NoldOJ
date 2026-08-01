@echo off
REM build_sandbox.bat - 编译 sandbox_runner.exe
REM 需要 MinGW (g++) 在 PATH 中
cd /d "%~dp0"

where g++ >nul 2>nul
if errorlevel 1 (
    echo [ERROR] g++ not found in PATH. Please install MinGW-w64.
    echo         Download: https://github.com/niXman/mingw-builds-binaries/releases
    exit /b 1
)

echo [INFO] Compiling sandbox_runner.exe ...
g++ -O2 -static -o sandbox_runner.exe sandbox_runner.cpp -lpsapi
if errorlevel 1 (
    echo [ERROR] Compilation failed.
    exit /b 1
)

echo [OK] sandbox_runner.exe built successfully.
echo [INFO] The sandbox will now use Job Object isolation + restricted token.
echo [INFO] If sandbox_runner.exe is absent, the system falls back to legacy mode.
