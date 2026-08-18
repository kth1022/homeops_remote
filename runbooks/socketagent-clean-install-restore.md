# SocketAgent Clean Install Restore Procedure

Created: 2026-08-02

This runbook restores SocketAgent sessions, archived sessions, scheduled tasks, app task history, secret files, Codex backend session data, and the local HomeOps SocketAgent integration after a clean install from GitHub.

The official Windows install command from the SocketAgent GitHub README is:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Yllib/socketagent/master/install-windows.ps1 | iex"
```

Source: https://github.com/Yllib/socketagent

## Backup Created

Backup folder:

```powershell
C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637
```

Backup zip:

```powershell
C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637.zip
```

SHA-256:

```text
F6AA98815AE6033CC91CBD4C9F8925E157616CA61DAAE0AF06FDB1B9C0CBEC32
```

Treat this zip as secret material. It contains SocketAgent secrets, pairing/auth material, push/relay files, Codex auth state, and historical session transcripts that may contain pasted credentials.

Backup contents:

- SocketAgent active session registry: 13 sessions
- SocketAgent scheduled tasks: 3 tasks
- SocketAgent history files: 49 files
- SocketAgent archived session files: 2 files
- SocketAgent tool output references: 734 files
- SocketAgent work review files: 1 file
- Codex native session files: 20 files
- Codex native archived session files: 33 files
- SocketAgent secret files: 103 files
- Session-scoped secret pairs promoted to global scope: 23
- HomeOps SocketAgent customization files: 6

## Before You Start

1. Keep the backup zip somewhere safe before deleting or recloning anything.
2. Do not upload the backup zip to GitHub, cloud pastebins, issue trackers, or chat.
3. Close active SocketAgent sessions from the phone if practical.
4. Run this from PowerShell on Kevin-PC.
5. These steps assume the backup is already extracted here unless the zip expansion step is explicitly used:

```powershell
$Backup = 'C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637'
$SocketAgentRepo = 'C:\Users\kth10\Documents\home-ops\third-party\socketagent'
```

## Restore Steps

1. Verify the backup zip.

```powershell
$BackupZip = 'C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637.zip'
Get-FileHash -LiteralPath $BackupZip -Algorithm SHA256
```

Expected hash:

```text
F6AA98815AE6033CC91CBD4C9F8925E157616CA61DAAE0AF06FDB1B9C0CBEC32
```

2. Stop SocketAgent.

```powershell
Stop-ScheduledTask -TaskName 'SocketAgent' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'SocketAgentRecovery' -ErrorAction SilentlyContinue
```

3. Preserve any currently generated data from the fresh install and current Codex state.

```powershell
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$SafetyRoot = Join-Path $env:TEMP "socketagent-restore-safety-$Stamp"
$SocketAgentRepo = 'C:\Users\kth10\Documents\home-ops\third-party\socketagent'
New-Item -ItemType Directory -Force -Path $SafetyRoot | Out-Null

$DataDir = Join-Path $env:USERPROFILE '.socket-agent'
if (Test-Path -LiteralPath $DataDir) {
    Rename-Item -LiteralPath $DataDir -NewName ".socket-agent.fresh-$Stamp"
}

$CodexDir = Join-Path $env:USERPROFILE '.codex'
if (Test-Path -LiteralPath $CodexDir) {
    robocopy $CodexDir (Join-Path $SafetyRoot 'codex-before-restore') /E /R:1 /W:1
    if ($LASTEXITCODE -gt 7) { throw "robocopy Codex safety backup failed: $LASTEXITCODE" }
}

