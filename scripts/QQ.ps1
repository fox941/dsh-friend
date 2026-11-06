param([ValidateSet('Start','Configure','Status','OpenLogin')][string]$Action='Start',[string]$QQPath,[switch]$NoBrowser,[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例操作')
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskRoot '.tools\node-v24.22.1-win-x64\node.exe'
$taskCLI=Join-Path $PSScriptRoot 'qq.mjs'
if ($Action -notin @('Start','OpenLogin')) {
    & $taskNode $taskCLI $Action.ToLowerInvariant()
    exit $LASTEXITCODE
}
$taskInfoText=& $taskNode $taskCLI launch-info
if ($LASTEXITCODE -ne 0) { throw 'QQ is not configured. Run Stop-Dev.cmd, then Configure-QQ.cmd.' }
$taskInfo=$taskInfoText | ConvertFrom-Json
function Open-ConfiguredQQLogin {
    $taskWeb=Get-Content -LiteralPath (Join-Path $taskInfo.workdir 'config\webui.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$taskWeb.port -ne [int]$taskInfo.webPort -or -not $taskWeb.token) { throw 'Local QQ login page configuration is invalid.' }
    Start-Process ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/?token='+[Uri]::EscapeDataString($taskWeb.token))
}
if ($Action -eq 'OpenLogin') {
    Open-ConfiguredQQLogin
    Write-Host 'Opened the existing local QQ login page.'
    exit 0
}
$taskNodeBackendRoot=Join-Path $taskRoot '.tools\napcat-node-v4.18.41'
$taskBackendNode=Join-Path $taskNodeBackendRoot 'node.exe'
$taskBackendEntry=Join-Path $PSScriptRoot 'qq-node-entry.cjs'
$taskBackendWrapper=Join-Path $taskNodeBackendRoot 'wrapper.node'
$taskUseNode=(Test-Path -LiteralPath $taskBackendNode) -and (Test-Path -LiteralPath $taskBackendWrapper)
$taskRecord=Join-Path $taskInfo.workdir 'launcher.local.json'
$taskStartLockPath=Join-Path $taskRoot '.work\qq-start.lock'
New-Item -ItemType Directory -Path (Split-Path -Parent $taskStartLockPath) -Force | Out-Null
try { $taskStartLock=[IO.File]::Open($taskStartLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch [IO.IOException] { throw 'AI QQ is already starting. Wait for that attempt to finish.' }
try {
    if ($taskUseNode -and (Test-Path -LiteralPath $taskRecord)) {
        $taskPrevious=Get-Content -LiteralPath $taskRecord -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($taskPrevious.backend -eq 'node') {
            $taskRunning=Get-Process -Id $taskPrevious.pid -ErrorAction SilentlyContinue
            if ($taskRunning -and $taskRunning.Path -eq $taskBackendNode -and [Math]::Abs(($taskRunning.StartTime.ToUniversalTime()-[datetime]::Parse($taskPrevious.startedAt).ToUniversalTime()).TotalSeconds) -lt 5) {
                $taskResponse=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/') -TimeoutSec 3
                if ($taskResponse.StatusCode -ne 200) { throw 'AI QQ is running but its login page is not ready. Inspect the latest NapCat log.' }
                Write-Host 'AI QQ is already running. Use the existing login page.'
                if (-not $NoBrowser) { Open-ConfiguredQQLogin }
                exit 0
            }
        }
    }
    $taskExisting=Get-NetTCPConnection -LocalPort @($taskInfo.port,$taskInfo.webPort) -State Listen -ErrorAction SilentlyContinue
    if ($taskExisting) { throw 'A configured QQ port is already listening. Check the existing instance before starting another.' }
    $taskEngine=Join-Path $taskRoot '.tools\napcat-v4.18.41'
    $env:NAPCAT_WORKDIR=$taskInfo.workdir
    $env:NAPCAT_WEBUI_PREFERRED_PORT=[string]$taskInfo.webPort
    $taskHelperEngineText=& $taskNode (Join-Path $PSScriptRoot 'napcat-helper-engine.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'NapCat helper compatibility verification failed; original engine preserved.' }
    $taskHelperEngine=$taskHelperEngineText | ConvertFrom-Json
    $env:NAPCAT_MAIN_PATH=$taskHelperEngine.entry
    $taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $taskOutLog=Join-Path $taskInfo.workdir ($taskStamp+'.out.log')
    $taskErrorLog=Join-Path $taskInfo.workdir ($taskStamp+'.err.log')
    if ($taskUseNode) {
        $taskChild=Start-Process -FilePath $taskBackendNode -ArgumentList @(('"'+$taskBackendEntry+'"'),'-q',[string]$taskInfo.botQQ) -WorkingDirectory $taskNodeBackendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskOutLog -RedirectStandardError $taskErrorLog
        $taskLaunchRecord=@{pid=$taskChild.Id;startedAt=(Get-Date).ToUniversalTime().ToString('o');botQQ=$taskInfo.botQQ;backend='node';nodePath=$taskBackendNode}
    } else {
        $taskLauncher=Join-Path $taskEngine 'NapCatWinBootMain.exe'
        if (-not (Test-Path -LiteralPath $taskLauncher)) { throw 'Pinned NapCat v4.18.41 engine is missing. See docs/16-qq.md.' }
        if (-not $QQPath) {
            $taskRegistry=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ' -ErrorAction SilentlyContinue
            if ($taskRegistry.UninstallString -match '^"([^"]+)\\Uninstall\.exe"') { $QQPath=Join-Path $Matches[1] 'QQ.exe' }
        }
        if (-not $QQPath -or -not (Test-Path -LiteralPath $QQPath -PathType Leaf)) { throw 'QQ.exe was not found. Run scripts/QQ.ps1 -QQPath <installed QQ.exe>.' }
        if (Get-Process -Name QQ -ErrorAction SilentlyContinue) { throw 'QQ is already running. Close it before using this launcher.' }
        $env:NAPCAT_PATCH_PACKAGE=Join-Path $taskEngine 'qqnt.json'
        $env:NAPCAT_LOAD_PATH=Join-Path $taskEngine 'loadNapCat.js'
        $env:NAPCAT_INJECT_PATH=Join-Path $taskEngine 'NapCatWinBootHook.dll'
        $env:NAPCAT_LAUNCHER_PATH=$taskLauncher
        $taskChild=Start-Process -FilePath $taskLauncher -ArgumentList @(('"'+$QQPath+'"'),('"'+$env:NAPCAT_INJECT_PATH+'"'),'-q',[string]$taskInfo.botQQ) -WorkingDirectory $taskEngine -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskOutLog -RedirectStandardError $taskErrorLog
        $taskLaunchRecord=@{pid=$taskChild.Id;startedAt=(Get-Date).ToUniversalTime().ToString('o');botQQ=$taskInfo.botQQ;qqPath=$QQPath}
    }
    $taskLaunchRecord | ConvertTo-Json | Set-Content -LiteralPath $taskRecord -Encoding UTF8
    $taskReady=$false
    for ($taskAttempt=0; $taskAttempt -lt 60; $taskAttempt++) {
        $taskChild.Refresh()
        if ($taskChild.HasExited) { throw 'AI QQ exited before its login page became ready. Inspect the latest NapCat log.' }
        try {
            $taskResponse=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/') -TimeoutSec 1
            if ($taskResponse.StatusCode -eq 200) { $taskReady=$true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $taskReady) { throw 'NapCat WebUI is not ready. Inspect runtime/dev/channels/qq/napcat/*.err.log.' }
    Write-Host ('NapCat: http://127.0.0.1:'+$taskInfo.webPort+'/webui/')
    Write-Host 'Scan with the AI QQ account. Then run Start-Main.cmd.'
    if (-not $NoBrowser) { Open-ConfiguredQQLogin }
} finally { $taskStartLock.Dispose() }
