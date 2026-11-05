@echo off
setlocal
set "AI_FRIEND_INSTANCE=main"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Autostart.ps1" -Action Enable
pause
