@echo off
md log
start "" /B "D:/cfd/cloudflared.exe" tunnel run winoj > log\tunnel.log 2>&1

start "" /B "start.bat"

