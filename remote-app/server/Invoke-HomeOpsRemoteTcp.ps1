[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string[]]$ListenPrefix,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PSScriptRoot '..\config\homeops.remote.json'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Remote config not found: $ConfigPath. Run server\New-HomeOpsRemoteToken.ps1 first."
}

$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$RemoteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AppRoot = [System.IO.Path]::GetFullPath((Join-Path $RemoteRoot 'app'))
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

function Get-ConfigValue {
    param([Parameter(Mandatory)] [string]$Name, $DefaultValue)
    if ($Config.PSObject.Properties.Name -contains $Name -and $null -ne $Config.$Name) {
        return $Config.$Name
    }
    return $DefaultValue
}

$ListenPrefix = @(@($ListenPrefix) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
if ($ListenPrefix.Count -eq 0) {
    $ListenPrefix = @((Get-ConfigValue -Name 'listenPrefixes' -DefaultValue @('http://127.0.0.1:8787/')))
}

$HomeOpsRoot = [System.IO.Path]::GetFullPath((Get-ConfigValue -Name 'homeOpsRoot' -DefaultValue (Join-Path $RemoteRoot '..')))
$ReportsRoot = Join-Path $HomeOpsRoot 'reports'
$ScriptsRoot = Join-Path $HomeOpsRoot 'scripts'
$TokenHash = [string](Get-ConfigValue -Name 'tokenHash' -DefaultValue '')
$AllowedRemoteCidrs = @((Get-ConfigValue -Name 'allowedRemoteCidrs' -DefaultValue @('127.0.0.1/32')))
$AllowedRemoteAddresses = @((Get-ConfigValue -Name 'allowedRemoteAddresses' -DefaultValue @('::1')))
$AllowMutatingActions = [bool](Get-ConfigValue -Name 'allowMutatingActions' -DefaultValue $false)
$CommandLogPath = [string](Get-ConfigValue -Name 'commandLogPath' -DefaultValue (Join-Path $HomeOpsRoot 'logs\remote-commands.jsonl'))
$ServerStartedAt = Get-Date

if ([string]::IsNullOrWhiteSpace($TokenHash) -or $TokenHash -like 'replace-*') {
    throw "Remote token hash is not configured. Run server\New-HomeOpsRemoteToken.ps1."
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)] [string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-TokenHash {
    param([string]$ProvidedToken, [string]$ExpectedHash)
    if ([string]::IsNullOrWhiteSpace($ProvidedToken)) { return $false }
    $actual = Get-Sha256Hex -Text $ProvidedToken
    if ($actual.Length -ne $ExpectedHash.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $actual.Length; $i++) {
        $diff = $diff -bor ([byte][char]$actual[$i] -bxor [byte][char]$ExpectedHash[$i])
    }
    return ($diff -eq 0)
}

function Test-IPv4Cidr {
    param([Parameter(Mandatory)] [string]$Address, [Parameter(Mandatory)] [string]$Cidr)
    $parts = $Cidr.Split('/')
    if ($parts.Count -ne 2) { return $false }
    $prefixLength = 0
    if (-not [int]::TryParse($parts[1], [ref]$prefixLength)) { return $false }
    if ($prefixLength -lt 0 -or $prefixLength -gt 32) { return $false }
    $addrObj = $null
    $networkObj = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$addrObj)) { return $false }
    if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$networkObj)) { return $false }
    if ($addrObj.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    if ($networkObj.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }

    $addrBytes = $addrObj.GetAddressBytes()
    $networkBytes = $networkObj.GetAddressBytes()
    $bitsRemaining = $prefixLength
    for ($i = 0; $i -lt 4; $i++) {
        $mask = 0
        if ($bitsRemaining -ge 8) {
            $mask = 255
        } elseif ($bitsRemaining -gt 0) {
            $mask = 256 - [math]::Pow(2, 8 - $bitsRemaining)
        }
        if (([int]$addrBytes[$i] -band [int]$mask) -ne ([int]$networkBytes[$i] -band [int]$mask)) {
            return $false
        }
        $bitsRemaining -= 8
        if ($bitsRemaining -lt 0) { $bitsRemaining = 0 }
    }
    return $true
}

