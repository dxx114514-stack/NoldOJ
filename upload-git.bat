@echo off
chcp 65001
cd /d "%~dp0"

:: 1. 先拉取最新代码，防止冲突
git pull origin main

:: 2. 将所有更改加入暂存区
git add .

:: 2.5 敏感文件护栏：暂存区出现配置/密钥/数据库类路径时中止，避免误提交
git diff --staged --name-only > "%TEMP%\noldoj_staged.txt"
findstr /I /R /C:"\\config\\" /C:"\.env" /C:"\.pem" /C:"\.key" /C:"id_rsa" /C:"\.db$" /C:"captcha_answers" "%TEMP%\noldoj_staged.txt" >nul
if not errorlevel 1 (
    echo [ABORT] Staged files contain config/key/database-like paths:
    type "%TEMP%\noldoj_staged.txt" | findstr /I /R /C:"\\config\\" /C:"\.env" /C:"\.pem" /C:"\.key" /C:"id_rsa" /C:"\.db$" /C:"captcha_answers"
    echo Staging has been undone. Review with "git status" and commit manually if intended.
    git reset >nul 2>&1
    del "%TEMP%\noldoj_staged.txt" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\noldoj_staged.txt" >nul 2>&1

:: 3. 核心判断：检查暂存区是否真的有变化
:: --quiet 表示如果没有变化，命令会返回非 0 的错误码
git diff --staged --quiet

:: 如果上一条命令返回了错误码（说明有变化），则执行提交和推送
if %errorlevel% neq 0 (
    git commit -m "自动提交 %date% %time%"
    git push origin main
    echo [%date% %time%] 发现新更改，已自动提交并推送！
) else (
    echo [%date% %time%] 仓库无新更改，跳过本次提交。
)
