[CmdletBinding()]
param(
    [ValidateSet('GET','POST','DELETE')]
    [string]$Method = 'GET',
    [string]$Path = '/api/',
    [string]$BodyJson,
    [string]$BodyJsonPath,
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$TokenPath,
    [int]$TimeoutSec = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

if ([string]::IsNullOrWhiteSpace($TokenPath)) {
    $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
}
if (-not (Test-Path -LiteralPath $TokenPath)) {
    throw "Home Assistant token file not found. Run scripts\Set-HomeAssistantToken.ps1 first."
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

$secureToken = Import-Clixml -LiteralPath $TokenPath
$token = ConvertFrom-SecureStringPlainText -SecureString $secureToken
$handler = $null
$client = $null
try {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)

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
    } elseif ($Method -eq 'DELETE') {
        $response = $client.DeleteAsync($uri).GetAwaiter().GetResult()
    }

    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
        throw "Home Assistant API $Method $Path failed with HTTP $([int]$response.StatusCode): $text"
    }
    $text
} finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    $token = $null
}

