Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try { Stop-Transcript } catch { }
$null = Start-Transcript -Path (Join-Path $logDir "run.log") -Force

# ---------------------------------------------------------------------------
# 1. Parse ports from config.toml
# ---------------------------------------------------------------------------
$configPath = Join-Path $root "config.toml"
$configText  = Get-Content $configPath -Raw

function Get-TomlPort {
    param($text, $key)
    if ($text -match "(?m)^$key\s*=\s*(\d+)") { return [int]$Matches[1] }
    throw "Could not find port '$key' in config.toml"
}

$collectorPort = Get-TomlPort $configText "collector"
$scorerPort    = Get-TomlPort $configText "scorer"
$dashboardPort = Get-TomlPort $configText "dashboard"

Write-Host "Ports - collector:$collectorPort  scorer:$scorerPort  dashboard:$dashboardPort" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 2. Check that all three ports are free
# ---------------------------------------------------------------------------
foreach ($port in @($collectorPort, $scorerPort, $dashboardPort)) {
    $bound = netstat -ano | Select-String ":$port\s+.*LISTENING"
    if ($bound) {
        Write-Host "Port $port is already in use. Run .\scripts\reset.ps1 first." -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# 3. Build collector
# ---------------------------------------------------------------------------
# Kill any lingering collector process before building — cargo cannot overwrite
# a running executable on Windows.
Get-Process -Name "collector" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "`nBuilding collector..." -ForegroundColor Cyan
Push-Location (Join-Path $root "collector")
cargo build --release
if ($LASTEXITCODE -ne 0) { Write-Host "Collector build failed." -ForegroundColor Red; exit 1 }
Pop-Location

# ---------------------------------------------------------------------------
# 4. Start collector in background
# ---------------------------------------------------------------------------
$collectorExe = Join-Path $root "collector\target\release\collector.exe"
Write-Host "Starting collector..." -ForegroundColor Cyan
$collectorJob = Start-Process -FilePath $collectorExe -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $logDir "collector.log")

# ---------------------------------------------------------------------------
# 5. Poll collector /health (max 10 s)
# ---------------------------------------------------------------------------
Write-Host "Waiting for collector to be ready..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$collectorPort/health" -UseBasicParsing -TimeoutSec 1
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if (-not $ready) { Write-Host "Collector did not become ready in 10 s." -ForegroundColor Red; exit 1 }
Write-Host "  Collector ready." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 6. Write dashboard/.env
# ---------------------------------------------------------------------------
$envFile = Join-Path $root "dashboard\.env"
"VITE_SCORER_URL=http://localhost:$scorerPort`nVITE_DASHBOARD_PORT=$dashboardPort" | Set-Content $envFile
Write-Host "Wrote $envFile" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 7. Start scorer in background
# ---------------------------------------------------------------------------
Write-Host "Starting scorer..." -ForegroundColor Cyan
$scorerDir = Join-Path $root "scorer"
$scorerJob  = Start-Process -FilePath "uv" -ArgumentList "run python main.py" `
    -WorkingDirectory $scorerDir -PassThru -WindowStyle Hidden

# ---------------------------------------------------------------------------
# 8. Poll scorer /health (max 10 s)
# ---------------------------------------------------------------------------
Write-Host "Waiting for scorer to be ready..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$scorerPort/health" -UseBasicParsing -TimeoutSec 1
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if (-not $ready) { Write-Host "Scorer did not become ready in 10 s." -ForegroundColor Red; exit 1 }
Write-Host "  Scorer ready." -ForegroundColor Green

# ---------------------------------------------------------------------------
# 9. Start dashboard (opens browser)
# ---------------------------------------------------------------------------
Write-Host "Starting dashboard..." -ForegroundColor Cyan
$dashboardDir = Join-Path $root "dashboard"
Push-Location $dashboardDir
fnm env --use-on-cd | Out-String | Invoke-Expression
fnm use
if (-not (Test-Path "node_modules") -or ((Get-Item "package-lock.json").LastWriteTime -gt (Get-Item "node_modules").LastWriteTime)) { npm install }
Start-Process "http://localhost:$dashboardPort"
try { npm run dev } finally { Pop-Location }
