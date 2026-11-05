@echo off
setlocal
set "AI_FRIEND_INSTANCE=main"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Update.ps1" -Action Preview %*
pause
