[CmdletBinding(SupportsShouldProcess)]
param(
    [int]$Port = 8787,
    [string]$DisplayName = 'HomeOps Remote API',
    [string[]]$RemoteAddress = @('LocalSubnet', '10.8.0.0/24', '100.64.0.0/10')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    if ($PSCmdlet.ShouldProcess($DisplayName, 'Replace existing firewall rule')) {
        $existing | Remove-NetFirewallRule
    }
}

if ($PSCmdlet.ShouldProcess($DisplayName, "Allow inbound TCP $Port from $($RemoteAddress -join ', ')")) {
    New-NetFirewallRule `
        -DisplayName $DisplayName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port `
        -Profile Private `
        -RemoteAddress $RemoteAddress | Out-Null
    Write-Output "Enabled firewall rule: $DisplayName"
}
