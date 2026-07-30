@echo off
chcp 65001
cd /d "D:\你的代码仓库路径"

:: 1. 先拉取最新代码，防止冲突
git pull origin main

:: 2. 将所有更改加入暂存区
git add .

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