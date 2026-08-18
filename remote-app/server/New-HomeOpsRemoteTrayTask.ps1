[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'HomeOps Remote Tray',
    [string]$TrayExePath,
    [switch]$RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($TrayExePath)) {
    $TrayExePath = Join-Path $RemoteRoot 'dist\HomeOpsRemoteTray.exe'
}
if (-not (Test-Path -LiteralPath $TrayExePath)) {
    throw "Tray EXE not found: $TrayExePath"
}

$action = New-ScheduledTaskAction -Execute $TrayExePath -WorkingDirectory (Split-Path -Parent $TrayExePath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($PSCmdlet.ShouldProcess($TaskName, 'Register HomeOps Remote tray scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "Registered scheduled task: $TaskName"

    if ($RunNow) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Started scheduled task: $TaskName"
    }
}
