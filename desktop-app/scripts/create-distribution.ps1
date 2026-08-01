$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $projectRoot "..")).Path
$extensionRoot = Join-Path $repositoryRoot "extension-worker"
$releaseRoot = Join-Path $projectRoot "release"
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot "manifest.json") -Raw | ConvertFrom-Json
$extensionName = "Vyren-AI-Worker-Extension-$($manifest.version)"
$stageRoot = Join-Path $releaseRoot $extensionName
$zipPath = Join-Path $releaseRoot "$extensionName.zip"

if (-not $releaseRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release directory is outside the desktop project."
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Copy-Item -LiteralPath $extensionRoot -Destination $stageRoot -Recurse
Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Copy-Item -LiteralPath (Join-Path $projectRoot "build\INSTALL-MAY-KHAC.txt") -Destination (Join-Path $releaseRoot "INSTALL-MAY-KHAC.txt") -Force

$artifacts = Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object {
  $_.Extension -in @(".exe", ".zip", ".txt") -and $_.Name -ne "SHA256SUMS.txt"
}
$checksums = foreach ($artifact in $artifacts) {
  $hash = Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256
  "$($hash.Hash)  $($artifact.Name)"
}
Set-Content -LiteralPath (Join-Path $releaseRoot "SHA256SUMS.txt") -Value $checksums -Encoding utf8

Write-Output "Created distribution artifacts:"
$artifacts | Select-Object Name, Length, LastWriteTime
