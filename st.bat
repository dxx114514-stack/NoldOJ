@echo off

start "" /B "cloudflared.exe" tunnel run winoj > log\tunnel.log 2>&1

start "" /B "start.bat"

