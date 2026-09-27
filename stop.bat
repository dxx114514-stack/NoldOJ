@echo off
chcp 65001 >nul 2>&1
echo [..] Stopping NoldOJ server on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo [OK] Killing process PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)
echo [OK] NoldOJ server stopped.
pause