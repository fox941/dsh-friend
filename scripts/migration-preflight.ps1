param([Parameter(Mandatory=$true)][string]$ProjectRoot,[int]$OwnerPid,[string]$PortsCsv='')
$ErrorActionPreference='Stop'
$taskPrefix=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')+'\'
$Ports=@();if ($PortsCsv) { $Ports=@($PortsCsv.Split(',') | ForEach-Object { [int]$_ }) }
$taskWriters=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'mnemon.exe'" | Where-Object { $_.ProcessId -ne $OwnerPid -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase) })
if ($taskWriters.Count) { throw '本项目仍有 Node/Native 命令运行；请关闭后再打包。未终止任何进程。' }
if ($Ports.Count) {
    $taskListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in $Ports })
    if ($taskListeners.Count) { throw 'NapCat/AI QQ 的配置端口仍在监听，请退出本项目的 NapCat/AI QQ 后重新打包。' }
}
Write-Output '{"writersStopped":true}'
