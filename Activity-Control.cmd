@echo off
set "AI_FRIEND_INSTANCE=main"
if "%~1"=="" (
  echo Usage: Activity-Control.cmd pause^|resume^|status
  exit /b 1
)
"%~dp0.tools\node-v24.22.1-win-x64\node.exe" "%~dp0scripts\bilibili.mjs" "%~1"
if errorlevel 1 pause