function Test-RemoteAddressAllowed {
    param([Parameter(Mandatory)] [string]$Address)
    foreach ($allowed in $AllowedRemoteAddresses) {
        if ($Address -eq [string]$allowed) { return $true }
    }
    foreach ($cidr in $AllowedRemoteCidrs) {
        if (Test-IPv4Cidr -Address $Address -Cidr ([string]$cidr)) { return $true }
    }
    return $false
}

function Get-ReasonPhrase {
    param([int]$StatusCode)
    switch ($StatusCode) {
        200 { 'OK' }
        204 { 'No Content' }
        400 { 'Bad Request' }
        401 { 'Unauthorized' }
        403 { 'Forbidden' }
        404 { 'Not Found' }
        500 { 'Internal Server Error' }
        default { 'OK' }
    }
}

function Send-Response {
    param(
        [Parameter(Mandatory)] $Request,
        [int]$StatusCode = 200,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [byte[]]$BodyBytes = ([byte[]]@()),
        [hashtable]$Headers = @{}
    )
    $reason = Get-ReasonPhrase -StatusCode $StatusCode
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("HTTP/1.1 $StatusCode $reason")
    $lines.Add("Content-Length: $($BodyBytes.Length)")
    $lines.Add("Content-Type: $ContentType")
    $lines.Add('Connection: close')
    $lines.Add('X-Content-Type-Options: nosniff')
    $lines.Add('Access-Control-Allow-Origin: *')
    $lines.Add('Access-Control-Allow-Headers: Authorization, Content-Type, X-HomeOps-Token')
    $lines.Add('Access-Control-Allow-Methods: GET, POST, OPTIONS')
    foreach ($key in $Headers.Keys) {
        $lines.Add("${key}: $($Headers[$key])")
    }
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
    $Request.Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($BodyBytes.Length -gt 0) {
        $Request.Stream.Write($BodyBytes, 0, $BodyBytes.Length)
    }
    $Request.Client.Close()
}

function Send-Text {
    param($Request, [int]$StatusCode = 200, [string]$Text = '', [string]$ContentType = 'text/plain; charset=utf-8')
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    Send-Response -Request $Request -StatusCode $StatusCode -ContentType $ContentType -BodyBytes $bytes
}

function Send-Json {
    param($Request, [int]$StatusCode = 200, [Parameter(Mandatory)] $Body)
    $json = $Body | ConvertTo-Json -Depth 24
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Send-Response -Request $Request -StatusCode $StatusCode -ContentType 'application/json; charset=utf-8' -BodyBytes $bytes -Headers @{ 'Cache-Control' = 'no-store' }
}

function Find-HeaderEnd {
    param([byte[]]$Bytes, [int]$Length)
    for ($i = 0; $i -le ($Length - 4); $i++) {
        if ($Bytes[$i] -eq 13 -and $Bytes[$i + 1] -eq 10 -and $Bytes[$i + 2] -eq 13 -and $Bytes[$i + 3] -eq 10) {
            return $i
        }
    }
    return -1
}

