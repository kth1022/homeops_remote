[CmdletBinding()]
param(
    [string]$TaskName = 'HomeOps Health Check',
    [string]$ProjectRoot,
    [string]$At = '07:00'
)

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$script = Join-Path $ProjectRoot 'scripts\Invoke-HomeOpsCheck.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Runs the local home-ops health check and writes reports.' -Force
Write-Output "Registered scheduled task '$TaskName' at $At"

