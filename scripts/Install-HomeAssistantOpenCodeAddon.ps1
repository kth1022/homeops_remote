[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$BaseUrl = 'http://192.168.1.93:8123',
    [string]$Token,
    [string]$TokenPath,
    [string]$Repository = 'https://github.com/magnusoverli/opencode',
    [string]$AddonName = 'OpenCode',
    [switch]$Start,
    [switch]$AutoUpdate,
    [switch]$IngressPanel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Token)) {
    if ([string]::IsNullOrWhiteSpace($TokenPath)) {
        $TokenPath = Join-Path $PSScriptRoot '..\config\homeassistant.token.xml'
    }

    if (-not (Test-Path -LiteralPath $TokenPath)) {
        throw 'Provide -Token or -TokenPath for a Home Assistant admin token with Supervisor add-on access.'
    }

    try {
        $secureToken = Import-Clixml -LiteralPath $TokenPath
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try {
            $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            if ($bstr -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
    } catch {
        $Token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
    }
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'Token is empty.'
}

$headers = @{
    Authorization = "Bearer $Token"
    'Content-Type' = 'application/json'
}

function Invoke-SupervisorApi {
    param(
        [Parameter(Mandatory)] [string]$Method,
        [Parameter(Mandatory)] [string]$Path,
        [string]$BodyJson,
        [int]$TimeoutSec = 1800
    )

    $uri = "$($BaseUrl.TrimEnd('/'))/api/hassio$Path"
    $params = @{
        Method = $Method
        Uri = $uri
        Headers = $headers
        TimeoutSec = $TimeoutSec
    }
    if (-not [string]::IsNullOrWhiteSpace($BodyJson)) {
        $params.Body = $BodyJson
    }

    Invoke-RestMethod @params
}

Write-Host "Checking Supervisor access..."
$repositories = Invoke-SupervisorApi -Method GET -Path '/store/repositories'
$repoItems = @($repositories.data.repositories)
if (-not $repoItems) {
    $repoItems = @($repositories.repositories)
}

$repoExists = $repoItems | Where-Object { $_.source -eq $Repository -or $_.url -eq $Repository }
if (-not $repoExists) {
    $body = @{ repository = $Repository } | ConvertTo-Json -Compress
    if ($PSCmdlet.ShouldProcess($Repository, 'Add Home Assistant add-on repository')) {
        Write-Host "Adding repository $Repository..."
        Invoke-SupervisorApi -Method POST -Path '/store/repositories' -BodyJson $body | Out-Null
    }
} else {
    Write-Host "Repository is already present."
}

if ($PSCmdlet.ShouldProcess('Home Assistant add-on store', 'Reload store')) {
    Write-Host 'Reloading add-on store...'
    Invoke-SupervisorApi -Method POST -Path '/store/reload' -BodyJson '{}' | Out-Null
}

Write-Host "Finding $AddonName add-on..."
$store = Invoke-SupervisorApi -Method GET -Path '/store/addons'
$addons = @($store.data.addons)
if (-not $addons) {
    $addons = @($store.addons)
}

$addon = $addons |
    Where-Object { $_.name -eq $AddonName -or $_.repository -eq $Repository -or $_.url -like "$Repository*" } |
    Select-Object -First 1

if (-not $addon) {
    throw "Could not find $AddonName in the add-on store after adding $Repository."
}

Write-Host "Found $($addon.name) with slug $($addon.slug)."
if (-not $addon.installed) {
    if ($PSCmdlet.ShouldProcess($addon.slug, 'Install Home Assistant add-on')) {
        Write-Host 'Installing add-on...'
        Invoke-SupervisorApi -Method POST -Path "/store/addons/$($addon.slug)/install" -BodyJson '{}' | Out-Null
    }
} else {
    Write-Host "Add-on is already installed: $($addon.installed)"
}

$options = [ordered]@{}
if ($AutoUpdate) { $options.auto_update = $true }
if ($IngressPanel) { $options.ingress_panel = $true }

if ($options.Count -gt 0) {
    $body = $options | ConvertTo-Json -Compress
    if ($PSCmdlet.ShouldProcess($addon.slug, 'Update Home Assistant add-on options')) {
        Write-Host 'Updating add-on options...'
        Invoke-SupervisorApi -Method POST -Path "/addons/$($addon.slug)/options" -BodyJson $body | Out-Null
    }
}

if ($Start) {
    if ($PSCmdlet.ShouldProcess($addon.slug, 'Start Home Assistant add-on')) {
        Write-Host 'Starting add-on...'
        Invoke-SupervisorApi -Method POST -Path "/addons/$($addon.slug)/start" -BodyJson '{}' | Out-Null
    }
}

$info = Invoke-SupervisorApi -Method GET -Path "/addons/$($addon.slug)/info"
$result = [ordered]@{
    slug = $addon.slug
    name = $info.data.name
    version = $info.data.version
    version_latest = $info.data.version_latest
    state = $info.data.state
    ingress = $info.data.ingress
    ingress_panel = $info.data.ingress_panel
}
$result | ConvertTo-Json -Depth 4
