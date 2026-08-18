[CmdletBinding()]
param(
    [string]$TaskName = 'HomeOps Remote Node',
    [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$remoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$homeOpsRoot = [System.IO.Path]::GetFullPath((Join-Path $remoteRoot '..'))
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $homeOpsRoot 'logs\homeops-remote-watchdog.jsonl'
}

function Write-WatchdogLog {
    param($Entry)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    ($Entry | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $LogPath -Encoding UTF8
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$entry = [ordered]@{
    checkedAt = (Get-Date).ToString('o')
    taskName = $TaskName
    state = [string]$task.State
    action = 'none'
}

if ($task.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $entry.action = 'started'
    $entry.stateAfter = [string]$task.State
}

Write-WatchdogLog -Entry $entry
$entry | ConvertTo-Json -Depth 8
