[CmdletBinding()]
param(
    [string]$CredentialPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CredentialPath)) {
    $CredentialPath = Join-Path $PSScriptRoot '..\config\router.credential.xml'
}

if (-not (Test-Path -LiteralPath $CredentialPath)) {
    throw "Router credential file not found: $CredentialPath"
}

Import-Clixml -LiteralPath $CredentialPath
