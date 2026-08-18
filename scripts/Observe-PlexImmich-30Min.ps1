param(
  [string]$Root = "C:\Users\kth10\Documents\home-ops",
  [int]$CheckCount = 6,
  [int]$IntervalSeconds = 300,
  [switch]$StopImmichOnFailure
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $Root

$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$summary = Join-Path $Root "reports\truenas-plex-immich-observation-$stamp.summary.log"

function Write-Summary {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $summary -Value $line
  Write-Output $line
}

function Invoke-Check {
  param([int]$Index)

  $out = Join-Path $Root ("reports\truenas-plex-immich-observation-{0}-check-{1}.log" -f $stamp, $Index)
  $checkScript = Join-Path $Root ("logs\truenas-plex-immich-observation-{0}-check-{1}.sh" -f $stamp, $Index)
  $script = @"
date -Iseconds
echo '===== containers ====='
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo '===== unexpected ====='
docker ps --format '{{.Names}}' | while IFS= read -r name; do
  case "`$name" in
    ix-tailscale-*|ix-dockge-*|ix-plex-*|immich_server|immich_machine_learning|immich_redis|immich_postgres) ;;
    *) echo "`$name" ;;
  esac
done
echo '===== health ====='
for c in ix-plex-plex-1 immich_server immich_machine_learning immich_redis immich_postgres ix-dockge-dockge-1 ix-tailscale-tailscale-1; do
  docker inspect "`$c" --format "`$c status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}" 2>&1 || true
done
echo '===== http ====='
echo '-- plex'
curl -fsS --max-time 10 -I http://127.0.0.1:32400/web/index.html 2>&1 | sed -n '1,12p' || true
echo '-- immich'
curl -fsS --max-time 10 http://127.0.0.1:2283/api/server/ping 2>&1 || true
echo
echo '===== db ====='
docker exec immich_postgres psql -U postgres -d immich -Atc "select count(*) from asset;" 2>&1 || true
echo '===== memory ====='
free -m
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@

  [System.IO.File]::WriteAllText($checkScript, $script, [System.Text.UTF8Encoding]::new($false))
  node scripts/Invoke-TrueNasCronCommand.js --command-file $checkScript --description "codex plex immich observation check $Index" --output $out --timeout-sec 120 | Out-Host
  $text = Get-Content -LiteralPath $out -Raw

  $requiredHealthy = @("ix-plex-plex-1", "immich_server", "immich_machine_learning", "immich_redis", "immich_postgres", "ix-dockge-dockge-1", "ix-tailscale-tailscale-1")
  $bad = @()
  foreach ($name in $requiredHealthy) {
    if ($text -notmatch [regex]::Escape("$name status=running health=healthy")) {
      $bad += $name
    }
  }

  $plexOk = $text -match "HTTP/1\.1 200 OK"
  $immichOk = $text -match '\{"res":"pong"\}'
  $assetCount = 0
  $assetMatch = [regex]::Match($text, "(?m)^(?<assets>\d{7,})$")
  if ($assetMatch.Success) {
    $assetCount = [int]$assetMatch.Groups["assets"].Value
  }
  $assetOk = $assetCount -ge 1454528
  $unexpectedBlock = [regex]::Match($text, "===== unexpected =====\r?\n(?<body>.*?)\r?\n===== health =====", "Singleline").Groups["body"].Value.Trim()
  $memLine = [regex]::Match($text, "(?m)^Mem:\s+.*$").Value
  $availableMb = 0
  $memMatch = [regex]::Match($memLine, "^Mem:\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(?<available>\d+)")
  if ($memMatch.Success) {
    $availableMb = [int]$memMatch.Groups["available"].Value
  }

  if ($bad.Count -or -not $plexOk -or -not $immichOk -or -not $assetOk -or $unexpectedBlock -or $availableMb -lt 2048) {
    Write-Summary "FAILED check=$Index bad=[$($bad -join ',')] plexOk=$plexOk immichOk=$immichOk assetOk=$assetOk assetCount=$assetCount availableMb=$availableMb unexpected=[$unexpectedBlock] report=$out"
    return $false
  }

  Write-Summary "PASS check=$Index assetCount=$assetCount availableMb=$availableMb $memLine report=$out"
  return $true
}

function Stop-Immich {
  $out = Join-Path $Root ("reports\truenas-plex-immich-observation-{0}-immich-stop.log" -f $stamp)
  $stopScript = Join-Path $Root ("logs\truenas-plex-immich-observation-{0}-immich-stop.sh" -f $stamp)
  $script = @"
date -Iseconds
echo '===== stopping immich ====='
cd /mnt/Apps/AppData/Stacks/immich && docker compose stop
echo '===== remaining containers ====='
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo '===== memory ====='
free -h
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@
  [System.IO.File]::WriteAllText($stopScript, $script, [System.Text.UTF8Encoding]::new($false))
  node scripts/Invoke-TrueNasCronCommand.js --command-file $stopScript --description "codex stop immich after guarded observation failure" --output $out --timeout-sec 180 | Out-Host
  Write-Summary "Immich stop attempted after observation failure. report=$out"
}

Write-Summary "Starting 30-minute Plex+Immich observation."

for ($i = 0; $i -le $CheckCount; $i += 1) {
  if (-not (Invoke-Check -Index $i)) {
    Write-Summary "Plex+Immich observation failed."
    if ($StopImmichOnFailure) {
      Stop-Immich
    }
    exit 2
  }
  if ($i -lt $CheckCount) {
    Start-Sleep -Seconds $IntervalSeconds
  }
}

$durationMinutes = [math]::Round(($CheckCount * $IntervalSeconds) / 60, 1)
Write-Summary "Plex+Immich observation passed for $durationMinutes minutes."
exit 0
