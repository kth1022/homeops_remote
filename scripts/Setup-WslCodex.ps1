param(
    [string]$Distro = 'Ubuntu',

    [string]$LinuxUser = $env:USERNAME
)

$ErrorActionPreference = 'Stop'

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Name"
    & $Action
}

function Test-RebootPending {
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired',
        'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
    )

    if (Test-Path -LiteralPath $paths[0]) { return $true }
    if (Test-Path -LiteralPath $paths[1]) { return $true }

    try {
        $pending = (Get-ItemProperty -LiteralPath $paths[2] -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
        return [bool]$pending
    } catch {
        return $false
    }
}

function Get-WslDistros {
    $registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (Test-Path -LiteralPath $registryPath) {
        $fromRegistry = Get-ChildItem -LiteralPath $registryPath -ErrorAction SilentlyContinue |
            ForEach-Object {
                (Get-ItemProperty -LiteralPath $_.PSPath -Name DistributionName -ErrorAction SilentlyContinue).DistributionName
            } |
            Where-Object { $_ }
        if ($fromRegistry) { return @($fromRegistry) }
    }

    $raw = & wsl.exe --list --quiet 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return @() }
    return @($raw | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

function Invoke-Wsl {
    param(
        [string[]]$Arguments
    )

    & wsl.exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "wsl.exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-WslDistroVersion {
    param([string]$Name)

    $raw = & wsl.exe --list --verbose 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $lines = @($raw | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
    foreach ($line in $lines) {
        $normalized = ($line -replace '^\*\s*', '').Trim()
        if ($normalized -match "^$([regex]::Escape($Name))\s+\S+\s+([12])$") {
            return [int]$matches[1]
        }
    }
    return $null
}

Invoke-Step 'Verify WSL Windows features' {
    $wsl = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
    $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform

    if ($wsl.State -ne 'Enabled') {
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart | Out-Null
    }

    if ($vmp.State -ne 'Enabled') {
        Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart | Out-Null
    }

    if (Test-RebootPending) {
        Write-Host 'A Windows reboot is pending. Reboot Kevin-PC, then rerun this script.'
        exit 3010
    }
}

Invoke-Step 'Set WSL2 as default version' {
    & wsl.exe --set-default-version 2
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Could not set WSL2 as default. Continuing; Ubuntu conversion will report any kernel/virtualization issue.'
    }
}

Invoke-Step "Install $Distro if needed" {
    $distros = Get-WslDistros
    if ($distros -notcontains $Distro) {
        & wsl.exe --install -d $Distro --no-launch
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'This WSL build does not support --no-launch; retrying with older install syntax.'
            Invoke-Wsl -Arguments @('--install', '-d', $Distro)
        }
    } else {
        Write-Host "$Distro is already registered."
    }
}

Invoke-Step "Ensure $Distro uses WSL2" {
    $version = Get-WslDistroVersion -Name $Distro
    if ($version -eq 2) {
        Write-Host "$Distro is already WSL2."
    } else {
        Invoke-Wsl -Arguments @('--set-version', $Distro, '2')
    }
}

Invoke-Step 'Verify Linux user initialization' {
    & wsl.exe -d $Distro -- bash -lc 'id -un'
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Open $Distro from the Start menu and complete the first-run Linux username/password setup."
        Write-Host "Then rerun this script."
        exit 2
    }
}

Invoke-Step "Ensure regular Linux user $LinuxUser" {
    $escapedUser = $LinuxUser -replace "'", "'\''"
    $script = @"
set -e
if ! id '$escapedUser' >/dev/null 2>&1; then
    useradd -m -s /bin/bash '$escapedUser'
    usermod -aG sudo '$escapedUser'
fi
printf '%s\n' '$escapedUser ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-wsl-codex
chmod 0440 /etc/sudoers.d/90-wsl-codex
printf '[user]\ndefault=%s\n' '$escapedUser' > /etc/wsl.conf
"@
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'bash', '-lc', $script)
    & wsl.exe --terminate $Distro 2>$null
}

Invoke-Step 'Install Linux base packages' {
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--', 'bash', '-lc', 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates build-essential ripgrep jq unzip xz-utils')
}

Invoke-Step 'Install Node.js 22 in Linux' {
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--cd', '/mnt/c/Users/kth10/Documents/home-ops', '--', 'bash', 'scripts/setup-wsl-node.sh')
}

Invoke-Step 'Install OpenAI Codex CLI in Linux' {
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', $LinuxUser, '--', 'bash', '-lc', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh')
}

Invoke-Step 'Prepare Linux workspace directory' {
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', $LinuxUser, '--', 'bash', '-lc', 'mkdir -p "$HOME/src" && printf "Linux workspace: %s\n" "$HOME/src"')
}

Invoke-Step 'Verify tools' {
    Invoke-Wsl -Arguments @('-d', $Distro, '-u', $LinuxUser, '--', 'bash', '-lc', 'set -e; git --version; rg --version | head -1; node --version; npm --version; codex --version')
}

Write-Host ""
Write-Host 'WSL + Codex setup is complete.'
Write-Host 'Windows SocketAgent remains unchanged. Use scripts\Invoke-WslHomeOps.ps1 to run Linux commands from the Windows HomeOps repo.'
