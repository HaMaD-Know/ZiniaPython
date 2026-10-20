<#
.SYNOPSIS
  Downloads and verifies the pinned CPython iOS distribution on Windows.

.DESCRIPTION
  Reads python-runtime/runtime.lock.json, downloads the archive, checks its
  SHA-256 and extracts Python.xcframework into ios/App so you can inspect it
  or run scripts/verify-runtime.mjs. Building the iOS app itself still needs
  macOS with Xcode (for example the GitHub Actions workflow).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fetch-python-runtime.ps1
#>
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Lock = Get-Content -Raw -Path (Join-Path $Root 'python-runtime\runtime.lock.json') | ConvertFrom-Json
$Downloads = Join-Path $Root 'python-runtime\downloads'
$Dest = Join-Path $Root 'ios\App'
$Archive = Join-Path $Downloads ([System.IO.Path]::GetFileName($Lock.url))
$Marker = Join-Path $Dest 'Python.xcframework\.zinia-runtime-release'

if (-not $Force -and (Test-Path $Marker) -and ((Get-Content -Raw $Marker).Trim() -eq $Lock.release)) {
    Write-Host "Python.xcframework $($Lock.release) is already installed."
    exit 0
}

New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
if (-not (Test-Path $Archive)) {
    Write-Host "Downloading $($Lock.url)"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Lock.url -OutFile "$Archive.part"
    Move-Item -Force "$Archive.part" $Archive
}

$Actual = (Get-FileHash -Algorithm SHA256 -Path $Archive).Hash.ToLowerInvariant()
if ($Actual -ne $Lock.sha256) {
    Remove-Item -Force $Archive
    throw "SHA-256 mismatch: expected $($Lock.sha256), got $Actual"
}
Write-Host "Checksum verified ($Actual)"

$Target = Join-Path $Dest 'Python.xcframework'
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
# Windows' own bsdtar (Windows 10 1803+) understands drive-letter paths; a tar
# from Git for Windows that happens to be first on PATH does not.
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $Tar)) { $Tar = 'tar' }
# lib/libpython3.X.dylib entries are symlinks, which Windows cannot create
# without extra privileges; the Xcode build helper excludes them anyway.
& $Tar -xzf $Archive -C $Dest --exclude 'Python.xcframework/*/lib/libpython*.dylib' Python.xcframework
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
Set-Content -Path $Marker -Value $Lock.release -Encoding ascii
Write-Host "Installed $Target ($($Lock.release)). Verify with: node scripts\verify-runtime.mjs"
