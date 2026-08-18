[CmdletBinding()]
param(
    [string]$ApiKeyPath,
    [string]$SecretFilePath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ApiKeyPath)) {
    $ApiKeyPath = Join-Path $PSScriptRoot '..\config\truenas.api-key.xml'
}

if ((Test-Path -LiteralPath $ApiKeyPath) -and -not $Force) {
    throw "TrueNAS API key file already exists: $ApiKeyPath. Re-run with -Force to replace it."
}

if (-not [string]::IsNullOrWhiteSpace($SecretFilePath)) {
    if (-not (Test-Path -LiteralPath $SecretFilePath)) {
        throw "Secret file not found: $SecretFilePath"
    }
    $plain = (Get-Content -LiteralPath $SecretFilePath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw "Secret file is empty: $SecretFilePath"
    }
    $secureApiKey = ConvertTo-SecureString -String $plain -AsPlainText -Force
} else {
    $secureApiKey = Read-Host -Prompt 'Paste TrueNAS API key' -AsSecureString
}

$secureApiKey | Export-Clixml -LiteralPath $ApiKeyPath
Write-Output "Stored encrypted TrueNAS API key at $ApiKeyPath"
