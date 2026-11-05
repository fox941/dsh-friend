param([ValidateSet('Main','Test')][string]$Instance='Main')
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例状态')
$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskProject '.tools\node-v24.22.1-win-x64\node.exe'
& $taskNode (Join-Path $PSScriptRoot 'attention.mjs')
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
