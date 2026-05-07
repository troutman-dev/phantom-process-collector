Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-Command { param($cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Install-Tool {
    param($id, $name)
    Write-Host "  Installing $name..." -ForegroundColor Cyan
    winget install --id $id --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Write-Host "  Failed to install $name." -ForegroundColor Red; exit 1 }
}
function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH","User")
}

Write-Host "`nPhantom -- Prerequisite Installer" -ForegroundColor White
Write-Host "──────────────────────────────────"

if (-not (Test-Command "winget")) {
    Write-Host "winget not found. Install App Installer from the Microsoft Store." -ForegroundColor Red; exit 1
}

foreach ($tool in @(
    @{ cmd="rustup"; id="Rustlang.Rustup";  name="rustup" },
    @{ cmd="uv";     id="astral-sh.uv";     name="uv"     },
    @{ cmd="fnm";    id="Schniz.fnm";        name="fnm"    }
)) {
    if (Test-Command $tool.cmd) { Write-Host "  [OK] $($tool.cmd)" -ForegroundColor Green }
    else { Install-Tool $tool.id $tool.name; Refresh-Path }
}

Write-Host "`nAll prerequisites satisfied." -ForegroundColor Green
Write-Host "Next: .\scripts\run.ps1`n" -ForegroundColor Cyan
