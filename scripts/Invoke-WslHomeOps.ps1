param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Command,

    [string]$Distro = 'Ubuntu',

    [string]$LinuxCwd = '/mnt/c/Users/kth10/Documents/home-ops'
)

$ErrorActionPreference = 'Stop'

& wsl.exe -d $Distro --cd $LinuxCwd -- bash -lc $Command
exit $LASTEXITCODE
