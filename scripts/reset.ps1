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

Get-Process -Name "collector" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "python"    -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "node"      -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Phantom stopped." -ForegroundColor Yellow
