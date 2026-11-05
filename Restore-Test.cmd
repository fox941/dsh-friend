@echo off
set "AI_FRIEND_INSTANCE=test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test-Instance.ps1" -Action Restore
pause
