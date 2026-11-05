param([ValidateSet('Main','Test')][string]$Instance='Main')
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例状态')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
& (Join-Path $project '.tools\node-v24.22.1-win-x64\node.exe') (Join-Path $PSScriptRoot 'proactive.mjs') @args
exit $LASTEXITCODE
