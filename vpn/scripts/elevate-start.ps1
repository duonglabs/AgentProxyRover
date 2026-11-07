# Starts sing-box elevated (UAC prompt) as a hidden window, then writes its PID.
# Called by lib/vpn-engine.js — not meant to be run by hand.
param(
  [Parameter(Mandatory = $true)][string]$SingBox,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$PidFile
)
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath $SingBox `
    -ArgumentList @('run', '-c', $Config) `
    -Verb RunAs -WindowStyle Hidden -PassThru
  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
  Write-Output $p.Id
  exit 0
} catch {
  # UAC declined or launcher failure — emit the message, exit non-zero
  Write-Error $_.Exception.Message
  exit 1
}
