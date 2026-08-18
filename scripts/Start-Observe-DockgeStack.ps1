param(
  [Parameter(Mandatory = $true)][string]$Stack,
  [Parameter(Mandatory = $true)][string[]]$AllowedContainers,
  [Parameter(Mandatory = $true)][string[]]$ExpectedContainers,
  [string[]]$HttpChecks = @(),
  [string]$Root = "C:\Users\kth10\Documents\home-ops",
  [int]$CheckCount = 6,
  [int]$IntervalSeconds = 300,
  [int]$MinAvailableMb = 2048,
  [switch]$StopStackOnFailure
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $Root

$AllowedContainers = @(
  $AllowedContainers |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
$ExpectedContainers = @(
  $ExpectedContainers |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
$HttpChecks = @(
  $HttpChecks |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
$AllowedContainers = @($AllowedContainers + $ExpectedContainers | Select-Object -Unique)

$stamp = Get-Date -Format "yyyyMMddTHHmmss"
$summary = Join-Path $Root "reports\truenas-$Stack-observation-$stamp.summary.log"

function Write-Summary {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $summary -Value $line
  Write-Output $line
}

function New-RemoteScript {
  param([string]$Name, [string]$Content)
  $path = Join-Path $Root ("logs\truenas-$Stack-$stamp-$Name.sh")
  [System.IO.File]::WriteAllText($path, $Content, [System.Text.UTF8Encoding]::new($false))
  return $path
}

function Invoke-RemoteScript {
  param([string]$Name, [string]$Script, [int]$TimeoutSec = 180)
  $scriptPath = New-RemoteScript -Name $Name -Content $Script
  $out = Join-Path $Root ("reports\truenas-$Stack-$stamp-$Name.log")
  node scripts/Invoke-TrueNasCronCommand.js --command-file $scriptPath --description "codex $Stack $Name" --output $out --timeout-sec $TimeoutSec | Out-Host
  return $out
}

function Stop-Stack {
  $script = @"
date -Iseconds
cd /mnt/Apps/AppData/Stacks/$Stack && docker compose stop
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
free -h
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@
  $out = Invoke-RemoteScript -Name "stop" -Script $script -TimeoutSec 180
  Write-Summary "Stop attempted for $Stack. report=$out"
}

$expectedShell = ($ExpectedContainers -join " ")
$httpShell = ($HttpChecks -join " ")

Write-Summary "Starting stack=$Stack."

$startScript = @"
date -Iseconds
echo '===== compose up ====='
cd /mnt/Apps/AppData/Stacks/$Stack && docker compose up -d
echo '===== compose ps ====='
cd /mnt/Apps/AppData/Stacks/$Stack && docker compose ps -a
echo '===== containers ====='
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo '===== memory ====='
free -h
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@
$startReport = Invoke-RemoteScript -Name "start" -Script $startScript -TimeoutSec 300
Write-Summary "Start command completed. report=$startReport"

function Invoke-Check {
  param([int]$Index)

  $checkScript = @"
date -Iseconds
echo '===== containers ====='
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
echo '===== unexpected ====='
docker ps --format '{{.Names}}' | while IFS= read -r name; do
  case "`$name" in
    ix-tailscale-*|ix-dockge-*|ix-plex-*|immich_server|immich_machine_learning|immich_redis|immich_postgres|$($AllowedContainers -join '|')) ;;
    *) echo "`$name" ;;
  esac
done
echo '===== expected inspect ====='
for c in $expectedShell; do
  docker inspect "`$c" --format "`$c status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}" 2>&1 || true
done
echo '===== http ====='
for url in $httpShell; do
  echo "-- `$url"
  curl -fsS --max-time 15 -I "`$url" 2>&1 | sed -n '1,12p' || curl -fsS --max-time 15 "`$url" 2>&1 | sed -n '1,20p' || true
done
echo '===== docker stats ====='
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.BlockIO}}' 2>&1 || true
echo '===== memory ====='
free -m
echo arc_max=`$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true)
"@
  $report = Invoke-RemoteScript -Name "check-$Index" -Script $checkScript -TimeoutSec 180
  $text = Get-Content -LiteralPath $report -Raw

  $bad = @()
  foreach ($name in $ExpectedContainers) {
    if ($text -notmatch [regex]::Escape("$name status=running")) {
      $bad += $name
    }
  }

  $unexpectedBlock = [regex]::Match($text, "===== unexpected =====\r?\n(?<body>.*?)\r?\n===== expected inspect =====", "Singleline").Groups["body"].Value.Trim()
  $memLine = [regex]::Match($text, "(?m)^Mem:\s+.*$").Value
  $availableMb = 0
  $memMatch = [regex]::Match($memLine, "^Mem:\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(?<available>\d+)")
  if ($memMatch.Success) {
    $availableMb = [int]$memMatch.Groups["available"].Value
  }

  $httpOk = $true
  foreach ($url in $HttpChecks) {
    $urlPattern = [regex]::Escape("-- $url")
    $httpBlock = [regex]::Match($text, "$urlPattern\r?\n(?<body>.*?)(\r?\n-- |\r?\n===== docker stats =====)", "Singleline").Groups["body"].Value
    if (-not $httpBlock -or $httpBlock -notmatch "HTTP/[0-9.]+\s+\d{3}") {
      $httpOk = $false
    }
  }

  if ($bad.Count -or $unexpectedBlock -or $availableMb -lt $MinAvailableMb -or -not $httpOk) {
    Write-Summary "FAILED check=$Index bad=[$($bad -join ',')] httpOk=$httpOk availableMb=$availableMb unexpected=[$unexpectedBlock] report=$report"
    return $false
  }

  Write-Summary "PASS check=$Index availableMb=$availableMb $memLine report=$report"
  return $true
}

for ($i = 0; $i -le $CheckCount; $i += 1) {
  if (-not (Invoke-Check -Index $i)) {
    Write-Summary "Observation failed for $Stack."
    if ($StopStackOnFailure) {
      Stop-Stack
    }
    exit 2
  }
  if ($i -lt $CheckCount) {
    Start-Sleep -Seconds $IntervalSeconds
  }
}

$durationMinutes = [math]::Round(($CheckCount * $IntervalSeconds) / 60, 1)
Write-Summary "Observation passed for $Stack over $durationMinutes minutes."
exit 0
