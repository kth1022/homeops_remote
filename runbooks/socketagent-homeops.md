# SocketAgent HomeOps Setup

SocketAgent has been installed as a HomeOps-integrated agent server on Kevin-PC.

## Server

- Source: `C:\Users\kth10\Documents\home-ops\third-party\socketagent`
- Server: `C:\Users\kth10\Documents\home-ops\third-party\socketagent\server`
- Scheduled task: `SocketAgent`
- Port: `8085`
- Bind: `0.0.0.0`
- Direct Tailscale URL: `ws://100.97.88.6:8085`
- Default working directory: `C:\Users\kth10\Documents\home-ops`
- Auto-update: disabled for this customized archive install
- Firewall: `SocketAgent Server (Tailscale TCP 8085)`, remote address `100.64.0.0/10`

Claude and Codex are installed in the SocketAgent-managed toolchain. Use the Codex backend for HomeOps work unless you specifically want Claude.

Managed Codex command:

`C:\Users\kth10\.socket-agent\toolchains\npm-global\codex.cmd`

## Android App

The verified SocketAgent APK is here:

`C:\Users\kth10\Documents\home-ops\third-party\socketagent\dist\SocketAgent-1.0.100.apk`

SHA-256 verified:

`711e39f2bc45954c23a41c3b37ecc8ac0462f19699987336e914eda7da42ef45`

The APK has been installed on the phone. To reinstall or update it later, enable USB debugging/authorize the PC and run:

```powershell
& 'C:\Users\kth10\AppData\Local\Android\Sdk\platform-tools\adb.exe' install -r 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\dist\SocketAgent-1.0.100.apk'
```

## Phone Connection

Keep Tailscale connected on the phone. Add a direct/manual SocketAgent server in the app:

- Host: `100.97.88.6`
- Port: `8085`
- URL: `ws://100.97.88.6:8085`
- Backend: Codex

Show the SocketAgent auth token on the PC:

```powershell
& 'C:\Users\kth10\.socket-agent\bin\socketagent.cmd' direct
```

Do not expose port `8085` with router port forwarding. Use Tailscale only.

## Permission Prompts

New Codex sessions default to Ask mode. SocketAgent auto-approves policy-allowed routine requests, so normal status checks, reads, builds, and HomeOps workspace edits do not require phone interaction.

The phone app shows an approval card when approval is actually needed, including sensitive commands, firewall/router/service/scheduled-task changes, writes outside `C:\Users\kth10\Documents\home-ops`, full-access permission requests, or requests blocked by local policy that need user override.

Existing sessions can retain their previous mode. In a Codex session, send `/permissions ask`, or use the app permission selector and choose Ask. Yolo and Super Yolo modes suppress prompts for policy-allowed requests.

## HomeOps Integration

Private integration files:

- `server\plugins\homeops.js`
- `server\tools\homeops-tools.js`

The plugin adds HomeOps context to SocketAgent sessions and exposes the following Claude-compatible MCP tools:

- `HomeOpsStatus`
- `RunHomeOpsCheck`
- `RunHomeAssistantMonitor`
- `RunLanInventory`
- `RunRouterReadiness`
- `QueueHomeOpsMessage`
- `HomeAssistantServiceDryRun`
- `HomeAssistantServiceApply`

Codex sessions can use the same functionality through the CLI:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js' status --text
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js' health
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js' homeassistant
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js' lan
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js' router
```

The integration reuses the existing HomeOps Remote API on `http://127.0.0.1:8787` and the existing scripts under `C:\Users\kth10\Documents\home-ops\scripts`.

## Operations

Check task state:

```powershell
Get-ScheduledTask -TaskName 'SocketAgent'
```

Restart SocketAgent:

```powershell
Stop-ScheduledTask -TaskName 'SocketAgent'
Start-ScheduledTask -TaskName 'SocketAgent'
```

View logs:

```powershell
Get-Content 'C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\socketagent.log' -Tail 100 -Wait
```

Show direct connection details:

```powershell
& 'C:\Users\kth10\.socket-agent\bin\socketagent.cmd' direct
```

## Security Policy

Read-only actions are allowed by default: status, health checks, Home Assistant monitor, LAN inventory, router readiness, and message logging.

Mutating actions remain controlled by HomeOps policy. Router changes, TrueNAS/Plex changes, Home Assistant service apply calls, restarts, updates, disk/pool work, firewall changes, and port forwarding require a clear user instruction. Home Assistant service apply also requires `confirm=APPLY` and the existing HomeOps remote config must permit mutating actions.

