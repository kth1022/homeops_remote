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
    param(
        [Parameter(Mandatory)] [string]$Name,
        $DefaultValue
    )

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
    param(
        [string]$ProvidedToken,
        [string]$ExpectedHash
    )

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
    param(
        [Parameter(Mandatory)] [string]$Address,
        [Parameter(Mandatory)] [string]$Cidr
    )

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

function Add-CommonHeaders {
    param([Parameter(Mandatory)] [System.Net.HttpListenerResponse]$Response)

    $Response.Headers.Set('Cache-Control', 'no-store')
    $Response.Headers.Set('X-Content-Type-Options', 'nosniff')
    $Response.Headers.Set('Access-Control-Allow-Origin', '*')
    $Response.Headers.Set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-HomeOps-Token')
    $Response.Headers.Set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function Send-Json {
    param(
        [Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context,
        [int]$StatusCode = 200,
        [Parameter(Mandatory)] $Body
    )

    $json = $Body | ConvertTo-Json -Depth 24
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response = $Context.Response
    Add-CommonHeaders -Response $response
    $response.StatusCode = $StatusCode
    $response.ContentType = 'application/json; charset=utf-8'
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
}

function Send-Text {
    param(
        [Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context,
        [int]$StatusCode = 200,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [string]$Text = ''
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $response = $Context.Response
    Add-CommonHeaders -Response $response
    $response.StatusCode = $StatusCode
    $response.ContentType = $ContentType
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
}

function Read-JsonBody {
    param([Parameter(Mandatory)] [System.Net.HttpListenerRequest]$Request)

    $reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
    try {
        $raw = $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return [pscustomobject]@{}
    }

    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        throw "Invalid JSON body: $($_.Exception.Message)"
    }
}

function Get-BearerToken {
    param([Parameter(Mandatory)] [System.Net.HttpListenerRequest]$Request)

    $authorization = $Request.Headers['Authorization']
    if (-not [string]::IsNullOrWhiteSpace($authorization) -and $authorization -match '^Bearer\s+(.+)$') {
        return $Matches[1].Trim()
    }

    $headerToken = $Request.Headers['X-HomeOps-Token']
    if (-not [string]::IsNullOrWhiteSpace($headerToken)) {
        return $headerToken.Trim()
    }

    return ''
}

function Test-ApiAccess {
    param([Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context)

    $remoteAddress = $Context.Request.RemoteEndPoint.Address.ToString()
    if (-not (Test-RemoteAddressAllowed -Address $remoteAddress)) {
        Send-Json -Context $Context -StatusCode 403 -Body @{
            ok = $false
            error = "Remote address is not allowed: $remoteAddress"
        }
        return $false
    }

    $token = Get-BearerToken -Request $Context.Request
    if (-not (Test-TokenHash -ProvidedToken $token -ExpectedHash $TokenHash)) {
        Send-Json -Context $Context -StatusCode 401 -Body @{
            ok = $false
            error = 'Missing or invalid HomeOps Remote token.'
        }
        return $false
    }

    return $true
}

function Get-LatestJsonReport {
    param([Parameter(Mandatory)] [string]$Pattern)

    if (-not (Test-Path -LiteralPath $ReportsRoot)) { return $null }

    $file = Get-ChildItem -LiteralPath $ReportsRoot -Filter $Pattern -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -eq $file) { return $null }

    try {
        return [ordered]@{
            path = $file.FullName
            generatedAt = $file.LastWriteTime.ToString('o')
            data = (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json)
        }
    } catch {
        return [ordered]@{
            path = $file.FullName
            generatedAt = $file.LastWriteTime.ToString('o')
            error = $_.Exception.Message
        }
    }
}

function Get-TextReport {
    param([Parameter(Mandatory)] [string]$Name)

    $path = Join-Path $ReportsRoot $Name
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return [ordered]@{
        path = $path
        generatedAt = (Get-Item -LiteralPath $path).LastWriteTime.ToString('o')
        text = (Get-Content -LiteralPath $path -Raw)
    }
}

function Get-ActionManifest {
    @(
        [ordered]@{
            id = 'homeops.check'
            label = 'HomeOps Check'
            description = 'Refresh router, TrueNAS/Plex, and Home Assistant reachability.'
            mutating = $false
        },
        [ordered]@{
            id = 'homeassistant.monitor'
            label = 'Home Assistant Monitor'
            description = 'Refresh Home Assistant API, entity, service, and battery summary.'
            mutating = $false
        },
        [ordered]@{
            id = 'lan.inventory'
            label = 'LAN Inventory'
            description = 'Scan known LAN service ports and write an inventory report.'
            mutating = $false
        },
        [ordered]@{
            id = 'homeassistant.service.dryrun'
            label = 'HA Service Dry Run'
            description = 'Prepare a Home Assistant service call without applying it.'
            mutating = $false
        },
        [ordered]@{
            id = 'homeassistant.service.apply'
            label = 'HA Service Apply'
            description = 'Apply a Home Assistant service call only when local config permits it.'
            mutating = $true
            enabled = $AllowMutatingActions
        },
        [ordered]@{
            id = 'message'
            label = 'Message'
            description = 'Record a remote instruction for Codex review.'
            mutating = $false
        }
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
        homeops = Get-LatestJsonReport -Pattern 'homeops-*.json'
        homeassistant = Get-LatestJsonReport -Pattern 'homeassistant-*.json'
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
    param(
        [Parameter(Mandatory)] [string]$ScriptName,
        [string]$ArgumentString = '',
        [int]$TimeoutSec = 120
    )

    $scriptPath = Join-Path $ScriptsRoot $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Script not found: $scriptPath"
    }

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
    $finished = Get-Date

    if ($process.ExitCode -ne 0) {
        throw "Command failed with exit code $($process.ExitCode): $stderr $stdout"
    }

    [ordered]@{
        script = $ScriptName
        startedAt = $started.ToString('o')
        finishedAt = $finished.ToString('o')
        exitCode = $process.ExitCode
        output = $stdout.Trim()
        error = $stderr.Trim()
    }
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
    @(Get-Content -LiteralPath $CommandLogPath -Tail $Limit | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $null -ne $_ })
}

function Get-BodyString {
    param(
        $Body,
        [Parameter(Mandatory)] [string]$Name,
        [string]$DefaultValue = ''
    )

    if ($Body.PSObject.Properties.Name -contains $Name -and $null -ne $Body.$Name) {
        return [string]$Body.$Name
    }
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

function Assert-Name {
    param(
        [Parameter(Mandatory)] [string]$Value,
        [Parameter(Mandatory)] [string]$Label
    )

    if ($Value -notmatch '^[a-z0-9_]+$') {
        throw "$Label may only contain lowercase letters, numbers, and underscores."
    }
}

function Assert-EntityId {
    param([Parameter(Mandatory)] [string]$Value)

    if ($Value -notmatch '^[a-z0-9_]+\.[a-z0-9_]+$') {
        throw "Invalid Home Assistant entity_id: $Value"
    }
}

function Invoke-HomeAssistantServiceRequest {
    param(
        [Parameter(Mandatory)] $Body,
        [bool]$Apply
    )

    if ($Apply -and -not $AllowMutatingActions) {
        throw 'Mutating actions are disabled in the local HomeOps Remote config.'
    }
    if ($Apply -and (Get-BodyString -Body $Body -Name 'confirm') -ne 'APPLY') {
        throw 'Applying a Home Assistant service requires confirm=APPLY.'
    }

    $domain = Get-BodyString -Body $Body -Name 'domain'
    $service = Get-BodyString -Body $Body -Name 'service'
    Assert-Name -Value $domain -Label 'domain'
    Assert-Name -Value $service -Label 'service'

    $tempJson = $null
    $parts = @('-Domain', (Quote-PSArgument $domain), '-Service', (Quote-PSArgument $service))
    if ($Body.PSObject.Properties.Name -contains 'entityId' -and $null -ne $Body.entityId) {
        $entityIds = @($Body.entityId)
        foreach ($entityId in $entityIds) {
            $id = [string]$entityId
            Assert-EntityId -Value $id
            $parts += '-EntityId'
            $parts += (Quote-PSArgument $id)
        }
    }
    if ($Body.PSObject.Properties.Name -contains 'data' -and $null -ne $Body.data) {
        $tempJson = Join-Path $env:TEMP ("homeops-ha-service-{0}.json" -f ([guid]::NewGuid().ToString('n')))
        $Body.data | ConvertTo-Json -Depth 12 -Compress | Set-Content -LiteralPath $tempJson -Encoding UTF8
        $parts += '-BodyJsonPath'
        $parts += (Quote-PSArgument $tempJson)
    }
    if ($Apply) {
        $parts += '-Apply'
    }

    try {
        Invoke-ExternalScript -ScriptName 'Invoke-HomeAssistantService.ps1' -ArgumentString ($parts -join ' ') -TimeoutSec 90
    } finally {
        if ($null -ne $tempJson -and (Test-Path -LiteralPath $tempJson)) {
            Remove-Item -LiteralPath $tempJson -Force
        }
    }
}

function Invoke-RemoteCommand {
    param(
        [Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context,
        [Parameter(Mandatory)] $Body
    )

    $action = Resolve-RequestedAction -Body $Body
    $text = Get-BodyString -Body $Body -Name 'text'
    $entry = [ordered]@{
        id = [guid]::NewGuid().ToString('n')
        receivedAt = (Get-Date).ToString('o')
        remoteAddress = $Context.Request.RemoteEndPoint.Address.ToString()
        action = $action
        text = $text
        status = 'received'
    }

    try {
        switch ($action) {
            'homeops.check' {
                $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-HomeOpsCheck.ps1' -TimeoutSec 120
                $entry.status = 'completed'
            }
            'homeassistant.monitor' {
                $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-HomeAssistantMonitor.ps1' -TimeoutSec 120
                $entry.status = 'completed'
            }
            'lan.inventory' {
                $entry.result = Invoke-ExternalScript -ScriptName 'Invoke-LanInventory.ps1' -TimeoutSec 240
                $entry.status = 'completed'
            }
            'homeassistant.service.dryrun' {
                $entry.result = Invoke-HomeAssistantServiceRequest -Body $Body -Apply:$false
                $entry.status = 'completed'
            }
            'homeassistant.service.apply' {
                $entry.result = Invoke-HomeAssistantServiceRequest -Body $Body -Apply:$true
                $entry.status = 'completed'
            }
            default {
                $entry.status = 'queued_for_review'
                $entry.result = [ordered]@{
                    message = 'Message recorded for Codex review. It was not executed automatically.'
                }
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
    param([Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context)

    $path = [System.Uri]::UnescapeDataString($Context.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $AppRoot $relative))

    if (-not $fullPath.StartsWith($AppRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Context $Context -StatusCode 403 -Text 'Forbidden'
        return
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Send-Text -Context $Context -StatusCode 404 -Text 'Not found'
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
    $response = $Context.Response
    if ($extension -in @('.html', '.js', '.css', '.webmanifest')) {
        $response.Headers.Set('Cache-Control', 'no-cache')
    }
    $response.Headers.Set('X-Content-Type-Options', 'nosniff')
    $response.StatusCode = 200
    $response.ContentType = $contentType
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
}

function Handle-ApiRequest {
    param([Parameter(Mandatory)] [System.Net.HttpListenerContext]$Context)

    $method = $Context.Request.HttpMethod.ToUpperInvariant()
    $route = $Context.Request.Url.AbsolutePath.ToLowerInvariant().TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($route)) { $route = '/' }

    if ($method -eq 'OPTIONS') {
        Send-Json -Context $Context -StatusCode 204 -Body @{}
        return
    }

    if (-not (Test-ApiAccess -Context $Context)) { return }

    if ($method -eq 'GET' -and $route -eq '/api/status') {
        Send-Json -Context $Context -Body (Get-StatusPayload)
        return
    }
    if ($method -eq 'GET' -and $route -eq '/api/commands') {
        Send-Json -Context $Context -Body @{
            ok = $true
            commands = @(Get-RecentCommandLog)
        }
        return
    }
    if ($method -eq 'POST' -and $route -eq '/api/commands') {
        $body = Read-JsonBody -Request $Context.Request
        $result = Invoke-RemoteCommand -Context $Context -Body $body
        Send-Json -Context $Context -StatusCode $(if ($result.status -eq 'failed') { 400 } else { 200 }) -Body @{
            ok = ($result.status -ne 'failed')
            command = $result
            status = Get-StatusPayload
        }
        return
    }

    Send-Json -Context $Context -StatusCode 404 -Body @{
        ok = $false
        error = "Unknown API route: $method $route"
    }
}

$listener = [System.Net.HttpListener]::new()
foreach ($prefix in $ListenPrefix) {
    $listener.Prefixes.Add([string]$prefix)
}

try {
    $listener.Start()
    Write-Host "HomeOps Remote listening on: $($ListenPrefix -join ', ')"
    Write-Host "Config: $ConfigPath"

    do {
        $context = $listener.GetContext()
        try {
            if ($context.Request.Url.AbsolutePath -like '/api/*') {
                Handle-ApiRequest -Context $context
            } else {
                Send-StaticFile -Context $context
            }
        } catch {
            try {
                Send-Json -Context $context -StatusCode 500 -Body @{
                    ok = $false
                    error = $_.Exception.Message
                }
            } catch {
                try { $context.Response.Close() } catch {}
            }
        }
    } while (-not $Once)
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}


