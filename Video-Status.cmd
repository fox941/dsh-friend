@echo off
set "AI_FRIEND_INSTANCE=main"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Video.ps1" -Action Status
pause