$RepoEnv = Join-Path $SocketAgentRepo 'server\.env'
if (Test-Path -LiteralPath $RepoEnv) {
    New-Item -ItemType Directory -Force -Path (Join-Path $SafetyRoot 'socketagent-server') | Out-Null
    Copy-Item -LiteralPath $RepoEnv -Destination (Join-Path $SafetyRoot 'socketagent-server\.env') -Force
}
```

4. Clean install SocketAgent from GitHub.

If the HomeOps path already exists but is not a git checkout, move it aside first:

```powershell
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Rename-Item -LiteralPath 'C:\Users\kth10\Documents\home-ops\third-party\socketagent' -NewName "socketagent.pre-clean-restore-$Stamp"
```

Then clone or update SocketAgent from GitHub at the HomeOps path and run the installer:

```powershell
$SocketAgentRepo = 'C:\Users\kth10\Documents\home-ops\third-party\socketagent'
if (Test-Path -LiteralPath (Join-Path $SocketAgentRepo '.git')) {
    git -C $SocketAgentRepo fetch --prune origin master
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    git -C $SocketAgentRepo checkout master
    if ($LASTEXITCODE -ne 0) { throw 'git checkout failed' }
    git -C $SocketAgentRepo pull --ff-only origin master
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
} else {
    git clone --branch master https://github.com/Yllib/socketagent.git $SocketAgentRepo
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

powershell -NoProfile -ExecutionPolicy Bypass -File "$SocketAgentRepo\install.ps1"
```

Keeping the HomeOps path avoids manual `.env` path repair. If the clone was run elevated and Git later reports dubious ownership, add only this checkout to Git's safe list:

```powershell
git config --global --add safe.directory C:/Users/kth10/Documents/home-ops/third-party/socketagent
```

Current upstream Windows install builds both managed CLIs. This HomeOps restore is Codex-only; remove Claude after the clean install succeeds:

```powershell
npm uninstall -g --prefix 'C:\Users\kth10\.socket-agent\toolchains\npm-global' '@anthropic-ai/claude-code'
$SocketClaudeShim = 'C:\Users\kth10\AppData\Local\SocketAgent\bin\socketclaude.cmd'
if (Test-Path -LiteralPath $SocketClaudeShim) {
    Rename-Item -LiteralPath $SocketClaudeShim -NewName 'socketclaude.cmd.disabled'
}
```

5. Stop SocketAgent again before restoring files.

```powershell
Stop-ScheduledTask -TaskName 'SocketAgent' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'SocketAgentRecovery' -ErrorAction SilentlyContinue
```

6. Locate the extracted backup.

If the backup is already extracted, use:

```powershell
$Backup = 'C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637'
```

If you need to expand it again, use:

```powershell
$BackupZip = 'C:\Users\kth10\Documents\home-ops\reports\socketagent-clean-install-backup-20260802-155637.zip'
$RestoreRoot = Join-Path $env:TEMP 'socketagent-restore-20260802-155637'
if (Test-Path -LiteralPath $RestoreRoot) {
    Remove-Item -LiteralPath $RestoreRoot -Recurse -Force
}
Expand-Archive -LiteralPath $BackupZip -DestinationPath $RestoreRoot -Force
$Backup = Join-Path $RestoreRoot 'socketagent-clean-install-backup-20260802-155637'
```

7. Restore SocketAgent data, sessions, archived sessions, tasks, globally promoted secrets, and tool outputs.

```powershell
$DataDir = Join-Path $env:USERPROFILE '.socket-agent'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

robocopy "$Backup\socket-agent-data" $DataDir /E /R:1 /W:1
if ($LASTEXITCODE -gt 7) { throw "robocopy socket-agent-data failed: $LASTEXITCODE" }

robocopy "$Backup\socket-agent-secrets" "$DataDir\secrets" /E /R:1 /W:1
if ($LASTEXITCODE -gt 7) { throw "robocopy socket-agent-secrets failed: $LASTEXITCODE" }
```

The secrets restore contains both the original session-scoped copies and the promoted global copies. The promoted copies live under:

```powershell
C:\Users\kth10\.socket-agent\secrets\global\global
```

8. Restore root SocketAgent Firebase credentials, but do not restore phone push tokens.

```powershell
Copy-Item "$Backup\sensitive-config\socketagent\.socket-agent__firebase-service-account.json" "$DataDir\firebase-service-account.json" -Force
Remove-Item "$DataDir\push-tokens.json" -Force -ErrorAction SilentlyContinue
```

Do not restore `push-tokens.json` during a clean reinstall. Firebase registration tokens are installation/server-state specific and may be invalid after an app reinstall, app data reset, or server identity change. Open the Android app after the server is running and use **Settings > Notifications > Register Notifications** to create a fresh token.

The Firebase Admin SDK service account must match the Firebase project compiled into the installed Android APK. The official SocketAgent APK `1.0.222` installed on Kevin's phone is built for Firebase project `socketclaude` with sender ID `686397864267`. A service account from another Firebase project, such as `socketagent-kevin`, will allow token registration but FCM sends will fail with `SENDER_ID_MISMATCH`.

This direct Tailscale setup intentionally does not restore the backed-up `relay-keys.json`. Keep `RELAY_URL=` blank in `server\.env`.

9. Restore Codex backend session and auth state.

```powershell
$CodexDir = Join-Path $env:USERPROFILE '.codex'
New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null

robocopy "$Backup\backend-session-data\codex\sessions" "$CodexDir\sessions" /E /R:1 /W:1
if ($LASTEXITCODE -gt 7) { throw "robocopy Codex sessions failed: $LASTEXITCODE" }

robocopy "$Backup\backend-session-data\codex\archived_sessions" "$CodexDir\archived_sessions" /E /R:1 /W:1
if ($LASTEXITCODE -gt 7) { throw "robocopy Codex archived_sessions failed: $LASTEXITCODE" }

Copy-Item "$Backup\backend-session-data\codex\session_index.jsonl" "$CodexDir\session_index.jsonl" -Force
Copy-Item "$Backup\backend-session-data\codex\history.jsonl" "$CodexDir\history.jsonl" -Force
Copy-Item "$Backup\sensitive-config\codex\auth.json" "$CodexDir\auth.json" -Force
Copy-Item "$Backup\sensitive-config\codex\config.toml" "$CodexDir\config.toml" -Force
Copy-Item "$Backup\sensitive-config\codex\.codex-global-state.json" "$CodexDir\.codex-global-state.json" -Force
Copy-Item "$Backup\sensitive-config\codex\.codex-global-state.json.bak" "$CodexDir\.codex-global-state.json.bak" -Force

$PendingStateDir = Join-Path $CodexDir 'restore-pending-state_5'
New-Item -ItemType Directory -Force -Path $PendingStateDir | Out-Null
foreach ($StateFile in Get-ChildItem "$Backup\sensitive-config\codex" -Filter 'state_5.sqlite*' -File) {
    try {
        Copy-Item -LiteralPath $StateFile.FullName -Destination $CodexDir -Force -ErrorAction Stop
    } catch {
        Copy-Item -LiteralPath $StateFile.FullName -Destination (Join-Path $PendingStateDir $StateFile.Name) -Force
    }
}
```

If a Codex CLI process is running, Windows may keep `state_5.sqlite*` files open. Any locked file is staged under `~\.codex\restore-pending-state_5` and can be copied into `~\.codex` after all Codex CLI processes are closed.

10. Restore HomeOps SocketAgent customization files.

Set the new GitHub checkout root. Use the HomeOps path if you recloned there:

```powershell
$SocketAgentRepo = 'C:\Users\kth10\Documents\home-ops\third-party\socketagent'
```

If you installed somewhere else, set `$SocketAgentRepo` to that clone path.

Then copy the HomeOps custom files:

```powershell
robocopy "$Backup\homeops-customizations" $SocketAgentRepo /E /R:1 /W:1
if ($LASTEXITCODE -gt 7) { throw "robocopy HomeOps customizations failed: $LASTEXITCODE" }

$InstallHomeOps = Join-Path $SocketAgentRepo 'install-homeops.ps1'
$InstallText = Get-Content -LiteralPath $InstallHomeOps -Raw
$OldFirewallLine = "    Set-NetFirewallAddressFilter -AssociatedNetFirewallRule `$existingRule -RemoteAddress '100.64.0.0/10' | Out-Null"
$NewFirewallLine = "    `$existingRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress '100.64.0.0/10' | Out-Null"
if ($InstallText.Contains($OldFirewallLine)) {
    $InstallText = $InstallText.Replace($OldFirewallLine, $NewFirewallLine)
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($InstallHomeOps, $InstallText, $Utf8NoBom)
}
```

11. Restore or repair SocketAgent `.env`.

If the new checkout path is still:

```powershell
C:\Users\kth10\Documents\home-ops\third-party\socketagent
```

restore the backed up `.env` directly:

```powershell
$ServerDir = Join-Path $SocketAgentRepo 'server'
Copy-Item "$Backup\sensitive-config\socketagent\Documents__home-ops__third-party__socketagent__server__.env" "$ServerDir\.env" -Force

$FirebaseLine = "FIREBASE_SERVICE_ACCOUNT_PATH=$DataDir\firebase-service-account.json"
$EnvLines = Get-Content -LiteralPath "$ServerDir\.env"
if ($EnvLines -match '^FIREBASE_SERVICE_ACCOUNT_PATH=') {
    $EnvLines = $EnvLines -replace '^FIREBASE_SERVICE_ACCOUNT_PATH=.*$', $FirebaseLine
    Set-Content -LiteralPath "$ServerDir\.env" -Value $EnvLines -Encoding ASCII
} else {
    Add-Content -LiteralPath "$ServerDir\.env" -Value $FirebaseLine -Encoding ASCII
}
```

If the checkout path changed, do not blindly restore the old `.env`. Run the HomeOps installer to regenerate path-specific values:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SocketAgentRepo\install-homeops.ps1"
```

Then preserve pairing/auth by manually merging only token-like values from the backed-up `.env` into the regenerated `.env`, or re-pair the phone with:

```powershell
socketagent pair
```

12. Recreate the Windows scheduled task and firewall rule for the HomeOps wrapper.

If you restored to the HomeOps path, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SocketAgentRepo\install-homeops.ps1" -NoStart
```

This recreates the `SocketAgent` scheduled task and reapplies the Tailscale-only firewall rule for TCP `8085`.

13. Start SocketAgent.

```powershell
Start-ScheduledTask -TaskName 'SocketAgent'
Start-Sleep -Seconds 5
```

14. Verify the server.

```powershell
& "$env:USERPROFILE\.socket-agent\bin\socketagent.cmd" status
& "$env:USERPROFILE\.socket-agent\bin\socketagent.cmd" direct
```

15. Verify HomeOps integration.

```powershell
node "C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js" status --text
```

Expected basics:

- Remote API is reachable on `http://127.0.0.1:8787`
- Home Assistant status is readable
- Control PC Tailscale address is visible

16. Verify restored SocketAgent session/task files.

```powershell
$DataDir = Join-Path $env:USERPROFILE '.socket-agent'
@{
    sessions = @((Get-Content "$DataDir\sessions.json" -Raw | ConvertFrom-Json)).Count
    scheduledTasks = @((Get-Content "$DataDir\scheduled-tasks.json" -Raw | ConvertFrom-Json)).Count
    historyFiles = @(Get-ChildItem "$DataDir\history" -File).Count
    archiveFiles = @(Get-ChildItem "$DataDir\archive" -File).Count
    globalSecretFiles = @(Get-ChildItem "$DataDir\secrets\global\global" -File).Count
} | ConvertTo-Json
```

Expected minimums from this backup:

- `sessions`: 13
- `scheduledTasks`: 3
- `historyFiles`: 49
- `archiveFiles`: 2
- `globalSecretFiles`: 57

17. Open the phone app and confirm:

- Existing current sessions are visible.
- Archived sessions are visible.
- Scheduled tasks are visible.
- A new Codex session can use globally stored secrets through `RequestSecureInput` reuse.
- HomeOps commands work from a restored Codex session.
- Settings > Notifications shows `Registered for server notifications`.

18. Send a manual push test.

Use a low or higher Codex reasoning effort for scheduled notification tests. `minimal` is not compatible with SocketAgent sessions that expose `web_search`.

If the manual push send reports `UNREGISTERED`, open the Android app and register notifications again. If it reports `SENDER_ID_MISMATCH`, replace `C:\Users\kth10\.socket-agent\firebase-service-account.json` with a Firebase Admin SDK service-account JSON from the Firebase project compiled into the installed APK, then restart SocketAgent and re-test.

## Rollback

If the clean install restore fails, stop SocketAgent and restore the old generated folder from step 3:

```powershell
Stop-ScheduledTask -TaskName 'SocketAgent' -ErrorAction SilentlyContinue
$DataDir = Join-Path $env:USERPROFILE '.socket-agent'
$CodexDir = Join-Path $env:USERPROFILE '.codex'
$FreshBackup = Get-ChildItem $env:USERPROFILE -Directory -Filter '.socket-agent.fresh-*' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($FreshBackup) {
    if (Test-Path -LiteralPath $DataDir) {
        Rename-Item -LiteralPath $DataDir -NewName ".socket-agent.failed-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    }
    Rename-Item -LiteralPath $FreshBackup.FullName -NewName '.socket-agent'
}

$SafetyRoot = Get-ChildItem $env:TEMP -Directory -Filter 'socketagent-restore-safety-*' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($SafetyRoot -and (Test-Path -LiteralPath (Join-Path $SafetyRoot.FullName 'codex-before-restore'))) {
    if (Test-Path -LiteralPath $CodexDir) {
        Rename-Item -LiteralPath $CodexDir -NewName ".codex.failed-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    }
    robocopy (Join-Path $SafetyRoot.FullName 'codex-before-restore') $CodexDir /E /R:1 /W:1
    if ($LASTEXITCODE -gt 7) { throw "robocopy Codex rollback failed: $LASTEXITCODE" }
}

Start-ScheduledTask -TaskName 'SocketAgent'
```

## Notes

- The backup zip is intentionally sensitive now because all secret files were included.
- Session-scoped SocketAgent secrets were copied into the global secret scope without reading or printing their contents.
- The original session-scoped secret files are still preserved for historical session compatibility.
- This HomeOps setup uses Codex CLI only and direct Tailscale connection. `RELAY_URL` should stay blank and old relay key material should not be restored.
- Tailscale direct connectivity is separate from Firebase Cloud Messaging. A working SocketAgent direct connection does not prove push notifications can send; the Android APK Firebase project, phone token, and server service account must all match.
- Do not restore `toolchains` or `bin` from the old install. Let the clean GitHub installer rebuild managed toolchains, then remove Claude if this machine remains Codex-only.
- If the app cannot connect after restore, run `socketagent direct` and add the direct/manual server values in the app.