function Read-HttpRequest {
    param([Parameter(Mandatory)] [System.Net.Sockets.TcpClient]$Client)
    $stream = $Client.GetStream()
    $buffer = New-Object byte[] 8192
    $memory = [System.IO.MemoryStream]::new()
    $headerEnd = -1

    while ($headerEnd -lt 0) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { throw 'Client disconnected before sending headers.' }
        $memory.Write($buffer, 0, $read)
        $bytes = $memory.ToArray()
        $headerEnd = Find-HeaderEnd -Bytes $bytes -Length $bytes.Length
        if ($memory.Length -gt 1048576) { throw 'HTTP headers are too large.' }
    }

    $allBytes = $memory.ToArray()
    $headerText = [System.Text.Encoding]::ASCII.GetString($allBytes, 0, $headerEnd)
    $lines = $headerText -split "`r?`n"
    if ($lines.Count -eq 0) { throw 'Missing request line.' }
    $requestParts = $lines[0].Split(' ')
    if ($requestParts.Count -lt 2) { throw "Invalid request line: $($lines[0])" }

    $headers = New-Object 'System.Collections.Hashtable' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($line in @($lines | Select-Object -Skip 1)) {
        $colon = $line.IndexOf(':')
        if ($colon -gt 0) {
            $name = $line.Substring(0, $colon).Trim()
            $value = $line.Substring($colon + 1).Trim()
            $headers[$name] = $value
        }
    }

    $contentLength = 0
    if ($headers.ContainsKey('Content-Length')) {
        [void][int]::TryParse([string]$headers['Content-Length'], [ref]$contentLength)
    }

    $bodyStart = $headerEnd + 4
    while (($allBytes.Length - $bodyStart) -lt $contentLength) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { break }
        $memory.Write($buffer, 0, $read)
        $allBytes = $memory.ToArray()
    }

    $bodyText = ''
    if ($contentLength -gt 0 -and $allBytes.Length -ge ($bodyStart + $contentLength)) {
        $bodyText = [System.Text.Encoding]::UTF8.GetString($allBytes, $bodyStart, $contentLength)
    }

    $targetParts = $requestParts[1] -split '\?', 2
    [pscustomobject]@{
        Client = $Client
        Stream = $stream
        Method = $requestParts[0].ToUpperInvariant()
        Target = $requestParts[1]
        Path = [System.Uri]::UnescapeDataString($targetParts[0])
        Headers = $headers
        BodyText = $bodyText
        RemoteAddress = $Client.Client.RemoteEndPoint.Address.ToString()
    }
}

function Get-HeaderToken {
    param($Request)
    $authorization = [string]$Request.Headers['Authorization']
    if (-not [string]::IsNullOrWhiteSpace($authorization) -and $authorization -match '^Bearer\s+(.+)$') {
        return $Matches[1].Trim()
    }
    $headerToken = [string]$Request.Headers['X-HomeOps-Token']
    if (-not [string]::IsNullOrWhiteSpace($headerToken)) { return $headerToken.Trim() }
    return ''
}

function Test-ApiAccess {
    param($Request)
    if (-not (Test-RemoteAddressAllowed -Address $Request.RemoteAddress)) {
        Send-Json -Request $Request -StatusCode 403 -Body @{ ok = $false; error = "Remote address is not allowed: $($Request.RemoteAddress)" }
        return $false
    }
    if (-not (Test-TokenHash -ProvidedToken (Get-HeaderToken -Request $Request) -ExpectedHash $TokenHash)) {
        Send-Json -Request $Request -StatusCode 401 -Body @{ ok = $false; error = 'Missing or invalid HomeOps Remote token.' }
        return $false
    }
    return $true
}

function Read-JsonBody {
    param($Request)
    if ([string]::IsNullOrWhiteSpace($Request.BodyText)) { return [pscustomobject]@{} }
    try {
        return ($Request.BodyText | ConvertFrom-Json)
    } catch {
        throw "Invalid JSON body: $($_.Exception.Message)"
    }
}

function Get-LatestJsonReport {
    param([Parameter(Mandatory)] [string]$Pattern)
    if (-not (Test-Path -LiteralPath $ReportsRoot)) { return $null }
    $file = Get-ChildItem -LiteralPath $ReportsRoot -Filter $Pattern -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $file) { return $null }
    try {
        [ordered]@{ path = $file.FullName; generatedAt = $file.LastWriteTime.ToString('o'); data = (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json) }
    } catch {
        [ordered]@{ path = $file.FullName; generatedAt = $file.LastWriteTime.ToString('o'); error = $_.Exception.Message }
    }
}

