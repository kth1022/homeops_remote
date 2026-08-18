[CmdletBinding()]
param(
    [string]$TokenPath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TokenPath)) {
    $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
}

if ((Test-Path -LiteralPath $TokenPath) -and -not $Force) {
    throw "Token file already exists: $TokenPath. Re-run with -Force to replace it."
}

$token = Read-Host -Prompt 'Paste Home Assistant long-lived access token' -AsSecureString
$token | Export-Clixml -LiteralPath $TokenPath
Write-Output "Stored encrypted Home Assistant token at $TokenPath"
