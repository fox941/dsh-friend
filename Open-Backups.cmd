@echo off
if not exist "%~dp0backups\dev\" mkdir "%~dp0backups\dev"
start "" "%SystemRoot%\explorer.exe" "%~dp0backups\dev"