function Get-CompactHomeOpsReport {
    $report = Get-LatestJsonReport -Pattern 'homeops-*.json'
    if ($null -eq $report -or $null -eq $report.data) { return $report }
    $data = $report.data
    $report.data = [ordered]@{
        generatedAt = $data.generatedAt
        computer = $data.computer
        healthy = $data.healthy
        devices = @($data.devices | ForEach-Object {
            [ordered]@{
                name = $_.name
                role = $_.role
                host = $_.host
                healthy = $_.healthy
                tcp = @($_.tcp | ForEach-Object { [ordered]@{ port = $_.port; open = $_.open; latencyMs = $_.latencyMs } })
                http = @($_.http | ForEach-Object { [ordered]@{ name = $_.name; ok = $_.ok; statusCode = $_.statusCode; required = $_.required } })
                findings = @($_.findings)
            }
        })
    }
    return $report
}

function Get-CompactHomeAssistantReport {
    $report = Get-LatestJsonReport -Pattern 'homeassistant-*.json'
    if ($null -eq $report -or $null -eq $report.data) { return $report }
    $data = $report.data
    $report.data = [ordered]@{
        generatedAt = $data.generatedAt
        apiMessage = $data.apiMessage
        version = $data.version
        locationName = $data.locationName
        timeZone = $data.timeZone
        entityCount = $data.entityCount
        serviceDomainCount = $data.serviceDomainCount
        unavailableOrUnknownCount = $data.unavailableOrUnknownCount
        lowBatteryCount = $data.lowBatteryCount
        unavailableOrUnknown = @($data.unavailableOrUnknown | Select-Object -First 24 | ForEach-Object {
            $friendly = $null
            if ($null -ne $_.attributes -and $_.attributes.PSObject.Properties.Name -contains 'friendly_name') { $friendly = $_.attributes.friendly_name }
            [ordered]@{ entity_id = $_.entity_id; state = $_.state; attributes = [ordered]@{ friendly_name = $friendly } }
        })
        lowBattery = @($data.lowBattery | Select-Object -First 24 | ForEach-Object {
            $friendly = $null
            if ($null -ne $_.attributes -and $_.attributes.PSObject.Properties.Name -contains 'friendly_name') { $friendly = $_.attributes.friendly_name }
            [ordered]@{ entity_id = $_.entity_id; state = $_.state; attributes = [ordered]@{ friendly_name = $friendly } }
        })
    }
    return $report
}
function Get-TextReport {
    param([Parameter(Mandatory)] [string]$Name)
    $path = Join-Path $ReportsRoot $Name
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    [ordered]@{ path = $path; generatedAt = (Get-Item -LiteralPath $path).LastWriteTime.ToString('o'); text = (Get-Content -LiteralPath $path -Raw) }
}

function Get-ActionManifest {
    @(
        [ordered]@{ id = 'homeops.check'; label = 'HomeOps Check'; description = 'Refresh router, TrueNAS/Plex, and Home Assistant reachability.'; mutating = $false },
        [ordered]@{ id = 'homeassistant.monitor'; label = 'Home Assistant Monitor'; description = 'Refresh Home Assistant API, entity, service, and battery summary.'; mutating = $false },
        [ordered]@{ id = 'lan.inventory'; label = 'LAN Inventory'; description = 'Scan known LAN service ports and write an inventory report.'; mutating = $false },
        [ordered]@{ id = 'message'; label = 'Message'; description = 'Record a remote instruction for Codex review.'; mutating = $false }
    )
}

function Get-StatusPayload {
    [ordered]@{
        ok = $true
        generatedAt = (Get-Date).ToString('o')
        server = [ordered]@{
            computer = $env:COMPUTERNAME
            startedAt = $ServerStartedAt.ToString('o')
            homeOpsRoot = $HomeOpsRoot
            listenPrefixes = @($ListenPrefix)
            allowMutatingActions = $AllowMutatingActions
        }
        actions = @(Get-ActionManifest)
        homeops = Get-CompactHomeOpsReport
        homeassistant = Get-CompactHomeAssistantReport
        summaries = [ordered]@{
            homeops = Get-TextReport -Name 'homeops-latest.md'
            homeassistant = Get-TextReport -Name 'homeassistant-latest.md'
        }
    }
}

function Quote-PSArgument {
    param([AllowNull()] [string]$Value)
    if ($null -eq $Value) { return "''" }
    return "'" + ($Value -replace "'", "''") + "'"
}

