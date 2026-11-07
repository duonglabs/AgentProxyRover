# Stops the elevated sing-box started by elevate-start.ps1 (second UAC prompt).
# Kills the recorded PID, plus any stray process whose image equals our exact
# sing-box.exe path (never other copies of sing-box on this machine).
# Called by lib/vpn-engine.js — not meant to be run by hand.
param(
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$ExePath
)
$ErrorActionPreference = 'Continue'
if (Test-Path $PidFile) {
  $pidTarget = (Get-Content $PidFile -ErrorAction SilentlyContinue).Trim()
  if ($pidTarget -match '^\d+$') {
    Stop-Process -Id ([int]$pidTarget) -Force -ErrorAction SilentlyContinue
  }
}
# strays from crashed runs: match on the exact binary path, not the name
$exe = (Resolve-Path -LiteralPath $ExePath -ErrorAction SilentlyContinue).Path
if ($exe) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ($_.Path -ieq $exe) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Output 'stopped'
exit 0
