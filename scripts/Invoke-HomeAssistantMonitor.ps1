[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$OutputDirectory,
    [string]$TokenPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '..\reports'
}
if ([string]::IsNullOrWhiteSpace($TokenPath)) {
    $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
}

$apiScript = Join-Path $PSScriptRoot 'Invoke-HomeAssistantApi.ps1'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Invoke-HaJson {
    param([string]$Path)
    $raw = & $apiScript -Method GET -Path $Path -BaseUrl $BaseUrl -TokenPath $TokenPath
    ($raw -join "`n") | ConvertFrom-Json
}

function ConvertTo-Items {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    return @($Value)
}

$timestamp = Get-Date
$api = Invoke-HaJson -Path '/api/'
$config = Invoke-HaJson -Path '/api/config'
$states = ConvertTo-Items (Invoke-HaJson -Path '/api/states')
$services = ConvertTo-Items (Invoke-HaJson -Path '/api/services')

$problemStates = @($states | Where-Object { $_.state -in @('unavailable','unknown') } | Sort-Object entity_id)
$batteryStates = @($states | Where-Object {
    $deviceClass = $null
    if ($null -ne $_.attributes -and $_.attributes.PSObject.Properties.Name -contains 'device_class') {
        $deviceClass = [string]$_.attributes.device_class
    }

    $looksLikeBattery = $_.entity_id -like 'sensor.*battery*' -or $deviceClass -eq 'battery'
    if ($looksLikeBattery) {
        $stateText = if ($null -eq $_.state) { '' } else { [string]$_.state }
        $value = 0.0
        $isNumber = [double]::TryParse(
            $stateText,
            [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$value
        )
        $isNumber -and $value -le 20
    } else {
        $false
    }
} | Sort-Object entity_id)

$summary = [pscustomobject]@{
    generatedAt = $timestamp.ToString('o')
    apiMessage = $api.message
    version = $config.version
    locationName = $config.location_name
    timeZone = $config.time_zone
    entityCount = $states.Count
    serviceDomainCount = $services.Count
    unavailableOrUnknownCount = $problemStates.Count
    lowBatteryCount = $batteryStates.Count
    unavailableOrUnknown = @($problemStates | Select-Object entity_id,state,last_changed,last_updated,attributes)
    lowBattery = @($batteryStates | Select-Object entity_id,state,last_changed,last_updated,attributes)
}

$stamp = $timestamp.ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutputDirectory "homeassistant-$stamp.json"
$mdPath = Join-Path $OutputDirectory 'homeassistant-latest.md'
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$lines = @()
$lines += "# Home Assistant Monitor - $($timestamp.ToString('yyyy-MM-dd HH:mm:ss'))"
$lines += ''
$lines += "API: $($summary.apiMessage)"
$lines += "Version: $($summary.version)"
$lines += "Entity count: $($summary.entityCount)"
$lines += "Service domains: $($summary.serviceDomainCount)"
$lines += "Unavailable/unknown entities: $($summary.unavailableOrUnknownCount)"
$lines += "Low battery entities: $($summary.lowBatteryCount)"
$lines += ''
if ($problemStates.Count -gt 0) {
    $lines += '## Unavailable Or Unknown'
    foreach ($state in $problemStates) {
        $friendly = $state.attributes.friendly_name
        if ([string]::IsNullOrWhiteSpace($friendly)) { $friendly = $state.entity_id }
        $lines += "- $($state.entity_id) [$($state.state)] - $friendly"
    }
    $lines += ''
}
if ($batteryStates.Count -gt 0) {
    $lines += '## Low Battery'
    foreach ($state in $batteryStates) {
        $friendly = $state.attributes.friendly_name
        if ([string]::IsNullOrWhiteSpace($friendly)) { $friendly = $state.entity_id }
        $lines += "- $($state.entity_id): $($state.state)% - $friendly"
    }
    $lines += ''
}
if ($problemStates.Count -eq 0 -and $batteryStates.Count -eq 0) {
    $lines += 'No unavailable/unknown entities or low battery sensors found.'
}
$lines | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Output "Wrote $jsonPath"
Write-Output "Wrote $mdPath"
Write-Output $(if ($problemStates.Count -eq 0 -and $batteryStates.Count -eq 0) { 'HEALTHY' } else { 'ATTENTION NEEDED' })
