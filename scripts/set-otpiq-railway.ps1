# Set OTPIQ variables on Railway (run after railway login + link in backend/)
# Usage: .\scripts\set-otpiq-railway.ps1

$ErrorActionPreference = "Stop"
$BackendDir = Split-Path -Parent $PSScriptRoot
Push-Location $BackendDir

$status = & railway status 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $status -notmatch "Project:") {
    Write-Host "Run first: railway login" -ForegroundColor Yellow
    Write-Host "         cd backend; railway link" -ForegroundColor Yellow
    exit 1
}

$envFile = Join-Path $BackendDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "Missing backend/.env" -ForegroundColor Red
    exit 1
}

$lines = Get-Content $envFile
foreach ($key in @(
    "OTPIQ_API_KEY", "OTPIQ_BASE_URL", "OTPIQ_WHATSAPP_PROVIDER",
    "OTP_DEFAULT_CHANNEL", "OTP_WHATSAPP_ONLY", "OTP_TTL_MS", "OTP_LENGTH"
)) {
    $line = $lines | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
    if (-not $line) { continue }
    $value = ($line -split "=", 2)[1]
    if ([string]::IsNullOrWhiteSpace($value)) {
        Write-Host "Skip empty: $key" -ForegroundColor DarkGray
        continue
    }
    & railway variable set "$key=$value"
    if ($LASTEXITCODE -ne 0) { throw "Failed: $key" }
    Write-Host "Set: $key" -ForegroundColor Green
}

Write-Host "Done. Redeploy Railway service or wait for auto-restart." -ForegroundColor Green
Pop-Location
