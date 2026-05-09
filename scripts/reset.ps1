$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hasDebugPriv = (whoami /priv 2>$null) -match "SeDebugPrivilege"
if (-not $isAdmin -and -not $hasDebugPriv) {
    $ps = Start-Process powershell `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
        -Verb RunAs -PassThru
    $ps.WaitForExit()
    exit $ps.ExitCode
}

$root    = Split-Path $PSScriptRoot -Parent
$logDir  = Join-Path $root "logs"
$pidFile = Join-Path $logDir "phantom.pids"

# Read ports from config.toml for port-based process detection
$configPath = Join-Path $root "config.toml"
$configText  = Get-Content $configPath -Raw
function Get-TomlPort {
    param($text, $key)
    if ($text -match "(?m)^$key\s*=\s*(\d+)") { return [int]$Matches[1] }
    return $null
}
$scorerPort    = Get-TomlPort $configText "scorer"
$dashboardPort = Get-TomlPort $configText "dashboard"

# Kill a process and its entire descendant tree by OS PID
function Stop-ProcessTree {
    param([int]$Id)
    taskkill /F /T /PID $Id 2>$null | Out-Null
}

# Kill whichever process is listening on a given TCP port (and its descendants)
function Stop-ProcessOnPort {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { Stop-ProcessTree -Id $conn.OwningProcess }
}

# Collector is a project-specific binary name — safe to kill by name
Get-Process -Name "collector" -ErrorAction SilentlyContinue | Stop-Process -Force

if (Test-Path $pidFile) {
    # Primary path: stop only the PIDs recorded by run.ps1
    $tracked = Get-Content $pidFile | ConvertFrom-Json
    if ($null -ne $tracked.scorer) { Stop-ProcessTree -Id ([int]$tracked.scorer) }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    # Fallback: use port-based detection instead of killing all python processes
    if ($scorerPort) { Stop-ProcessOnPort -Port $scorerPort }
}

# Dashboard (vite/node): kill only the process bound to the dashboard port
if ($dashboardPort) { Stop-ProcessOnPort -Port $dashboardPort }

Write-Host "Phantom stopped." -ForegroundColor Yellow
