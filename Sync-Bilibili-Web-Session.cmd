@echo off
set "AI_FRIEND_INSTANCE=main"
"%~dp0.tools\node-v24.22.1-win-x64\node.exe" "%~dp0scripts\bilibili-web-session.mjs" sync
pause
