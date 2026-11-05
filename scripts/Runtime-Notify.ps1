param([string]$Message)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$taskNotice = New-Object System.Windows.Forms.NotifyIcon
try {
    $taskNotice.Icon = [System.Drawing.SystemIcons]::Information
    $taskNotice.Visible = $true
    $taskNotice.BalloonTipTitle = 'AI Friend 运行状态'
    $taskNotice.BalloonTipText = $Message
    $taskNotice.ShowBalloonTip(6000)
    Start-Sleep -Seconds 7
} finally { $taskNotice.Dispose() }
