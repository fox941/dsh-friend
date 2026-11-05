param([Parameter(Mandatory=$true)][string]$Zip,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$videoProjectRoot=Split-Path -Parent $PSScriptRoot
$videoToolRoot=[IO.Path]::GetFullPath((Join-Path $videoProjectRoot '.tools\video'))
$videoZipPath=[IO.Path]::GetFullPath($Zip)
$videoDestinationPath=[IO.Path]::GetFullPath($Destination)
if($videoZipPath -ne (Join-Path $videoToolRoot 'python.zip') -or $videoDestinationPath -ne (Join-Path $videoToolRoot 'python')) { throw 'Unexpected portable Python extraction paths' }
Expand-Archive -LiteralPath $videoZipPath -DestinationPath $videoDestinationPath