function Invoke-ExternalScript {
    param([Parameter(Mandatory)] [string]$ScriptName, [string]$ArgumentString = '', [int]$TimeoutSec = 120)
    $scriptPath = Join-Path $ScriptsRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Script not found: $scriptPath" }
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $powershellPath
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File $(Quote-PSArgument $scriptPath) $ArgumentString"
    $psi.WorkingDirectory = $HomeOpsRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $started = Get-Date
    $null = $process.Start()
    if (-not $process.WaitForExit($TimeoutSec * 1000)) {
        try { $process.Kill() } catch {}
        throw "Command timed out after $TimeoutSec seconds: $ScriptName"
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    if ($process.ExitCode -ne 0) {
        throw "Command failed with exit code $($process.ExitCode): $stderr $stdout"
    }
    [ordered]@{ script = $ScriptName; startedAt = $started.ToString('o'); finishedAt = (Get-Date).ToString('o'); exitCode = $process.ExitCode; output = $stdout.Trim(); error = $stderr.Trim() }
}

function Write-CommandLog {
    param([Parameter(Mandatory)] $Entry)
    $directory = Split-Path -Parent $CommandLogPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    ($Entry | ConvertTo-Json -Depth 16 -Compress) | Add-Content -LiteralPath $CommandLogPath -Encoding UTF8
}

function Get-RecentCommandLog {
    param([int]$Limit = 50)
    if (-not (Test-Path -LiteralPath $CommandLogPath)) { return @() }
    @(Get-Content -LiteralPath $CommandLogPath -Tail $Limit | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $null -ne $_ })
}

function Get-BodyString {
    param($Body, [Parameter(Mandatory)] [string]$Name, [string]$DefaultValue = '')
    if ($Body.PSObject.Properties.Name -contains $Name -and $null -ne $Body.$Name) { return [string]$Body.$Name }
    return $DefaultValue
}

function Resolve-RequestedAction {
    param($Body)
    $action = Get-BodyString -Body $Body -Name 'action'
    if (-not [string]::IsNullOrWhiteSpace($action)) { return $action }
    $text = (Get-BodyString -Body $Body -Name 'text').ToLowerInvariant()
    if ($text -match 'home\s*assistant|(^|\s)ha(\s|$)') {
        if ($text -match 'check|health|monitor|status|refresh') { return 'homeassistant.monitor' }
    }
    if ($text -match 'inventory|scan') { return 'lan.inventory' }
    if ($text -match 'health|status|check|refresh') { return 'homeops.check' }
    return 'message'
}

