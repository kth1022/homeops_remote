[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$EntryId = '01KVP0J4NCFE2V8ENSW5MMB7G1'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$log = Join-Path $ProjectRoot 'logs\homeassistant-actions.log'
$svc = Join-Path $ProjectRoot 'scripts\Invoke-HomeAssistantService.ps1'
$monitor = Join-Path $ProjectRoot 'scripts\Invoke-HomeAssistantMonitor.ps1'

"$(Get-Date -Format o) Alexa cooldown retry starting" | Add-Content -LiteralPath $log
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $svc -Domain homeassistant -Service reload_config_entry -EntryId $EntryId -TimeoutSec 90 -Apply | Out-String | Add-Content -LiteralPath $log
} catch {
    "$(Get-Date -Format o) Alexa cooldown retry reload returned: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
Start-Sleep -Seconds 60
try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $monitor | Out-String | Add-Content -LiteralPath $log
} catch {
    "$(Get-Date -Format o) Alexa cooldown retry monitor returned: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}
"$(Get-Date -Format o) Alexa cooldown retry complete" | Add-Content -LiteralPath $log
