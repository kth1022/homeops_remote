[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath,
    [string]$TaskName = 'HomeOps Remote Node',
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [switch]$RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $RemoteRoot 'config\homeops.remote.json'
}
if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node not found at $NodePath"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Remote config not found: $ConfigPath. Run New-HomeOpsRemoteToken.ps1 first."
}

$serverScript = Join-Path $PSScriptRoot 'homeops-remote.mjs'
$arguments = "`"$serverScript`" --config `"$ConfigPath`""
$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if ($PSCmdlet.ShouldProcess($TaskName, 'Register HomeOps Remote Node scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "Registered scheduled task: $TaskName"

    if ($RunNow) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Started scheduled task: $TaskName"
    }
}

