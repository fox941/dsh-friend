param(
    [ValidateSet('Start','Stop','Status','Restart','Recover','Backup','Export')][string]$Action='Start',
    [switch]$NoBrowser,
    [ValidateSet('Main','Test')][string]$Instance='Main'
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Instance-Environment.ps1') -Instance $Instance
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskNode=Join-Path $taskRoot '.tools\node-v24.22.1-win-x64\node.exe'
$taskDirectory=if ($Instance -eq 'Test') {'test'} else {'dev'}
$taskInstance=Join-Path $taskRoot ('runtime\'+$taskDirectory)
$taskWebHost=if ($Instance -eq 'Test') {'127.0.0.2'} else {'127.0.0.1'}
$taskPort=if ($Instance -eq 'Test') {3081} else {3080}
$taskBaseUrl='http://'+$taskWebHost+':'+[string]$taskPort+'/'
Write-Host ('['+$Instance+'] '+$taskInstance)
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Project Node is missing. Run Setup.ps1 first.' }
if ($Action -in @('Backup','Export')) {
    & $taskNode (Join-Path $PSScriptRoot 'archive.mjs') $Action.ToLowerInvariant()
    exit $LASTEXITCODE
}
$taskOutput=& $taskNode (Join-Path $PSScriptRoot 'runtime.mjs') $Action.ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw ('['+$Instance+'] operation failed. Check the selected instance status. Test setup uses Setup-Test.cmd.') }
if ($Action -eq 'Status') { $taskOutput; exit 0 }
if ($Action -eq 'Stop') { Write-Host ('['+$Instance+'] stopped; its automatic recovery disabled.'); exit 0 }
$taskReady=$false
for ($taskAttempt=0; $taskAttempt -lt 120; $taskAttempt++) {
    $taskStatusText=& $taskNode (Join-Path $PSScriptRoot 'runtime.mjs') status
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read selected instance status.' }
    $taskStatus=$taskStatusText | ConvertFrom-Json
    if ($taskStatus.host.state -eq 'running' -and $taskStatus.host.health.available) {
        if ($Instance -eq 'Test' -and (-not $taskStatus.host.health.isolation.active -or -not $taskStatus.host.health.isolation.valid)) { throw 'Test isolation guard is not ready; no browser opened.' }
        $taskReady=$true; break
    }
    if ($taskStatus.observed.state -in @('restart_limit','recovery_blocked','identity_conflict','owner_conflict','host_unresponsive','inspection_failed')) { throw ($taskStatus.observed.message+' Check selected instance status.') }
    Start-Sleep -Seconds 1
}
if (-not $taskReady) { throw 'Host not ready yet. Existing process preserved; inspect selected instance logs.' }
if ($taskStatus.host.health.identity -ne $taskStatus.observed.identity) { throw 'Identity mismatch; no browser opened.' }
if ($Instance -eq 'Test' -and $taskStatus.host.health.memory.activeSpaces -eq 0) {
    & $taskNode (Join-Path $PSScriptRoot 'initialize-memory.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Test memory initialization failed; primary data was not used.' }
}
Write-Host ('['+$Instance+'] ready: '+$taskBaseUrl)
if (-not $NoBrowser) {
    $taskBrowserUrl=$taskBaseUrl
    $taskRecentLog=Get-ChildItem -LiteralPath (Join-Path $taskInstance 'logs') -Filter '*.out.log' | Where-Object {$_.Name -ne 'runtime-guard.out.log'} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($taskRecentLog) { $taskText=Get-Content -LiteralPath $taskRecentLog.FullName -Raw; $taskPattern='dsh web: ('+[regex]::Escape($taskBaseUrl)+'[^\r\n ]*)'; if ($taskText -match $taskPattern) { $taskBrowserUrl=$Matches[1] } }
    Start-Process $taskBrowserUrl
}
