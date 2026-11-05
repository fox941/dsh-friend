param(
    [ValidateSet('Pack','Verify','Preview','Apply','Rollback','Status')][string]$Action='Status',
    [Parameter(Position=0)][string]$Bundle,
    [string]$Transaction
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance Main
$updateProjectRoot=Split-Path -Parent $PSScriptRoot
$updateNode=Join-Path $updateProjectRoot '.tools\node-v24.22.1-win-x64\node.exe'
$updateArguments=@((Join-Path $PSScriptRoot 'update.mjs'),$Action.ToLowerInvariant())
Write-Host ('[代码升级／Main] '+$updateProjectRoot)
if ($Action -in @('Verify','Preview','Apply')) {
    if (-not $Bundle) { $Bundle=Read-Host '请输入更新包的完整解压目录（包含 update.json）' }
    $updateArguments+=@('--bundle',$Bundle.Trim('"'))
}
if ($Action -eq 'Rollback' -and $Transaction) { $updateArguments+=@('--transaction',$Transaction.Trim('"')) }
if ($Action -eq 'Preview') { Write-Host '将停止普通 Test，用新代码启动临时测试；Main 可继续运行。需要目标电脑模型密钥，会有一次模型测试费用。' }
if ($Action -eq 'Apply') { Write-Host '需要本机预览通过。将停止 Main/Test、备份并升级 Main；成功后启动 Main，失败保持停止。' }
if ($Action -eq 'Rollback') { Write-Host '只回退兼容代码及插件安装；角色数据已变化时拒绝覆盖。回退完成后保持停止。' }
& $updateNode @updateArguments
exit $LASTEXITCODE
