param([ValidateSet('Context','Enable','Disable','Status','RunOnce','Remove')][string]$Action='Context',[string]$Plan)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$autoSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-AutoHash([string]$Text) { $autoHasher=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($autoHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant() } finally {$autoHasher.Dispose()} }
$autoGuid=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
$autoMachine=Get-AutoHash ($env:COMPUTERNAME+'|'+$autoGuid+'|'+$autoSid)
if ($Action -eq 'Context') { $autoBoot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks; @{ownerSid=$autoSid;machineKey=$autoMachine;bootKey=(Get-AutoHash ($autoGuid+'|'+$autoBoot))} | ConvertTo-Json -Compress; exit 0 }
$autoPlan=Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$autoProject=[IO.Path]::GetFullPath($autoPlan.projectRoot).TrimEnd('\')
$autoExpectedName='AiFriend-Main-'+(Get-AutoHash ($autoProject.ToLowerInvariant()+'|'+$autoSid)).Substring(0,20)
if ($autoPlan.ownerSid -ne $autoSid -or $autoPlan.machineKey -ne $autoMachine -or $autoPlan.taskName -ne $autoExpectedName) { throw 'Task plan belongs to another user, machine or project.' }
$autoShell=Join-Path $PSHOME 'powershell.exe'
$autoScript=Join-Path $autoProject 'scripts\Autostart.ps1'
$autoArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$autoScript+'" -Action Run'
$autoDescription='AI Friend Main login startup v1 '+$autoExpectedName
function Get-AutoTask { try {return Get-ScheduledTask -TaskName $autoExpectedName -TaskPath '\' -ErrorAction Stop} catch {if ($_.CategoryInfo.Category -eq 'ObjectNotFound') {return $null}; throw} }
$autoExisting=Get-AutoTask
function Assert-AutoOwnership($Task) {
    $autoPrincipal=$Task.Principal.UserId
    if ($autoPrincipal -notlike 'S-*') {$autoPrincipal=(New-Object Security.Principal.NTAccount($autoPrincipal)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if ($autoPrincipal -ne $autoSid -or @($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -ne $autoShell -or $Task.Actions[0].Arguments -ne $autoArgs -or $Task.Description -ne $autoDescription) { throw 'Existing task is not owned by this project; no changes made.' }
}
if ($autoExisting) { Assert-AutoOwnership $autoExisting }
if ($Action -eq 'Enable') {
    $autoTrigger=New-ScheduledTaskTrigger -AtLogOn -User $autoSid
    $autoTrigger.Delay='PT20S'
    $autoPrincipal=New-ScheduledTaskPrincipal -UserId $autoSid -LogonType Interactive -RunLevel Limited
    $autoSettings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $autoSettings.Hidden=$true
    $autoAction=New-ScheduledTaskAction -Execute $autoShell -Argument $autoArgs -WorkingDirectory $autoProject
    $autoTask=New-ScheduledTask -Action $autoAction -Trigger $autoTrigger -Principal $autoPrincipal -Settings $autoSettings -Description $autoDescription
    if ($autoExisting) {Register-ScheduledTask -TaskName $autoExpectedName -TaskPath '\' -InputObject $autoTask -Force | Out-Null} else {Register-ScheduledTask -TaskName $autoExpectedName -TaskPath '\' -InputObject $autoTask | Out-Null}
} elseif ($Action -eq 'Disable' -and $autoExisting) { Disable-ScheduledTask -TaskName $autoExpectedName -TaskPath '\' | Out-Null
} elseif ($Action -eq 'RunOnce') { if (-not $autoExisting) {throw 'Verification task not registered.'}; Start-ScheduledTask -TaskName $autoExpectedName -TaskPath '\'
} elseif ($Action -eq 'Remove' -and $autoExisting) { Unregister-ScheduledTask -TaskName $autoExpectedName -TaskPath '\' -Confirm:$false }
$autoCurrent=Get-AutoTask
if (-not $autoCurrent) { @{installed=$false;taskName=$autoExpectedName} | ConvertTo-Json -Compress; exit 0 }
Assert-AutoOwnership $autoCurrent
$autoInfo=Get-ScheduledTaskInfo -TaskName $autoExpectedName -TaskPath '\'
@{installed=$true;enabled=[bool]$autoCurrent.Settings.Enabled;taskName=$autoExpectedName;state=[string]$autoCurrent.State;lastResult=$autoInfo.LastTaskResult;lastRun=$autoInfo.LastRunTime.ToString('o');executionTimeLimit=[string]$autoCurrent.Settings.ExecutionTimeLimit;logonType=[string]$autoCurrent.Principal.LogonType;runLevel=[string]$autoCurrent.Principal.RunLevel;multipleInstances=[string]$autoCurrent.Settings.MultipleInstances} | ConvertTo-Json -Compress
