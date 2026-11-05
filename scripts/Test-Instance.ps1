param([ValidateSet('Setup','Restore')][string]$Action='Setup',[string]$Snapshot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance Test
$testInstanceProject=Split-Path -Parent $PSScriptRoot
$testInstanceNode=Join-Path $testInstanceProject '.tools\node-v24.22.1-win-x64\node.exe'
Write-Host '[隔离测试实例] runtime/test；不连接真实平台，不操作 runtime/dev。'
if ($Action -eq 'Restore') {
    if (-not $Snapshot) { $Snapshot=Read-Host '请输入测试备份目录（内含 manifest.json）；拒绝主角色备份' }
    Write-Host '现有测试数据会先保存副本；完成后测试实例保持停止。'
    & $testInstanceNode (Join-Path $PSScriptRoot 'instance.mjs') restore $Snapshot.Trim('"')
} else { & $testInstanceNode (Join-Path $PSScriptRoot 'instance.mjs') setup }
if ($LASTEXITCODE -ne 0) { throw '测试实例维护未完成，主实例未操作。' }
