param([Parameter(Mandatory=$true)][string]$BundleRoot,[Parameter(Mandatory=$true)][string]$Destination,[ValidateSet('migration.json','update.json','fresh.json')][string]$ManifestName='migration.json')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot=[IO.Path]::GetFullPath($BundleRoot).TrimEnd('\')+'\'
$taskManifest=Get-Content -LiteralPath (Join-Path $BundleRoot $ManifestName) -Raw -Encoding UTF8 | ConvertFrom-Json
 $taskNames=@($ManifestName)+@($taskManifest.files | ForEach-Object { $_.path })
$taskStream=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$taskZip=$null
try {
    $taskZip=[IO.Compression.ZipArchive]::new($taskStream,[IO.Compression.ZipArchiveMode]::Create,$false,[Text.Encoding]::UTF8)
    $taskCount=0
    foreach ($taskName in $taskNames) {
        $taskFile=[IO.Path]::GetFullPath((Join-Path $BundleRoot $taskName))
        if (-not $taskFile.StartsWith($taskRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP 源文件越界' }
        $taskItem=Get-Item -LiteralPath $taskFile -Force
        if (($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ZIP 不跟随联接或符号链接' }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip,$taskFile,$taskName,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $taskCount++
        if ($taskCount % 500 -eq 0) { Write-Output ('ZIP files: '+$taskCount+'/'+$taskNames.Count) }
    }
} finally { if ($taskZip) { $taskZip.Dispose() }; $taskStream.Dispose() }
Write-Output ('ZIP files: '+$taskCount+'/'+$taskNames.Count)
