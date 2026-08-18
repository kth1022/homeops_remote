[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$OutputDirectory,
    [int]$TcpTimeoutMs = 1000,
    [switch]$SkipHttp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot '..\config\devices.json'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '..\reports'
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory)] [string]$HostName,
        [Parameter(Mandatory)] [int]$Port,
        [string]$Name,
        [bool]$Required = $true,
        [int]$TimeoutMs = 1000
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        $open = $async.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($open) {
            $client.EndConnect($async)
        }
        $stopwatch.Stop()
        [pscustomobject]@{
            name = $Name
            host = $HostName
            port = $Port
            open = [bool]$open
            latencyMs = if ($open) { $stopwatch.ElapsedMilliseconds } else { $null }
            required = $Required
            error = $null
        }
    } catch {
        $stopwatch.Stop()
        [pscustomobject]@{
            name = $Name
            host = $HostName
            port = $Port
            open = $false
            latencyMs = $null
            required = $Required
            error = $_.Exception.Message
        }
    } finally {
        $client.Dispose()
    }
}

function Test-HttpEndpoint {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Url,
        [int]$TimeoutSec = 5,
        [bool]$Required = $true
    )

    $handler = $null
    $client = $null
    try {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.ServerCertificateCustomValidationCallback = { $true }
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $response = $client.GetAsync($Url).GetAwaiter().GetResult()
        $sw.Stop()
        [pscustomobject]@{
            name = $Name
            url = $Url
            ok = [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
            statusCode = [int]$response.StatusCode
            latencyMs = $sw.ElapsedMilliseconds
            required = $Required
            error = $null
        }
    } catch {
        [pscustomobject]@{
            name = $Name
            url = $Url
            ok = $false
            statusCode = $null
            latencyMs = $null
            required = $Required
            error = $_.Exception.Message
        }
    } finally {
        if ($null -ne $client) { $client.Dispose() }
        if ($null -ne $handler) { $handler.Dispose() }
    }
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$timestamp = Get-Date
$deviceResults = foreach ($device in $config.devices) {
    $tcpChecks = @()
    if ($device.PSObject.Properties.Name -contains 'ports') {
        $tcpChecks += foreach ($port in $device.ports) {
            [pscustomobject]@{
                name = $null
                port = [int]$port
                required = $true
            }
        }
    }
    if ($device.PSObject.Properties.Name -contains 'tcpChecks') {
        $tcpChecks += foreach ($check in $device.tcpChecks) {
            $required = $true
            if ($check.PSObject.Properties.Name -contains 'required') {
                $required = [bool]$check.required
            }
            [pscustomobject]@{
                name = if ($check.PSObject.Properties.Name -contains 'name') { [string]$check.name } else { $null }
                port = [int]$check.port
                required = $required
            }
        }
    }

    $tcp = foreach ($check in $tcpChecks) {
        Test-TcpPort -HostName $device.host -Port $check.port -Name $check.name -Required $check.required -TimeoutMs $TcpTimeoutMs
    }

    $http = @()
    if (-not $SkipHttp -and $device.PSObject.Properties.Name -contains 'httpChecks') {
        $http = foreach ($check in $device.httpChecks) {
            $required = $true
            if ($check.PSObject.Properties.Name -contains 'required') {
                $required = [bool]$check.required
            }
            Test-HttpEndpoint -Name $check.name -Url $check.url -Required $required
        }
    }

    $expectedTcpDown = @($tcp | Where-Object { -not $_.open -and $_.required })
    $httpDown = @($http | Where-Object { -not $_.ok -and $_.required })

    [pscustomobject]@{
        name = $device.name
        role = $device.role
        host = $device.host
        healthy = ($expectedTcpDown.Count -eq 0 -and $httpDown.Count -eq 0)
        tcp = @($tcp)
        http = @($http)
        findings = @(
            foreach ($closed in $expectedTcpDown) {
                $label = if (-not [string]::IsNullOrWhiteSpace($closed.name)) { " ($($closed.name))" } else { '' }
                "TCP port $($closed.port)$label is not reachable"
            }
            foreach ($bad in $httpDown) { "HTTP check $($bad.name) failed: $($bad.statusCode) $($bad.error)" }
        )
    }
}

$summary = [pscustomobject]@{
    generatedAt = $timestamp.ToString('o')
    computer = $env:COMPUTERNAME
    configPath = (Resolve-Path -LiteralPath $ConfigPath).Path
    healthy = @($deviceResults | Where-Object { -not $_.healthy }).Count -eq 0
    devices = @($deviceResults)
}

$fileStamp = $timestamp.ToString('yyyyMMdd-HHmmss')
$jsonPath = Join-Path $OutputDirectory "homeops-$fileStamp.json"
$mdPath = Join-Path $OutputDirectory 'homeops-latest.md'
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$lines = @()
$lines += "# Home Ops Health - $($timestamp.ToString('yyyy-MM-dd HH:mm:ss'))"
$lines += ''
$lines += 'Overall: ' + $(if ($summary.healthy) { 'HEALTHY' } else { 'ATTENTION NEEDED' })
$lines += ''
foreach ($device in $deviceResults) {
    $lines += "## $($device.name) ($($device.host))"
    $lines += 'Status: ' + $(if ($device.healthy) { 'healthy' } else { 'attention needed' })
    $lines += ''
    $lines += 'TCP:'
    foreach ($tcp in $device.tcp) {
        $state = if ($tcp.open) { 'open' } else { 'closed' }
        $latency = if ($null -ne $tcp.latencyMs) { " $($tcp.latencyMs)ms" } else { '' }
        $label = if (-not [string]::IsNullOrWhiteSpace($tcp.name)) { " $($tcp.name)" } else { '' }
        $optional = if (-not $tcp.required) { ' optional' } else { '' }
        $lines += "- $($tcp.port)$($label): $state$latency$optional"
    }
    if (@($device.http).Count -gt 0) {
        $lines += ''
        $lines += 'HTTP:'
        foreach ($http in $device.http) {
            $state = if ($http.ok) { 'ok' } else { 'failed' }
            $code = if ($null -ne $http.statusCode) { " $($http.statusCode)" } else { '' }
            $optional = if (-not $http.required) { ' optional' } else { '' }
            $lines += "- $($http.name): $state$code$optional"
        }
    }
    if (@($device.findings).Count -gt 0) {
        $lines += ''
        $lines += 'Findings:'
        foreach ($finding in $device.findings) {
            $lines += "- $finding"
        }
    }
    $lines += ''
}
$lines | Set-Content -LiteralPath $mdPath -Encoding UTF8
Write-Output "Wrote $jsonPath"
Write-Output "Wrote $mdPath"
Write-Output $(if ($summary.healthy) { 'HEALTHY' } else { 'ATTENTION NEEDED' })
