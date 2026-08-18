param(
  [string]$Root = "C:\Users\kth10\Documents\home-ops"
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $Root

$summary = Get-ChildItem -Path "reports" -Filter "truenas-plex-observation-*.summary.log" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $summary) {
  throw "No Plex observation summary log found."
}

Write-Output "$(Get-Date -Format o) Watching $($summary.FullName)"

$deadline = (Get-Date).AddMinutes(45)
while ((Get-Date) -lt $deadline) {
  $text = Get-Content -LiteralPath $summary.FullName -Raw
  if ($text -match "Plex observation failed") {
    Write-Output "$(Get-Date -Format o) Plex observation failed; Immich recovery will not start."
    exit 2
  }
  if ($text -match "Plex observation passed for 30 minutes") {
    Write-Output "$(Get-Date -Format o) Plex observation passed; running final health/memory guard."
    $guardOut = "reports\truenas-immich-recovery-final-guard-20260815.log"
    $guard = @"
date -Iseconds
docker inspect ix-plex-plex-1 --format 'plex_status={{.State.Status}} plex_health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>&1 || true
curl -fsS --max-time 10 -I http://127.0.0.1:32400/web/index.html 2>&1 | sed -n '1,12p' || true
awk '/MemAvailable/ {print "mem_available_mb=" int(`$2/1024)}' /proc/meminfo
free -h
"@
    node scripts/Invoke-TrueNasCronCommand.js --command $guard --description "codex immich recovery final guard" --output $guardOut --timeout-sec 120 | Out-Host
    $guardText = Get-Content -LiteralPath $guardOut -Raw
    $memMatch = [regex]::Match($guardText, "mem_available_mb=(\d+)")
    $memMb = if ($memMatch.Success) { [int]$memMatch.Groups[1].Value } else { 0 }
    if ($guardText -notmatch "plex_health=healthy" -or $guardText -notmatch "HTTP/1\.1 200 OK" -or $memMb -lt 3072) {
      Write-Output "$(Get-Date -Format o) Final guard failed; Immich recovery will not start. mem_available_mb=$memMb report=$guardOut"
      exit 4
    }
    Write-Output "$(Get-Date -Format o) Plex observation and final guard passed; starting Immich recovery. mem_available_mb=$memMb"
    $out = "reports\truenas-immich-db-recovery-and-start-20260815.log"
    node scripts/Invoke-TrueNasCronCommand.js --command-file logs/truenas-immich-db-recovery-and-start-20260815.sh --description "codex immich db recovery and start" --output $out --timeout-sec 10800
    Write-Output "$(Get-Date -Format o) Immich recovery command finished. Report: $out"
    exit $LASTEXITCODE
  }
  Start-Sleep -Seconds 30
}

Write-Output "$(Get-Date -Format o) Timed out waiting for Plex observation to complete."
exit 3
