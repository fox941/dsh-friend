param([switch]$RestoreExisting,[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Instance-Environment.ps1') -Instance $Instance
if ($Instance -eq 'Test') {
    if ($RestoreExisting) { throw '测试备份恢复请用 Restore-Test.cmd，未操作主实例。' }
    & (Join-Path $PSScriptRoot '.tools\node-v24.22.1-win-x64\node.exe') (Join-Path $PSScriptRoot 'scripts\instance.mjs') setup
    exit $LASTEXITCODE
}
Write-Host '[Main] 主实例 runtime/dev 工具和依赖维护'
$taskRoot = $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $taskRoot '.update-pending.json')) { throw 'Code update is incomplete. Continue Apply-Update or inspect Rollback-Update; Setup will not replace the checkpoint.' }
if ($RestoreExisting) {
    $taskBootstrapFile = Join-Path $taskRoot 'runtime\dev\bootstrap.json'
    $taskIdentityFile = Join-Path $taskRoot 'runtime\dev\companion\companion.sqlite'
    if (-not (Test-Path -LiteralPath $taskBootstrapFile) -or -not (Test-Path -LiteralPath $taskIdentityFile)) { throw 'RestoreExisting requires the original complete instance; no new role was created.' }
    $taskBootstrap = Get-Content -LiteralPath $taskBootstrapFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($taskBootstrap.configuredRoot) -ne [IO.Path]::GetFullPath((Join-Path $taskRoot 'runtime\dev'))) { throw 'Original runtime path differs. Automatic rebinding is unsupported.' }
}
$taskControl = Join-Path $taskRoot 'runtime\dev\host.json'
if (Test-Path -LiteralPath $taskControl) {
    $taskOwner = Get-Content -LiteralPath $taskControl -Raw | ConvertFrom-Json
    if (Get-Process -Id $taskOwner.pid -ErrorAction SilentlyContinue) { throw 'Stop AI Friend before running Setup.ps1.' }
}
$taskGuardFile = Join-Path $taskRoot 'runtime\dev\operations\guard.json'
if (Test-Path -LiteralPath $taskGuardFile) {
    $taskGuardOwner = Get-Content -LiteralPath $taskGuardFile -Raw | ConvertFrom-Json
    if (Get-Process -Id $taskGuardOwner.pid -ErrorAction SilentlyContinue) { throw 'Run Stop-Dev.cmd before Setup.ps1; runtime protection is active.' }
}
foreach ($taskTestRecord in @('runtime\test\host.json','runtime\test\operations\guard.json')) {
    $taskTestFile=Join-Path $taskRoot $taskTestRecord
    if (Test-Path -LiteralPath $taskTestFile) {
        $taskTestOwner=Get-Content -LiteralPath $taskTestFile -Raw | ConvertFrom-Json
        if (Get-Process -Id $taskTestOwner.pid -ErrorAction SilentlyContinue) { throw 'Shared tools maintenance requires Stop-Test.cmd as well.' }
    }
}
$taskTools = Join-Path $taskRoot '.tools'
$taskDownloads = Join-Path $taskRoot '.work\downloads'
$taskNodeDirectory = Join-Path $taskTools 'node-v24.22.1-win-x64'
$taskNode = Join-Path $taskNodeDirectory 'node.exe'
New-Item -ItemType Directory -Path $taskDownloads -Force | Out-Null
if (-not (Test-Path -LiteralPath $taskNode)) {
    $taskVersion = 'v24.22.1'
    $taskArchiveName = 'node-' + $taskVersion + '-win-x64.zip'
    $taskArchive = Join-Path $taskDownloads $taskArchiveName
    $taskChecksums = (Invoke-WebRequest -Uri ('https://nodejs.org/dist/' + $taskVersion + '/SHASUMS256.txt') -UseBasicParsing -TimeoutSec 60).Content
    if ($taskChecksums -is [byte[]]) { $taskChecksums = [Text.Encoding]::UTF8.GetString($taskChecksums) }
    $taskExpected = (($taskChecksums -split '\r?\n' | Where-Object { $_ -match ('\s+' + [regex]::Escape($taskArchiveName) + '$') }) -split '\s+')[0]
    if (-not $taskExpected) { throw 'Official Node checksum not found' }
    Invoke-WebRequest -Uri ('https://nodejs.org/dist/' + $taskVersion + '/' + $taskArchiveName) -OutFile $taskArchive -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw 'Node checksum mismatch' }
    Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskTools -Force
}
if ((& $taskNode --version) -ne 'v24.22.1') { throw 'Project Node version mismatch' }
$env:PATH = $taskNodeDirectory + ';' + (Join-Path $taskTools 'package-manager\node_modules\.bin') + ';' + (Join-Path $taskRoot 'node_modules\.bin') + ';' + $env:PATH
$env:npm_config_cache = Join-Path $taskRoot '.work\npm-cache'
$env:npm_config_store_dir = Join-Path $taskRoot '.work\pnpm-store'
$env:DSH_HOME = Join-Path $taskRoot 'runtime\dev\dsh-home'
$env:MNEMON_DATA_DIR = Join-Path $taskRoot 'runtime\dev\memory\native-default'
$env:MNEMON_MAX_INSIGHTS = '0'
$taskPnpm = Join-Path $taskTools 'package-manager\node_modules\pnpm\bin\pnpm.mjs'
if (-not (Test-Path -LiteralPath $taskPnpm)) {
    & $taskNode (Join-Path $taskNodeDirectory 'node_modules\npm\bin\npm-cli.js') install --prefix (Join-Path $taskTools 'package-manager') --no-audit --no-fund --save-exact pnpm@11.28.5
    if ($LASTEXITCODE -ne 0) { throw 'pnpm installation failed' }
}
Push-Location $taskRoot
try {
    if (Test-Path -LiteralPath (Join-Path $taskRoot 'pnpm-lock.yaml')) {
        & $taskNode $taskPnpm install --frozen-lockfile --store-dir $env:npm_config_store_dir --config.confirmModulesPurge=false --fetch-timeout 60000 --fetch-retries 1 --reporter append-only
    } else {
        & $taskNode $taskPnpm install --store-dir $env:npm_config_store_dir --config.confirmModulesPurge=false --fetch-timeout 60000 --fetch-retries 1 --reporter append-only
    }
    if ($LASTEXITCODE -ne 0) { throw 'Project dependency installation failed' }
    $taskDsh = Join-Path $taskRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    $taskProfile = Join-Path $env:DSH_HOME 'profiles\web'
    $taskProfilePackage = Join-Path $taskProfile 'package.json'
    $taskHasMnemon = $false
    if (Test-Path -LiteralPath $taskProfilePackage) {
        $taskProfileJson = Get-Content -LiteralPath $taskProfilePackage -Raw | ConvertFrom-Json
        $taskHasMnemon = $taskProfileJson.dependencies.'dsh-mnemon' -eq '0.5.36'
    }
    if (-not $taskHasMnemon) {
        & $taskNode $taskDsh plugin --profile web add dsh-mnemon@0.5.36 --save-exact --store-dir $env:npm_config_store_dir --fetch-timeout 60000 --fetch-retries 1
        if ($LASTEXITCODE -ne 0) { throw 'Mnemon profile installation failed' }
    } else {
        & $taskNode $taskPnpm --dir $taskProfile install --frozen-lockfile --store-dir $env:npm_config_store_dir --config.confirmModulesPurge=false --reporter append-only
        if ($LASTEXITCODE -ne 0) { throw 'Profile dependency installation failed' }
    }
    if ($RestoreExisting) {
        Write-Host 'Restored locked dependencies; original role configuration and plugin artifacts retained.'
        exit 0
    }
    & $taskNode (Join-Path $taskRoot 'scripts\configure.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Dev configuration failed' }
    & $taskNode (Join-Path $taskRoot 'scripts\install-adapter.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Companion adapter installation failed' }
    Write-Host 'Setup complete. Run Start-Dev.cmd.'
} finally { Pop-Location }
