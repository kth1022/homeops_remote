[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe'
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
& $NodePath $serverScript --config $ConfigPath
