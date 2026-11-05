@echo off
set "AI_FRIEND_INSTANCE=test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\AiFriend.ps1" -Action Backup -Instance Test
pause
