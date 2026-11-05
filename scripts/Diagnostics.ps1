param([int]$Hours=24,[switch]$Json,[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例操作')
$taskProject=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskProject '.tools\node-v24.22.1-win-x64\node.exe'
$taskArguments=@((Join-Path $PSScriptRoot 'diagnostics.mjs'),'--hours',[string]$Hours)
if($Json){$taskArguments+='--json'}
& $taskNode @taskArguments
exit $LASTEXITCODE
