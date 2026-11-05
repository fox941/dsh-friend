param([ValidateSet('Pack','Verify','Restore')][string]$Action='Pack',[string]$BundleRoot,[string]$Target,[string]$OutputDirectory,[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例操作')
$taskProject=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskProject '.tools\node-v24.22.1-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { throw '项目固定版 Node 缺失，请完整解压迁移包或准备 .tools。' }
if ($Action -eq 'Pack') {
    Write-Host '即将通过统一入口停止 AI 和自动恢复，打包后保持停止。请先退出本项目的 NapCat/AI QQ 和其他维护命令。'
    $taskArgs=@((Join-Path $PSScriptRoot 'migration.mjs'),'pack')
    if ($OutputDirectory) { $taskArgs+=@('--output',$OutputDirectory) }
} else {
    if (-not $BundleRoot) { $BundleRoot=Read-Host '请输入完整解压后的迁移包目录（内含 migration.json）' }
    $BundleRoot=$BundleRoot.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath (Join-Path $BundleRoot 'migration.json'))) { throw '未找到 migration.json，请先完整解压 ZIP，不要在压缩包内直接运行。' }
    $taskArgs=@((Join-Path $PSScriptRoot 'migration.mjs'),$Action.ToLowerInvariant(),'--bundle',$BundleRoot)
    if ($Target) { $taskArgs+=@('--target',$Target) }
    if ($Action -eq 'Restore') { Write-Host '恢复只支持原路径和空目录／同一包的中断恢复；完成依赖安装后保持停止，不自动登录或发送消息。' }
}
& $taskNode @taskArgs
if ($LASTEXITCODE -ne 0) { throw '迁移命令未完成，请根据上方提示检查；不要删除人格、记忆或检查点。' }
