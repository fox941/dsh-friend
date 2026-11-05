@echo off
set "AI_FRIEND_INSTANCE=main"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Migration.ps1" -Action Restore
pause
