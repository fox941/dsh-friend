@echo off
set "AI_FRIEND_INSTANCE=test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Diagnostics.ps1" -Instance Test
pause
