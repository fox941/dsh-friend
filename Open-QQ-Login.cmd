@echo off
setlocal
set "AI_FRIEND_INSTANCE=main"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\QQ.ps1" -Action OpenLogin
pause
