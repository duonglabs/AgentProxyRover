# Starts sing-box elevated (UAC prompt) as a hidden window, then writes its PID.
# Called by lib/vpn-engine.js — not meant to be run by hand.
param(
  [Parameter(Mandatory = $true)][string]$SingBox,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$PidFile
)
$ErrorActionPreference = 'Stop'

# NOTE: Windows PowerShell 5.1 joins -ArgumentList elements WITHOUT quoting,
# so paths with spaces must arrive pre-quoted as one string.
$argList = 'run -c "' + $Config + '"'

$p = $null
$lastErr = $null
for ($i = 1; $i -le 6; $i++) {
  try {
    $p = Start-Process -FilePath $SingBox -ArgumentList $argList -Verb RunAs -WindowStyle Hidden -PassThru
    break
  } catch {
    $lastErr = $_.Exception.Message
    # UAC declined (any language spells cancellation its own way — never retry
    # it); retry ONLY the transient AV lock on a freshly copied exe
    if ($lastErr -notmatch 'being used by another process') { break }
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
