[CmdletBinding()]
param(
    [ValidateSet('GET','POST','PUT','DELETE')]
    [string]$Method = 'GET',
    [string]$Path = '/api/server/ping',
    [string]$BodyJson,
    [string]$BodyJsonPath,
    [string]$BaseUrl = 'http://192.168.1.34:2283',
    [string]$ApiKeyPath,
    [int]$TimeoutSec = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

if ([string]::IsNullOrWhiteSpace($ApiKeyPath)) {
    $ApiKeyPath = Join-Path $PSScriptRoot '..\config\immich.api-key.xml'
}
if (-not (Test-Path -LiteralPath $ApiKeyPath)) {
    throw "Immich API key file not found. Run scripts\Set-ImmichApiKey.ps1 first."
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
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $client.DefaultRequestHeaders.Add('x-api-key', $apiKey)

    $uri = [Uri]::new(([Uri]$BaseUrl), $Path)
    if (-not [string]::IsNullOrWhiteSpace($BodyJsonPath)) {
        $BodyJson = Get-Content -LiteralPath $BodyJsonPath -Raw
    }

    if ($Method -eq 'GET') {
        $response = $client.GetAsync($uri).GetAwaiter().GetResult()
    } elseif ($Method -eq 'POST') {
        if ([string]::IsNullOrWhiteSpace($BodyJson)) { $BodyJson = '{}' }
        $content = [System.Net.Http.StringContent]::new($BodyJson, [Text.Encoding]::UTF8, 'application/json')
        $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
    } elseif ($Method -eq 'PUT') {
        if ([string]::IsNullOrWhiteSpace($BodyJson)) { $BodyJson = '{}' }
        $content = [System.Net.Http.StringContent]::new($BodyJson, [Text.Encoding]::UTF8, 'application/json')
        $response = $client.PutAsync($uri, $content).GetAwaiter().GetResult()
    } elseif ($Method -eq 'DELETE') {
        $response = $client.DeleteAsync($uri).GetAwaiter().GetResult()
    }

    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
        throw "Immich API $Method $Path failed with HTTP $([int]$response.StatusCode): $text"
    }
    $text
} finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    $apiKey = $null
}
