[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$HomeOpsRoot,
    [int]$Port = 8787,
    [string[]]$ListenPrefixes,
    [string]$TokenOutputPath,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $RemoteRoot 'config\homeops.remote.json'
}
if ([string]::IsNullOrWhiteSpace($HomeOpsRoot)) {
    $HomeOpsRoot = [System.IO.Path]::GetFullPath((Join-Path $RemoteRoot '..'))
}
$ListenPrefixes = @(@($ListenPrefixes) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
if ($ListenPrefixes.Count -eq 0) {
    $ListenPrefixes = @(
        "http://127.0.0.1:$Port/",
        "http://192.168.1.86:$Port/"
    )
}

if ((Test-Path -LiteralPath $ConfigPath) -and -not $Force) {
    throw "Config already exists: $ConfigPath. Re-run with -Force to rotate the token."
}

function New-RemoteToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }

    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)] [string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

$token = New-RemoteToken
$tokenHash = Get-Sha256Hex -Text $token
$HomeOpsRoot = [System.IO.Path]::GetFullPath($HomeOpsRoot)
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$logPath = Join-Path $HomeOpsRoot 'logs\remote-commands.jsonl'
$DefaultTokenFile = Join-Path $RemoteRoot 'config\homeops.remote.token.txt'

$config = [ordered]@{
    listenPrefixes = @($ListenPrefixes)
    homeOpsRoot = $HomeOpsRoot
    tokenHash = $tokenHash
    allowedRemoteCidrs = @(
        '127.0.0.1/32',
        '192.168.1.0/24',
        '10.8.0.0/24',
        '100.64.0.0/10'
    )
    allowedRemoteAddresses = @('::1')
    allowMutatingActions = $false
    commandLogPath = $logPath
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DefaultTokenFile) | Out-Null
$token | Set-Content -LiteralPath $DefaultTokenFile -Encoding UTF8
Write-Output "Wrote local tool token to $DefaultTokenFile"

if (-not [string]::IsNullOrWhiteSpace($TokenOutputPath)) {
    $TokenOutputPath = [System.IO.Path]::GetFullPath($TokenOutputPath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TokenOutputPath) | Out-Null
    $token | Set-Content -LiteralPath $TokenOutputPath -Encoding UTF8
    Write-Output "Wrote token to $TokenOutputPath"
} else {
    Write-Output "HomeOps Remote token:"
    Write-Output $token
}

Write-Output "Wrote config to $ConfigPath"
Write-Output "Keep the token private. Re-run this script with -Force to rotate it."


