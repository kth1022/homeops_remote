[CmdletBinding()]
param(
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $root 'dist'
}

$source = Join-Path $PSScriptRoot 'HomeOpsRemoteTray.cs'
$manifest = Join-Path $PSScriptRoot 'HomeOpsRemoteLauncher.exe.manifest'
$icon = Join-Path $PSScriptRoot 'homeops-remote.ico'
$output = Join-Path $OutputDirectory 'HomeOpsRemoteTray.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) {
    throw 'C# compiler not found in the .NET Framework directories.'
}
if (-not (Test-Path -LiteralPath $icon)) {
    throw "Tray icon not found: $icon"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
& $csc `
    /nologo `
    /target:winexe `
    /platform:anycpu `
    /optimize+ `
    /win32manifest:$manifest `
    /win32icon:$icon `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /out:$output `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "C# compiler failed with exit code $LASTEXITCODE"
}

Copy-Item -LiteralPath $icon -Destination (Join-Path $OutputDirectory 'homeops-remote.ico') -Force
Write-Output "Wrote $output"
