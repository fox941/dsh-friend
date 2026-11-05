param([ValidateSet('Login','Status','Console','Config')][string]$Action='Login',[ValidateSet('Main','Test')][string]$Instance='Main')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
Write-Host ('['+$Instance+'] 实例操作')
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskRoot '.tools\node-v24.22.1-win-x64\node.exe'
$taskCLI=Join-Path $PSScriptRoot 'bilibili.mjs'
if ($Instance -eq 'Test' -and $Action -ne 'Status') { throw 'Test instance cannot log in to a real Bilibili account.' }
if ($Action -eq 'Status') { & $taskNode $taskCLI status; exit $LASTEXITCODE }
if ($Action -eq 'Console') { & $taskNode $taskCLI console; if ($LASTEXITCODE -eq 0) { Start-Process (Join-Path (Join-Path $taskRoot 'runtime\dev\companion\console') 'bilibili-console.html') }; exit $LASTEXITCODE }
if ($Action -eq 'Config') { & $taskNode $taskCLI config-apply; if ($LASTEXITCODE -eq 0) { Start-Process (Join-Path (Join-Path $taskRoot 'runtime\dev\companion\console') 'bilibili-console.html') }; exit $LASTEXITCODE }
$taskFolder=Join-Path $taskRoot 'runtime\dev\channels\bilibili'
New-Item -ItemType Directory -Path $taskFolder -Force | Out-Null
$taskReadyFile=Join-Path $taskFolder 'login.local.json'
if (Test-Path -LiteralPath $taskReadyFile) {
    $taskPrevious=Get-Content -LiteralPath $taskReadyFile -Raw | ConvertFrom-Json
    if (Get-Process -Id $taskPrevious.pid -ErrorAction SilentlyContinue) { throw 'A Bilibili login helper is already running. Complete or close that attempt first.' }
    Remove-Item -LiteralPath $taskReadyFile
}
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskChild=Start-Process -FilePath $taskNode -ArgumentList @(('"'+$taskCLI+'"'),'login') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskFolder ($taskStamp+'.out.log')) -RedirectStandardError (Join-Path $taskFolder ($taskStamp+'.err.log'))
for ($taskAttempt=0; $taskAttempt -lt 60; $taskAttempt++) {
    $taskChild.Refresh()
    if ($taskChild.HasExited) { throw 'Bilibili login exited. Inspect runtime/dev/channels/bilibili/*.err.log.' }
    if (Test-Path -LiteralPath $taskReadyFile) { $taskReady=Get-Content -LiteralPath $taskReadyFile -Raw | ConvertFrom-Json; Start-Process $taskReady.url; Write-Host 'Use the AI Bilibili account to scan and confirm in the mobile app.'; exit 0 }
    Start-Sleep -Milliseconds 500
}
throw 'Bilibili login helper did not become ready.'
