@echo off
set "AI_FRIEND_INSTANCE=main"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Diagnostics.ps1"
pause
