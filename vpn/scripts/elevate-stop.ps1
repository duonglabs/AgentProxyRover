# Stops the elevated sing-box started by elevate-start.ps1 (UAC prompt).
# An elevated process can ONLY be killed by an admin, and this script is
# spawned NON-elevated by the app — so first relaunch self with RunAs.
# Kills the recorded PID, plus any stray whose image equals our exact
# sing-box.exe path (never other copies of sing-box on this machine).
# Called by lib/vpn-engine.js — not meant to be run by hand.
param(
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$ExePath
)
$ErrorActionPreference = 'Continue'

# ── self-elevate (UAC) — a non-admin Stop-Process on an elevated pid is a
#    silent Access Denied, which is exactly the orphan-blackhole bug ──
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $p = Start-Process -FilePath powershell.exe `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-PidFile', $PidFile, '-ExePath', $ExePath) `
    -Verb RunAs -WindowStyle Hidden -PassThru
  if (-not $p) { Write-Output 'ELEVATE_FAILED'; exit 1 }
  $p.WaitForExit()
  Write-Output ('elevated exit ' + $p.ExitCode)
  exit $p.ExitCode
}

# ── now admin: kill recorded pid, then strays of this exact binary ──
if (Test-Path $PidFile) {
  $pidTarget = (Get-Content $PidFile -ErrorAction SilentlyContinue).Trim()
  if ($pidTarget -match '^\d+$') {
    Stop-Process -Id ([int]$pidTarget) -Force -ErrorAction SilentlyContinue
  }
}
$exe = (Resolve-Path -LiteralPath $ExePath -ErrorAction SilentlyContinue).Path
if ($exe) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ($_.Path -ieq $exe) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}
Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Output 'stopped'
exit 0
