# Starts sing-box elevated (UAC prompt) as a hidden window, then writes its PID.
# Called by lib/vpn-engine.js — not meant to be run by hand.
param(
  [Parameter(Mandatory = $true)][string]$SingBox,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$PidFile
)
$ErrorActionPreference = 'Stop'

# fresh exe copies can be briefly held by the AV scanner — retry a few times
$p = $null
$lastErr = $null
for ($i = 1; $i -le 6; $i++) {
  try {
    $p = Start-Process -FilePath $SingBox `
      -ArgumentList @('run', '-c', $Config) `
      -Verb RunAs -WindowStyle Hidden -PassThru
    break
  } catch {
    $lastErr = $_.Exception.Message
    if ($lastErr -match 'canceled by the user') { break }   # UAC declined — don't retry
    Start-Sleep -Milliseconds 1500
  }
}
if (-not $p) {
  Write-Output ("LAUNCH_FAILED: " + $lastErr)
  exit 1
}
try {
  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
} catch {
  Write-Output ("PID_WRITE_FAILED: " + $_.Exception.Message)
  exit 1
}
Write-Output $p.Id
exit 0
