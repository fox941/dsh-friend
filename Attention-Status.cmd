@echo off
set "AI_FRIEND_INSTANCE=main"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Attention.ps1"
pause
