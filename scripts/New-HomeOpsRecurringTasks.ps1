[CmdletBinding()]
param(
    [string]$TaskNamePrefix = 'HomeOps',
    [string]$ProjectRoot,
    [string]$HealthAt = '07:00',
    [string]$InventoryAt = '07:30',
    [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
    [string]$InventoryDay = 'Sunday'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$healthScript = Join-Path $ProjectRoot 'scripts\Invoke-HomeOpsCheck.ps1'
$inventoryScript = Join-Path $ProjectRoot 'scripts\Invoke-LanInventory.ps1'

$healthAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$healthScript`"" `
    -WorkingDirectory $ProjectRoot
$healthTrigger = New-ScheduledTaskTrigger -Daily -At $HealthAt
$healthSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask `
    -TaskName "$TaskNamePrefix Health Check" `
    -Action $healthAction `
    -Trigger $healthTrigger `
    -Settings $healthSettings `
    -Description 'Runs the local home-ops health check and writes reports.' `
    -Force | Out-Null

$inventoryAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$inventoryScript`"" `
    -WorkingDirectory $ProjectRoot
$inventoryTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $InventoryDay -At $InventoryAt
$inventorySettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask `
    -TaskName "$TaskNamePrefix LAN Inventory" `
    -Action $inventoryAction `
    -Trigger $inventoryTrigger `
    -Settings $inventorySettings `
    -Description 'Runs a weekly LAN service inventory and writes reports.' `
    -Force | Out-Null

Write-Output "Registered '$TaskNamePrefix Health Check' daily at $HealthAt"
Write-Output "Registered '$TaskNamePrefix LAN Inventory' weekly on $InventoryDay at $InventoryAt"
