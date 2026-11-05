$ErrorActionPreference='Stop'
$env:AI_FRIEND_INSTANCE='main'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskStateFile=Join-Path $taskRoot '.fresh-install.json'
if (-not (Test-Path -LiteralPath $taskStateFile)) { throw 'This entry is for a freshly installed independent role only.' }
& (Join-Path $taskRoot '.tools\node-v24.22.1-win-x64\node.exe') (Join-Path $PSScriptRoot 'fresh.mjs') check-offline
if ($LASTEXITCODE -ne 0) { throw 'Stop the fresh role before configuring its model key.' }
$taskCredential=Join-Path $taskRoot 'runtime\dev\credentials.local.json'
if (Test-Path -LiteralPath $taskCredential) { throw 'A model credential already exists; it was not overwritten. Use the existing configuration.' }
$taskSecure=Read-Host 'DeepSeek API key (hidden; stored only on this computer)' -AsSecureString
$taskPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
try {
    $taskKey=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    if ([string]::IsNullOrWhiteSpace($taskKey) -or $taskKey.Length -gt 512 -or $taskKey -match '[\r\n]') { throw 'Invalid API key input.' }
    $taskJson=@{DEEPSEEK_API_KEY=$taskKey.Trim()} | ConvertTo-Json
    $taskBytes=(New-Object Text.UTF8Encoding($false)).GetBytes($taskJson)
    $taskFile=[IO.File]::Open($taskCredential,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $taskFile.Write($taskBytes,0,$taskBytes.Length) } finally { $taskFile.Dispose() }
    Write-Host 'Model key saved locally. Default model: deepseek-flash. Configure QQ/Bilibili as needed, then run Start-Main.cmd.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    $taskKey=$null; $taskJson=$null; $taskBytes=$null
}
