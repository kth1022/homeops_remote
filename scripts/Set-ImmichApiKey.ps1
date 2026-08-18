[CmdletBinding()]
param(
    [string]$ApiKeyPath,
    [string]$SecretFilePath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ApiKeyPath)) {
    $ApiKeyPath = Join-Path $PSScriptRoot '..\config\immich.api-key.xml'
}

if ((Test-Path -LiteralPath $ApiKeyPath) -and -not $Force) {
    throw "Immich API key file already exists: $ApiKeyPath. Re-run with -Force to replace it."
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
    $secureApiKey = Read-Host -Prompt 'Paste Immich API key' -AsSecureString
}

$secureApiKey | Export-Clixml -LiteralPath $ApiKeyPath
Write-Output "Stored encrypted Immich API key at $ApiKeyPath"
