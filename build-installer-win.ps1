# Build the Windows NSIS installer for RatedTracker Companion (the auto-update build).
#
# electron-builder needs its winCodeSign bundle extracted, but that bundle contains
# macOS .dylib symlinks that Windows refuses to create without admin / Developer Mode.
# This script pre-extracts winCodeSign with the macOS 'darwin' tree excluded (unused for
# a Windows build), which lets electron-builder run unelevated. The installer is unsigned;
# electron-updater verifies downloads by sha512 from latest.yml, so updates still work.
#
#   powershell -ExecutionPolicy Bypass -File .\build-installer-win.ps1
#   powershell -ExecutionPolicy Bypass -File .\build-installer-win.ps1 -Publish   (needs GH_TOKEN)

param(
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# 1. Make sure electron-updater is installed (runtime dependency).
if (-not (Test-Path (Join-Path $root 'node_modules\electron-updater'))) {
  Write-Output 'Installing dependencies (electron-updater missing)...'
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

# 2. Pre-extract winCodeSign so electron-builder does not try to create macOS symlinks.
$cacheBase = if ($env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE } else { Join-Path $env:LOCALAPPDATA 'electron-builder\Cache' }
$wcsDir = Join-Path $cacheBase 'winCodeSign'
$final = Join-Path $wcsDir 'winCodeSign-2.6.0'
$sevenZip = Join-Path $root 'node_modules\7zip-bin\win\x64\7za.exe'

$needExtract = -not (Test-Path (Join-Path $final 'windows-10'))
if ($needExtract) {
  Write-Output 'Preparing winCodeSign cache (excluding macOS darwin tree)...'
  if (-not (Test-Path $sevenZip)) { throw "7za not found at $sevenZip (run npm install first)" }
  New-Item -ItemType Directory -Force -Path $wcsDir | Out-Null

  # Reuse a downloaded archive if present, otherwise fetch it.
  $archive = Get-ChildItem (Join-Path $wcsDir '*.7z') -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $archive) {
    $url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
    $dest = Join-Path $wcsDir 'winCodeSign-2.6.0.7z'
    Write-Output ("Downloading " + $url)
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    $archive = Get-Item $dest
  }

  if (Test-Path $final) { Remove-Item -Recurse -Force $final }
  New-Item -ItemType Directory -Force -Path $final | Out-Null
  & $sevenZip x $archive.FullName ("-o" + $final) '-x!darwin' '-y' '-bso0' '-bsp0'
  if ($LASTEXITCODE -ne 0) { throw "winCodeSign extraction failed (exit $LASTEXITCODE)" }
  Write-Output ('winCodeSign ready at ' + $final)
} else {
  Write-Output ('winCodeSign cache already present at ' + $final)
}

# 3. Build (and optionally publish) the NSIS installer.
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$publishMode = if ($Publish) { 'always' } else { 'never' }
if ($Publish -and -not ($env:GH_TOKEN -or $env:GITHUB_TOKEN)) {
  throw 'Publish requested but no GH_TOKEN / GITHUB_TOKEN in environment.'
}
Write-Output ("Running electron-builder (--publish " + $publishMode + ")...")
& npx electron-builder --win --publish $publishMode
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }

# 4. Report artifacts.
$dist = Join-Path $root 'dist'
Write-Output ''
Write-Output 'Artifacts:'
Get-ChildItem $dist -File | Where-Object { $_.Name -match 'Setup\.exe|\.blockmap|latest\.yml' } |
  ForEach-Object { Write-Output ('  ' + $_.Name + '  (' + ('{0:N2} MB' -f ($_.Length / 1MB)) + ')') }
Write-Output ''
Write-Output 'Upload these three files to the GitHub release (tag must match version in package.json):'
Write-Output '  RatedTrackerCompanion-Setup.exe'
Write-Output '  RatedTrackerCompanion-Setup.exe.blockmap'
Write-Output '  latest.yml'
