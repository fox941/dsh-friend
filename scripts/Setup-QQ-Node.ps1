$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskWork=Join-Path $taskProject '.work'
$taskTools=Join-Path $taskProject '.tools'
$taskDestination=Join-Path $taskTools 'napcat-node-v4.18.41'
$taskRequired=@('node.exe','wrapper.node','package.json','config.json','QQNT.dll')
$taskArchiveName='NapCat.Shell.Windows.Node-v4.18.41.zip'
$taskExpectedHash='51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0'
$taskArchive=Join-Path (Join-Path $taskWork 'downloads') $taskArchiveName

function Get-QQArchiveHash([string]$ArchivePath) {
    $taskStream=[IO.File]::OpenRead($ArchivePath)
    $taskHasher=[Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() }
    finally { $taskHasher.Dispose(); $taskStream.Dispose() }
}

if (-not [Environment]::Is64BitOperatingSystem) { throw 'The QQ component requires Windows x64.' }
New-Item -ItemType Directory -Path $taskWork -Force | Out-Null
try { $taskLock=[IO.File]::Open((Join-Path $taskWork 'qq-node-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch [IO.IOException] { throw 'Another QQ component installation is running.' }
try {
    if (Test-Path -LiteralPath $taskDestination) {
        foreach ($taskFile in $taskRequired) {
            if (-not (Test-Path -LiteralPath (Join-Path $taskDestination $taskFile) -PathType Leaf)) {
                throw 'The existing QQ component is incomplete. Preserve that folder and inspect it before reinstalling.'
            }
        }
        Write-Host 'The pinned QQ Node component is already installed. Run Start-QQ.cmd.'
        exit 0
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskArchive) -Force | Out-Null
    if (-not (Test-Path -LiteralPath $taskArchive)) {
        $taskPartial=$taskArchive+'.'+[guid]::NewGuid().ToString('N')+'.partial'
        Write-Host 'Downloading the official NapCat v4.18.41 Windows Node component...'
        Invoke-WebRequest -Uri 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip' -OutFile $taskPartial -UseBasicParsing -TimeoutSec 600
        if ((Get-QQArchiveHash $taskPartial) -ne $taskExpectedHash) {
            throw 'The download failed SHA256 verification. The partial file was preserved.'
        }
        [IO.File]::Move($taskPartial,$taskArchive)
    }
    if ((Get-QQArchiveHash $taskArchive) -ne $taskExpectedHash) {
        throw 'The cached download failed SHA256 verification. Inspect the cached archive before retrying.'
    }
    New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
    $taskStaging=Join-Path $taskTools ('napcat-node-v4.18.41.incomplete-'+[guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskStaging
    foreach ($taskFile in $taskRequired) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskStaging $taskFile) -PathType Leaf)) {
            throw 'The official archive is incomplete. The staging folder was preserved.'
        }
    }
    [IO.Directory]::Move($taskStaging,$taskDestination)
    Write-Host 'QQ Node component installed. Run Start-QQ.cmd and confirm the AI account login.'
} finally { $taskLock.Dispose() }
