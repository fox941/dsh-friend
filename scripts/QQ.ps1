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
if ($Action -eq 'OpenLogin') {
    $taskWeb=Get-Content -LiteralPath (Join-Path $taskInfo.workdir 'config\webui.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$taskWeb.port -ne [int]$taskInfo.webPort -or -not $taskWeb.token) {throw 'Local QQ login page configuration is invalid.'}
    Start-Process ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/?token='+[Uri]::EscapeDataString($taskWeb.token))
    Write-Host 'Opened the existing local QQ login page. Check the AI account; no account was logged out.'
    exit 0
}
$taskEngine=Join-Path $taskRoot '.tools\napcat-v4.18.41'
$taskLauncher=Join-Path $taskEngine 'NapCatWinBootMain.exe'
if (-not (Test-Path -LiteralPath $taskLauncher)) { throw 'Pinned NapCat v4.18.41 engine is missing. See docs/16-qq.md.' }
if (-not $QQPath) {
    $taskRegistry=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ' -ErrorAction SilentlyContinue
    if ($taskRegistry.UninstallString -match '^"([^"]+)\\Uninstall\.exe"') { $QQPath=Join-Path $Matches[1] 'QQ.exe' }
}
if (-not $QQPath -or -not (Test-Path -LiteralPath $QQPath -PathType Leaf)) { throw 'QQ.exe was not found. Run scripts/QQ.ps1 -QQPath <installed QQ.exe>.' }
$taskRecord=Join-Path $taskInfo.workdir 'launcher.local.json'
$taskExisting=Get-NetTCPConnection -LocalPort @($taskInfo.port,$taskInfo.webPort) -State Listen -ErrorAction SilentlyContinue
if ($taskExisting) { throw 'A configured QQ port is already listening. No second instance was launched. Open the existing NapCat page if it belongs to this project.' }
if (Get-Process -Name QQ -ErrorAction SilentlyContinue) { throw 'QQ is already running. This helper will not inject into or stop an existing QQ process. Close it before using this launcher, or manage a separate NapCat instance manually.' }
$env:NAPCAT_WORKDIR=$taskInfo.workdir
$env:NAPCAT_PATCH_PACKAGE=Join-Path $taskEngine 'qqnt.json'
$env:NAPCAT_LOAD_PATH=Join-Path $taskEngine 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH=Join-Path $taskEngine 'NapCatWinBootHook.dll'
$env:NAPCAT_LAUNCHER_PATH=$taskLauncher
$taskHelperEngineText=& $taskNode (Join-Path $PSScriptRoot 'napcat-helper-engine.mjs')
if ($LASTEXITCODE -ne 0) { throw 'NapCat helper compatibility verification failed; original engine preserved.' }
$taskHelperEngine=$taskHelperEngineText | ConvertFrom-Json
$env:NAPCAT_MAIN_PATH=$taskHelperEngine.entry
$env:NAPCAT_WEBUI_PREFERRED_PORT=[string]$taskInfo.webPort
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskChild=Start-Process -FilePath $taskLauncher -ArgumentList @(('"'+$QQPath+'"'),('"'+$env:NAPCAT_INJECT_PATH+'"'),'-q',[string]$taskInfo.botQQ) -WorkingDirectory $taskEngine -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskInfo.workdir ($taskStamp+'.out.log')) -RedirectStandardError (Join-Path $taskInfo.workdir ($taskStamp+'.err.log'))
@{pid=$taskChild.Id;startedAt=(Get-Date).ToUniversalTime().ToString('o');botQQ=$taskInfo.botQQ;qqPath=$QQPath} | ConvertTo-Json | Set-Content -LiteralPath $taskRecord -Encoding UTF8
$taskReady=$false
for ($taskAttempt=0; $taskAttempt -lt 60; $taskAttempt++) {
    try { $taskResponse=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/') -TimeoutSec 1; if ($taskResponse.StatusCode -eq 200) { $taskReady=$true; break } } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $taskReady) { throw 'NapCat WebUI is not ready. Inspect runtime/dev/channels/qq/napcat/*.err.log. No other QQ process was stopped.' }
Write-Host ('NapCat: http://127.0.0.1:'+$taskInfo.webPort+'/webui/')
Write-Host 'Scan with the AI QQ account. Then start DSH with Start-Dev.cmd. Stop-Dev.cmd stops AI replies.'
if (-not $NoBrowser) {
    $taskWeb=Get-Content -LiteralPath (Join-Path $taskInfo.workdir 'config\webui.json') -Raw | ConvertFrom-Json
    Start-Process ('http://127.0.0.1:'+$taskInfo.webPort+'/webui/?token='+[Uri]::EscapeDataString($taskWeb.token))
}
