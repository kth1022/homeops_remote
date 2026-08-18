[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string]$Domain,
    [Parameter(Mandatory)] [string]$Service,
    [string]$BodyJson,
    [string]$BodyJsonPath,
    [string[]]$EntityId,
    [string]$EntryId,
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$TokenPath,
    [int]$TimeoutSec = 60,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TokenPath)) {
    $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
}

if (-not [string]::IsNullOrWhiteSpace($BodyJsonPath)) {
    $BodyJson = Get-Content -LiteralPath $BodyJsonPath -Raw
}

if ([string]::IsNullOrWhiteSpace($BodyJson)) {
    $body = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($EntryId)) {
        $body.entry_id = $EntryId
    }
    $entityIds = @($EntityId)
    if ($entityIds.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($entityIds[0])) {
        $body.entity_id = $entityIds[0]
    } elseif ($entityIds.Count -gt 1) {
        $body.entity_id = $entityIds
    }
    $BodyJson = $body | ConvertTo-Json -Compress
}

$path = "/api/services/$Domain/$Service"
if (-not $Apply) {
    Write-Output 'DRY RUN: no Home Assistant service call was sent.'
    Write-Output "Would POST $path"
    Write-Output "Body: $BodyJson"
    Write-Output 'Re-run with -Apply to execute.'
    return
}

$apiScript = Join-Path $PSScriptRoot 'Invoke-HomeAssistantApi.ps1'
& $apiScript -Method POST -Path $path -BodyJson $BodyJson -BaseUrl $BaseUrl -TokenPath $TokenPath -TimeoutSec $TimeoutSec




