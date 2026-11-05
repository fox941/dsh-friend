param([ValidateSet('Setup','Status')][string]$Action='Status',[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例操作')
$videoProjectRoot=Split-Path -Parent $PSScriptRoot
$videoNode=Join-Path $videoProjectRoot '.tools\node-v24.22.1-win-x64\node.exe'
if($Action -eq 'Setup') {
  $videoProxy=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if(-not $env:HTTPS_PROXY -and $videoProxy.ProxyEnable -eq 1 -and $videoProxy.ProxyServer -match '^127\.0\.0\.1:\d+$') { $env:HTTPS_PROXY='http://'+$videoProxy.ProxyServer; $env:HTTP_PROXY=$env:HTTPS_PROXY; $env:NODE_USE_ENV_PROXY='1' }
}
& $videoNode (Join-Path $PSScriptRoot 'video-tools.mjs') $Action.ToLowerInvariant()
exit $LASTEXITCODE
