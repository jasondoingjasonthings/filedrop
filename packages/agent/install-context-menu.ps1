# FileDrop context menu installer
# Run as Administrator: powershell -ExecutionPolicy Bypass -File install-context-menu.ps1

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

# Require elevation — HKLM writes fail silently without it
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ERROR: This script must be run as Administrator.' -ForegroundColor Red
    Write-Host 'Right-click PowerShell and select "Run as Administrator", then re-run.' -ForegroundColor Yellow
    exit 1
}

$keyFile   = Join-Path $PSScriptRoot 'upload-single.js'
$keyFiles  = 'HKLM:\SOFTWARE\Classes\*\shell\Upload to FileDrop'
$keyFolder = 'HKLM:\SOFTWARE\Classes\Directory\shell\Upload to FileDrop'
$keyBg     = 'HKLM:\SOFTWARE\Classes\Directory\Background\shell\Upload to FileDrop'

if ($Uninstall) {
    foreach ($k in @($keyFiles, $keyFolder, $keyBg)) {
        if (Test-Path $k) { Remove-Item $k -Recurse -Force }
    }
    Write-Host 'FileDrop context menu removed.' -ForegroundColor Green
    exit 0
}

# Find node.exe
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Write-Host 'ERROR: node.exe not found in PATH. Install Node.js first.' -ForegroundColor Red
    exit 1
}

# Verify upload-single.js exists next to this script
if (-not (Test-Path $keyFile)) {
    Write-Host "ERROR: upload-single.js not found at $keyFile" -ForegroundColor Red
    exit 1
}

$cmd = "`"$nodePath`" `"$keyFile`" `"%1`""

# Register for files (*), folders (Directory), and folder background
foreach ($base in @($keyFiles, $keyFolder)) {
    New-Item -Path "$base\command" -Force | Out-Null
    Set-ItemProperty -Path $base          -Name '(Default)' -Value 'Upload to FileDrop'
    Set-ItemProperty -Path $base          -Name 'Icon'      -Value $nodePath
    Set-ItemProperty -Path "$base\command" -Name '(Default)' -Value $cmd
}

# Folder background uses %V instead of %1
$cmdBg = "`"$nodePath`" `"$keyFile`" `"%V`""
New-Item -Path "$keyBg\command" -Force | Out-Null
Set-ItemProperty -Path $keyBg           -Name '(Default)' -Value 'Upload to FileDrop'
Set-ItemProperty -Path $keyBg           -Name 'Icon'      -Value $nodePath
Set-ItemProperty -Path "$keyBg\command" -Name '(Default)' -Value $cmdBg

Write-Host 'FileDrop context menu installed.' -ForegroundColor Green
Write-Host "Right-click any file or folder in Explorer to use it."
Write-Host ''
Write-Host "To uninstall: powershell -ExecutionPolicy Bypass -File install-context-menu.ps1 -Uninstall"
