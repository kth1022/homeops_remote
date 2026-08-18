[CmdletBinding()]
param(
    [string]$RunDir = '/tmp/immich-untracked-readonly-compare-20260728T053852Z',
    [int]$IntervalSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$metaPath = Join-Path $repo 'reports\immich-compare-current-process.json'

while ($true) {
    $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $meta.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Write-Output "--- compare process exited $(Get-Date -Format o) ---"
        Write-Output 'STDOUT:'
        Get-Content -LiteralPath $meta.Stdout -Tail 80 -ErrorAction SilentlyContinue
        Write-Output 'STDERR:'
        Get-Content -LiteralPath $meta.Stderr -Tail 80 -ErrorAction SilentlyContinue
        break
    }

    Start-Sleep -Seconds $IntervalSeconds
    Write-Output "--- progress $(Get-Date -Format o) ---"
    node .\scripts\Get-ImmichCompareProgress.js $RunDir 2>$null
}
