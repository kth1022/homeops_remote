[CmdletBinding(SupportsShouldProcess)]
param(
    [int]$Port = 8787,
    [string]$User = "$env:USERDOMAIN\$env:USERNAME"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$url = "http://+:$Port/"
if ($PSCmdlet.ShouldProcess($url, "Grant HttpListener URL ACL to $User")) {
    & netsh http add urlacl url=$url user=$User
}
