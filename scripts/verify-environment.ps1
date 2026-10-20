<#
.SYNOPSIS
  Checks the Windows development environment for ZiniaPython IDE.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\verify-environment.ps1
#>
$ErrorActionPreference = 'Continue'
$ok = $true

function Check($Name, $Command, $Minimum, $Hint) {
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Host ("  MISSING  {0,-8} {1}" -f $Name, $Hint) -ForegroundColor Red
        $script:ok = $false
        return
    }
    $version = (& $Command --version 2>$null | Select-Object -First 1)
    Write-Host ("  ok       {0,-8} {1}" -f $Name, $version) -ForegroundColor Green
    if ($Minimum -and $version -match '(\d+)\.(\d+)') {
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        $req = $Minimum.Split('.')
        if ($major -lt [int]$req[0] -or ($major -eq [int]$req[0] -and $minor -lt [int]$req[1])) {
            Write-Host ("           {0} {1} or newer is required. {2}" -f $Name, $Minimum, $Hint) -ForegroundColor Yellow
            $script:ok = $false
        }
    }
}

Write-Host 'ZiniaPython IDE - environment check'
Check 'Node.js' 'node' '22.12' 'winget install OpenJS.NodeJS.LTS'
Check 'npm' 'npm' '10.0' 'comes with Node.js'
Check 'Git' 'git' '2.30' 'winget install Git.Git'
Check 'Python' 'python' '3.12' 'optional, for npm run test:python and dev:bridge: winget install Python.Python.3.14'

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) { Write-Host "  ok       tar      $tar" -ForegroundColor Green }
else { Write-Host '  note     tar.exe not found; scripts\fetch-python-runtime.ps1 needs Windows 10 1803 or newer' -ForegroundColor Yellow }

Write-Host ''
Write-Host 'Building the iOS app needs macOS with Xcode 26+. Use the GitHub Actions workflow'
Write-Host '(.github/workflows/build-ios.yml) - see README.md, "Building the iOS app with GitHub Actions".'
if ($ok) { Write-Host "`nEverything needed for development is installed." -ForegroundColor Green; exit 0 }
else { Write-Host "`nInstall the missing tools above, then run this check again." -ForegroundColor Yellow; exit 1 }
