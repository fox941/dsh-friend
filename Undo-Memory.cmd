@echo off
set "AI_FRIEND_INSTANCE=main"
setlocal
if "%~1"=="" (
  echo Usage: Undo-Memory.cmd APPLICATION_UUID
  echo Stop AI Friend with Stop-Dev.cmd first. Restart manually after successful undo.
  exit /b 1
)
"%~dp0.tools\node-v24.22.1-win-x64\node.exe" "%~dp0scripts\protection.mjs" undo "%~1"
exit /b %errorlevel%
