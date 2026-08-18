[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$TokenPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TokenPath)) {
    $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
}

$apiScript = Join-Path $PSScriptRoot 'Invoke-HomeAssistantApi.ps1'
function Get-HaJson {
    param([string]$Path)
    $raw = & $apiScript -Method GET -Path $Path -BaseUrl $BaseUrl -TokenPath $TokenPath
    ($raw -join "`n") | ConvertFrom-Json
}
function As-Items {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

$api = Get-HaJson -Path '/api/'
$config = Get-HaJson -Path '/api/config'
$states = As-Items (Get-HaJson -Path '/api/states')
$services = As-Items (Get-HaJson -Path '/api/services')

[pscustomobject]@{
    ApiMessage = $api.message
    Version = $config.version
    EntityCount = $states.Count
    ServiceDomainCount = $services.Count
    FirstEntity = if ($states.Count -gt 0) { $states[0].entity_id } else { '' }
    FirstServiceDomain = if ($services.Count -gt 0) { $services[0].domain } else { '' }
} | Format-List
