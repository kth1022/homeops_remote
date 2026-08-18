[CmdletBinding()]
param(
    [string]$TaskName = 'HomeOps Home Assistant Monitor',
    [string]$ProjectRoot,
    [string]$At = '07:05'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$tokenPath = Join-Path $ProjectRoot 'config\homeassistant.token.xml'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw "Home Assistant token is not stored yet. Run scripts\Set-HomeAssistantToken.ps1 first."
}

$script = Join-Path $ProjectRoot 'scripts\Invoke-HomeAssistantMonitor.ps1'
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" `
    -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Runs the Home Assistant API monitor and writes reports.' `
    -Force | Out-Null

Write-Output "Registered '$TaskName' daily at $At"
