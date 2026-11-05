param([ValidateSet('Pack','Verify','Install')][string]$Action='Pack',[string]$BundleRoot,[string]$Target,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
$env:AI_FRIEND_INSTANCE='main'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskProject '.tools\node-v24.22.1-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Pinned Node is missing. Fully extract the fresh package first.' }
if ($Action -eq 'Pack') {
    Write-Host 'Package code and clean tools only. Existing role, memory, credentials and platform login stay on this computer.'
    $taskArgs=@((Join-Path $PSScriptRoot 'fresh.mjs'),'pack')
    if ($OutputDirectory) { $taskArgs+=@('--output',$OutputDirectory) }
} else {
    if (-not $BundleRoot) { $BundleRoot=Read-Host 'Path of fully extracted package containing fresh.json' }
    $BundleRoot=$BundleRoot.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath (Join-Path $BundleRoot 'fresh.json'))) { throw 'Not a fresh package. Do not use Restore-Migration for a blank role.' }
    $taskArgs=@((Join-Path $PSScriptRoot 'fresh.mjs'),$Action.ToLowerInvariant(),'--bundle',$BundleRoot)
    if ($Action -eq 'Install') {
        if (-not $Target) { $Target=Read-Host 'Empty target folder [D:\ai friend]'; if (-not $Target) { $Target='D:\ai friend' } }
        $taskArgs+=@('--target',$Target.Trim().Trim('"'))
        Write-Host 'Requires an empty target. Creates a NEW role; does not start it or import old memory.'
    }
}
& $taskNode @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Fresh deployment incomplete. Keep the package and installation log. No existing role was cleared.' }
