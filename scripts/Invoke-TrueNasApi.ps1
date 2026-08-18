[CmdletBinding()]
param(
    [ValidateSet('GET','POST')]
    [string]$Method = 'GET',
    [string]$Path = '/api/v2.0/system/info',
    [string]$BodyJson,
    [string]$BodyJsonPath,
    [string]$BaseUrl = 'https://192.168.1.34',
    [string]$ApiKeyPath,
    [int]$TimeoutSec = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

try {
    $baseUri = [Uri]$BaseUrl
} catch {
    throw "Invalid TrueNAS API BaseUrl: $BaseUrl"
}

if ($baseUri.Scheme -ne 'https') {
    throw "Refusing to use TrueNAS API key over insecure transport: $BaseUrl. Use HTTPS/WSS only to avoid API key revocation."
}

if ([string]::IsNullOrWhiteSpace($ApiKeyPath)) {
    $ApiKeyPath = Join-Path $PSScriptRoot '..\config\truenas.api-key.xml'
}
if (-not (Test-Path -LiteralPath $ApiKeyPath)) {
    throw "TrueNAS API key file not found. Run scripts\Set-TrueNasApiKey.ps1 first."
}

function ConvertFrom-SecureStringPlainText {
    param([securestring]$SecureString)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

$secureApiKey = Import-Clixml -LiteralPath $ApiKeyPath
$apiKey = ConvertFrom-SecureStringPlainText -SecureString $secureApiKey
$handler = $null
$client = $null
try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.ServerCertificateCustomValidationCallback = { $true }
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $apiKey)

    $uri = [Uri]::new($baseUri, $Path)
    if (-not [string]::IsNullOrWhiteSpace($BodyJsonPath)) {
        $BodyJson = Get-Content -LiteralPath $BodyJsonPath -Raw
    }

    if ($Method -eq 'GET') {
        $response = $client.GetAsync($uri).GetAwaiter().GetResult()
    } elseif ($Method -eq 'POST') {
        if ([string]::IsNullOrWhiteSpace($BodyJson)) { $BodyJson = '{}' }
        $content = [System.Net.Http.StringContent]::new($BodyJson, [Text.Encoding]::UTF8, 'application/json')
        $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
    }

    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
        throw "TrueNAS API $Method $Path failed with HTTP $([int]$response.StatusCode): $text"
    }
    $text
} finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    $apiKey = $null
}
