param(
  [string]$Root = "C:\Users\kth10\Documents\home-ops"
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $Root

$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$summary = Join-Path $Root "reports\truenas-plex-observation-$stamp.summary.log"

function Write-Summary {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $summary -Value $line
  Write-Output $line
}

function Invoke-Check {
  param([int]$Index)
  $out = Join-Path $Root ("reports\truenas-plex-observation-{0}-check-{1}.log" -f $stamp, $Index)
  $script = @"
date -Iseconds
echo '===== containers ====='
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo '===== unexpected ====='
docker ps --format '{{.Names}}' | while IFS= read -r name; do
  case "`$name" in
    ix-tailscale-*|ix-dockge-*|ix-plex-*|plex) ;;
    *) echo "`$name" ;;
  esac
done
echo '===== plex-health ====='
docker inspect ix-plex-plex-1 --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>&1 || true
echo '===== plex-http ====='
curl -fsS --max-time 10 -I http://127.0.0.1:32400/web/index.html 2>&1 | sed -n '1,12p' || true
echo '===== memory ====='
free -h
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@
  node scripts/Invoke-TrueNasCronCommand.js --command $script --description "codex plex observation check $Index" --output $out --timeout-sec 120 | Out-Host
  $text = Get-Content -LiteralPath $out -Raw
  $healthy = $text -match "health=healthy"
  $httpOk = $text -match "HTTP/1\.1 200 OK"
  $unexpectedBlock = [regex]::Match($text, "===== unexpected =====\r?\n(?<body>.*?)\r?\n===== plex-health =====", "Singleline").Groups["body"].Value.Trim()
  if (-not $healthy -or -not $httpOk -or $unexpectedBlock) {
    Write-Summary "FAILED check=$Index healthy=$healthy httpOk=$httpOk unexpected=[$unexpectedBlock] report=$out"
    return $false
  }
  $memLine = ([regex]::Match($text, "Mem:\s+.*").Value)
  Write-Summary "PASS check=$Index $memLine report=$out"
  return $true
}

Write-Summary "Starting 30-minute Plex observation."

for ($i = 0; $i -le 6; $i += 1) {
  if (-not (Invoke-Check -Index $i)) {
    Write-Summary "Plex observation failed; not proceeding to Immich."
    exit 2
  }
  if ($i -lt 6) {
    Start-Sleep -Seconds 300
  }
}

Write-Summary "Plex observation passed for 30 minutes."
exit 0
