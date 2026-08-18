[CmdletBinding()]
param(
    [string]$SubnetPrefix = '192.168.1',
    [int[]]$Ports = @(22, 53, 80, 443, 445, 2049, 3000, 32400, 4357, 8123),
    [int]$Start = 1,
    [int]$End = 254,
    [int]$TimeoutMs = 250,
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '..\reports'
}

function Test-TcpPortFast {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        $open = $async.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($open) { $client.EndConnect($async) }
        return [bool]$open
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$results = foreach ($i in $Start..$End) {
    $hostName = "$SubnetPrefix.$i"
    $openPorts = foreach ($port in $Ports) {
        if (Test-TcpPortFast -HostName $hostName -Port $port -TimeoutMs $TimeoutMs) { $port }
    }
    if (@($openPorts).Count -gt 0) {
        [pscustomobject]@{
            host = $hostName
            openPorts = @($openPorts)
        }
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonPath = Join-Path $OutputDirectory "lan-inventory-$stamp.json"
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
$results | Sort-Object host | Format-Table -AutoSize
Write-Output "Wrote $jsonPath"

