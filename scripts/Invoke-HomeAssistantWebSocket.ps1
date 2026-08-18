[CmdletBinding()]
param(
    [string]$CommandJson,
    [string]$CommandJsonPath,
    [string]$Type,
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$TokenPath,
    [int]$TimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

try { Add-Type -AssemblyName System.Net.WebSockets.Client -ErrorAction Stop } catch { }

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

function Receive-String {
    param([System.Net.WebSockets.ClientWebSocket]$Socket)
    $buffer = New-Object byte[] 65536
    $segments = New-Object System.Collections.Generic.List[byte]
    do {
        $segment = [ArraySegment[byte]]::new($buffer)
        $receiveTask = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
        if (-not $receiveTask.Wait([TimeSpan]::FromSeconds($TimeoutSec))) {
            throw 'Timed out waiting for Home Assistant WebSocket response.'
        }
        $result = $receiveTask.Result
        if ($result.Count -gt 0) {
            for ($i = 0; $i -lt $result.Count; $i++) { $segments.Add($buffer[$i]) }
        }
    } until ($result.EndOfMessage)
    [Text.Encoding]::UTF8.GetString($segments.ToArray())
}

function Send-String {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [string]$Text
    )
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $segment = [ArraySegment[byte]]::new($bytes)
    $sendTask = $Socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None)
    if (-not $sendTask.Wait([TimeSpan]::FromSeconds($TimeoutSec))) {
        throw 'Timed out sending Home Assistant WebSocket request.'
    }
}

$secureToken = Import-Clixml -LiteralPath $TokenPath
$token = ConvertFrom-SecureStringPlainText -SecureString $secureToken
$uriBuilder = [UriBuilder]::new($BaseUrl)
$uriBuilder.Scheme = if ($uriBuilder.Scheme -eq 'https') { 'wss' } else { 'ws' }
$uriBuilder.Path = '/api/websocket'
$uriBuilder.Query = ''

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
try {
    $connectTask = $socket.ConnectAsync($uriBuilder.Uri, [Threading.CancellationToken]::None)
    if (-not $connectTask.Wait([TimeSpan]::FromSeconds($TimeoutSec))) {
        throw 'Timed out connecting to Home Assistant WebSocket API.'
    }

    $authRequired = Receive-String -Socket $socket | ConvertFrom-Json
    if ($authRequired.type -ne 'auth_required') {
        throw "Unexpected WebSocket greeting: $($authRequired.type)"
    }

    $auth = @{ type = 'auth'; access_token = $token } | ConvertTo-Json -Compress
    Send-String -Socket $socket -Text $auth
    $authReply = Receive-String -Socket $socket | ConvertFrom-Json
    if ($authReply.type -ne 'auth_ok') {
        throw "Home Assistant WebSocket auth failed: $($authReply.message)"
    }

    if (-not [string]::IsNullOrWhiteSpace($CommandJsonPath)) {
        $CommandJson = Get-Content -LiteralPath $CommandJsonPath -Raw
    }

    if (-not [string]::IsNullOrWhiteSpace($Type)) {
        $command = [pscustomobject]@{ id = 1; type = $Type }
    } elseif (-not [string]::IsNullOrWhiteSpace($CommandJson)) {
        $command = $CommandJson | ConvertFrom-Json
        if (-not ($command.PSObject.Properties.Name -contains 'id')) {
            $command | Add-Member -NotePropertyName id -NotePropertyValue 1
        }
    } else {
        throw 'Provide either -Type or -CommandJson.'
    }
    $outbound = $command | ConvertTo-Json -Depth 20 -Compress
    Send-String -Socket $socket -Text $outbound

    do {
        $replyText = Receive-String -Socket $socket
        $reply = $replyText | ConvertFrom-Json
    } until ($reply.type -eq 'result' -and $reply.id -eq $command.id)

    $reply | ConvertTo-Json -Depth 50
} finally {
    if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $closeTask = $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [Threading.CancellationToken]::None)
        $closeTask.Wait([TimeSpan]::FromSeconds(2)) | Out-Null
    }
    $socket.Dispose()
    $token = $null
}


