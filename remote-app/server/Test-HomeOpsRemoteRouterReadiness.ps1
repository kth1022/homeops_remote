[CmdletBinding()]
param(
    [string]$RouterUrl = 'http://192.168.1.1',
    [string]$ControlPcHost = '192.168.1.86',
    [int]$RemotePort = 8787,
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$HomeOpsRoot = [System.IO.Path]::GetFullPath((Join-Path $RemoteRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $HomeOpsRoot 'reports'
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory)] [string]$HostName,
        [Parameter(Mandatory)] [int]$Port,
        [int]$TimeoutMs = 1500
    )

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

function Get-RouterCurrentSetting {
    param([Parameter(Mandatory)] [string]$BaseUrl)

    $url = $BaseUrl.TrimEnd('/') + '/currentsetting.htm'
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
        $settings = [ordered]@{}
        foreach ($line in (($response.Content -replace '<[^>]+>', "`n") -split "`n")) {
            $clean = $line.Trim()
            if ($clean -match '^([^=]+)=(.*)$') {
                $settings[$Matches[1]] = $Matches[2]
            }
        }
        return [ordered]@{
            ok = $true
            url = $url
            settings = $settings
        }
    } catch {
        return [ordered]@{
            ok = $false
            url = $url
            error = $_.Exception.Message
        }
    }
}

$timestamp = Get-Date
$router = Get-RouterCurrentSetting -BaseUrl $RouterUrl
$apiReachable = Test-TcpPort -HostName $ControlPcHost -Port $RemotePort
$routePrint = (& route print -4) -join "`n"
$defaultRoute = (($routePrint -split "`n") | Where-Object { $_ -match '^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+' } | Select-Object -First 1).Trim()

$findings = @()
if (-not $router.ok) {
    $findings += 'Router status endpoint was not reachable from the control PC.'
} elseif ($router.settings.Model -ne 'RBRE960') {
    $findings += "Router model did not match expected RBRE960: $($router.settings.Model)"
}
if (-not $apiReachable) {
    $findings += "HomeOps Remote API is not reachable on $ControlPcHost`:$RemotePort yet."
}
if ($defaultRoute -notmatch '192\.168\.1\.1') {
    $findings += "Default IPv4 route does not appear to use 192.168.1.1: $defaultRoute"
}

$summary = [ordered]@{
    generatedAt = $timestamp.ToString('o')
    router = $router
    controlPc = [ordered]@{
        host = $ControlPcHost
        remotePort = $RemotePort
        apiReachable = $apiReachable
        defaultRoute = $defaultRoute
    }
    policy = [ordered]@{
        exposeWanPortForward = $false
        preferredRemoteAccess = 'VPN to home LAN, then connect to HomeOps Remote on the control PC.'
        doNotForwardPorts = @(8787, 8123, 32400, 22, 445, 2049)
    }
    healthy = ($findings.Count -eq 0)
    findings = @($findings)
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = $timestamp.ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutputDirectory "homeops-remote-readiness-$stamp.json"
$mdPath = Join-Path $OutputDirectory 'homeops-remote-readiness-latest.md'
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$lines = @()
$lines += "# HomeOps Remote Readiness - $($timestamp.ToString('yyyy-MM-dd HH:mm:ss'))"
$lines += ''
$lines += 'Overall: ' + $(if ($summary.healthy) { 'READY' } else { 'ATTENTION NEEDED' })
$lines += ''
$lines += "Router: $($router.settings.Model) firmware $($router.settings.Firmware)"
$lines += "Internet: $($router.settings.InternetConnectionStatus)"
$lines += "Control PC API: $ControlPcHost`:$RemotePort " + $(if ($apiReachable) { 'reachable' } else { 'not reachable' })
$lines += "Default route: $defaultRoute"
$lines += ''
$lines += 'Policy: no WAN port forward to HomeOps Remote; use VPN-only access.'
if ($findings.Count -gt 0) {
    $lines += ''
    $lines += 'Findings:'
    foreach ($finding in $findings) {
        $lines += "- $finding"
    }
}
$lines | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Output "Wrote $jsonPath"
Write-Output "Wrote $mdPath"
Write-Output $(if ($summary.healthy) { 'READY' } else { 'ATTENTION NEEDED' })
