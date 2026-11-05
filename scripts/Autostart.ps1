param([ValidateSet('Enable','Disable','Status','Run')][string]$Action='Status')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance Main
$startupProject=Split-Path -Parent $PSScriptRoot
$startupNode=Join-Path $startupProject '.tools\node-v24.22.1-win-x64\node.exe'
if ($Action -ne 'Run') {Write-Host ('[Main 登录后自启] '+$startupProject)}
& $startupNode (Join-Path $PSScriptRoot 'autostart.mjs') $Action.ToLowerInvariant()
exit $LASTEXITCODE
