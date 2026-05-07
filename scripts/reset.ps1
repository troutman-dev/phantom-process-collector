Get-Process -Name "collector" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "python"    -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "node"      -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Phantom stopped." -ForegroundColor Yellow
