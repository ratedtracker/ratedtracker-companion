# Assemble a portable Windows build of RatedTracker Companion without the
# electron-builder signing toolchain (which needs admin/Developer Mode on Windows
# to extract its winCodeSign bundle). Produces a self-contained folder + zip the
# user can unzip and run.
#
#   powershell -ExecutionPolicy Bypass -File .\build-portable-win.ps1

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$dist = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $dist 'electron.exe'))) {
  throw "Electron binary missing at $dist. Run npm install (and the binary fetch) first."
}

$outRoot = Join-Path $root 'out'
$appDir  = Join-Path $outRoot 'RatedTrackerCompanion'
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 1. Copy the Electron runtime.
Copy-Item -Recurse -Force (Join-Path $dist '*') $appDir

# 2. Drop our app into resources\app (Electron runs this instead of the default app).
$resApp = Join-Path $appDir 'resources\app'
New-Item -ItemType Directory -Force -Path $resApp | Out-Null
Copy-Item -Force (Join-Path $root 'main.js') $resApp
Copy-Item -Force (Join-Path $root 'preload.js') $resApp
Copy-Item -Force (Join-Path $root 'package.json') $resApp
Copy-Item -Recurse -Force (Join-Path $root 'assets') (Join-Path $resApp 'assets')

# 3. Remove the default Electron fallback app so ours is authoritative.
$defApp = Join-Path $appDir 'resources\default_app.asar'
if (Test-Path $defApp) { Remove-Item -Force $defApp }

# 4. Rename the launcher and stamp its icon/metadata via rcedit when available.
$exe = Join-Path $appDir 'RatedTracker Companion.exe'
Rename-Item -Path (Join-Path $appDir 'electron.exe') -NewName 'RatedTracker Companion.exe'

$rcedit = Get-ChildItem (Join-Path $root 'node_modules') -Recurse -Filter 'rcedit*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$icon = Join-Path $root 'assets\icon.ico'
if ($rcedit -and (Test-Path $icon)) {
  & $rcedit.FullName "$exe" --set-icon "$icon" `
    --set-version-string "ProductName" "RatedTracker Companion" `
    --set-version-string "FileDescription" "RatedTracker Companion" `
    --set-version-string "CompanyName" "RatedTracker" 2>&1 | Out-Null
  Write-Output ("Stamped icon via " + $rcedit.Name)
} else {
  Write-Output "rcedit not found; launcher keeps the default Electron icon."
}

# 5. Zip the portable folder for distribution.
$zip = Join-Path $outRoot 'RatedTrackerCompanion-win-x64.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $appDir -DestinationPath $zip

$mb = '{0:N1} MB' -f ((Get-Item $zip).Length / 1MB)
Write-Output ''
Write-Output ("Portable app: " + $exe)
Write-Output ("Zip:          " + $zip + "  (" + $mb + ")")