function Invoke-RemoteCommand {
    param($Request, $Body)
    $action = Resolve-RequestedAction -Body $Body
    $entry = [ordered]@{
        id = [guid]::NewGuid().ToString('n')
        receivedAt = (Get-Date).ToString('o')
        remoteAddress = $Request.RemoteAddress
        action = $action
        text = Get-BodyString -Body $Body -Name 'text'
        status = 'received'
    }
    try {
        switch ($action) {
            'homeops.check' { $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-HomeOpsCheck.ps1' -TimeoutSec 120; $entry.status = 'completed' }
            'homeassistant.monitor' { $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-HomeAssistantMonitor.ps1' -TimeoutSec 120; $entry.status = 'completed' }
            'lan.inventory' { $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-LanInventory.ps1' -TimeoutSec 240; $entry.status = 'completed' }
            default {
                $entry.status = 'queued_for_review'
                $entry.result = [ordered]@{ message = 'Message recorded for Codex review. It was not executed automatically.' }
            }
        }
    } catch {
        $entry.status = 'failed'
        $entry.error = $_.Exception.Message
    }
    Write-CommandLog -Entry $entry
    return $entry
}

function Send-StaticFile {
    param($Request)
    $path = $Request.Path
    if ($path -eq '/') { $path = '/index.html' }
    $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $AppRoot $relative))
    if (-not $fullPath.StartsWith($AppRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Request $Request -StatusCode 403 -Text 'Forbidden'
        return
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Send-Text -Request $Request -StatusCode 404 -Text 'Not found'
        return
    }
    $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
    $contentType = switch ($extension) {
        '.html' { 'text/html; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' }
        '.js' { 'application/javascript; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.webmanifest' { 'application/manifest+json; charset=utf-8' }
        '.svg' { 'image/svg+xml' }
        default { 'application/octet-stream' }
    }
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    Send-Response -Request $Request -StatusCode 200 -ContentType $contentType -BodyBytes $bytes -Headers @{ 'Cache-Control' = 'no-cache' }
}

function Handle-ApiRequest {
    param($Request)
    $route = $Request.Path.ToLowerInvariant().TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($route)) { $route = '/' }
    if ($Request.Method -eq 'OPTIONS') {
        Send-Response -Request $Request -StatusCode 204 -ContentType 'text/plain' -BodyBytes ([byte[]]@())
        return
    }
    if (-not (Test-ApiAccess -Request $Request)) { return }
    if ($Request.Method -eq 'GET' -and $route -eq '/api/status') {
        Send-Json -Request $Request -Body (Get-StatusPayload)
        return
    }
    if ($Request.Method -eq 'GET' -and $route -eq '/api/commands') {
        Send-Json -Request $Request -Body @{ ok = $true; commands = @(Get-RecentCommandLog) }
        return
    }
    if ($Request.Method -eq 'POST' -and $route -eq '/api/commands') {
        $body = Read-JsonBody -Request $Request
        $result = Invoke-RemoteCommand -Request $Request -Body $body
        Send-Json -Request $Request -StatusCode $(if ($result.status -eq 'failed') { 400 } else { 200 }) -Body @{ ok = ($result.status -ne 'failed'); command = $result; status = Get-StatusPayload }
        return
    }
    Send-Json -Request $Request -StatusCode 404 -Body @{ ok = $false; error = "Unknown API route: $($Request.Method) $route" }
}

function Convert-PrefixToEndpoint {
    param([Parameter(Mandatory)] [string]$Prefix)
    $uri = [Uri]$Prefix
    $prefixHost = $uri.Host
    $address = if ($prefixHost -eq '+' -or $prefixHost -eq '*' -or $prefixHost -eq '0.0.0.0') {
        [System.Net.IPAddress]::Any
    } elseif ($prefixHost -eq 'localhost') {
        [System.Net.IPAddress]::Loopback
    } else {
        [System.Net.IPAddress]::Parse($prefixHost)
    }
    [pscustomobject]@{ Address = $address; Port = $uri.Port; Prefix = $Prefix }
}

$listeners = @()
try {
    foreach ($prefix in $ListenPrefix) {
        $endpoint = Convert-PrefixToEndpoint -Prefix ([string]$prefix)
        $listener = [System.Net.Sockets.TcpListener]::new($endpoint.Address, $endpoint.Port)
        $listener.Start()
        $listeners += [pscustomobject]@{ Listener = $listener; Prefix = $endpoint.Prefix }
    }
    Write-Host "HomeOps Remote TCP listening on: $($ListenPrefix -join ', ')"
    Write-Host "Config: $ConfigPath"

    $handled = 0
    while ($true) {
        foreach ($item in $listeners) {
            if (-not $item.Listener.Pending()) { continue }
            $client = $item.Listener.AcceptTcpClient()
            try {
                $request = Read-HttpRequest -Client $client
                if ($request.Path -like '/api/*') {
                    Handle-ApiRequest -Request $request
                } else {
                    Send-StaticFile -Request $request
                }
            } catch {
                try {
                    $fallback = [pscustomobject]@{ Client = $client; Stream = $client.GetStream(); RemoteAddress = $client.Client.RemoteEndPoint.Address.ToString() }
                    Send-Json -Request $fallback -StatusCode 500 -Body @{ ok = $false; error = $_.Exception.Message }
                } catch {
                    try { $client.Close() } catch {}
                }
            }
            $handled++
            if ($Once -and $handled -ge 1) { break }
        }
        if ($Once -and $handled -ge 1) { break }
        Start-Sleep -Milliseconds 40
    }
} finally {
    foreach ($item in $listeners) {
        try { $item.Listener.Stop() } catch {}
    }
}



