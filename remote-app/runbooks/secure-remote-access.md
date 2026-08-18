# Secure Remote Access

## Policy

Do not port-forward HomeOps Remote from the internet.

Use Tailscale or another private VPN. The app is currently reachable inside the tailnet at `https://kevin-pc.taile05f72.ts.net/` through Tailscale Serve. Fallback URLs are `http://kevin-pc.taile05f72.ts.net:8080/` and `http://100.97.88.6:8787/`.

The API also requires the HomeOps Remote token and filters allowed source networks.

## Tailscale Serve

Start the HomeOps Node backend locally first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\Start-HomeOpsRemoteNode.ps1
```

Then configure Serve from an elevated PowerShell prompt:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=443 http://127.0.0.1:8787
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --http=8080 http://127.0.0.1:8787
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
```

Use `https://kevin-pc.taile05f72.ts.net/` on Android while logged into the same tailnet.

## Router

The router at `192.168.1.1` identifies as:

```text
Model: RBRE960
Firmware: V7.2.8.2_5.1.18
```

Target configuration:

- Tailscale handles remote access; Orbi WAN port forwarding is not needed for HomeOps Remote.
- WAN remote management disabled unless explicitly needed.
- No WAN port-forward to `192.168.1.86:8787`.
- No WAN port-forward to `8123`, `32400`, `22`, `445`, or `2049`.
- UPnP reviewed regularly; disable it if the household does not require it.

After changing router settings, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\Test-HomeOpsRemoteRouterReadiness.ps1
```

The readiness report is written to:

```text
C:\Users\kth10\Documents\home-ops\reports\homeops-remote-readiness-latest.md
```

## Windows Startup

Register the Node server at logon:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\New-HomeOpsRemoteNodeTask.ps1 -RunNow
```

If you access the API directly over LAN or VPN instead of Tailscale Serve, add a firewall rule from an elevated PowerShell prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\Enable-HomeOpsRemoteFirewallRule.ps1
```

## Rotation

Rotate the phone token:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\New-HomeOpsRemoteToken.ps1 -Force -TokenOutputPath .\config\homeops.remote.token.txt
```

Update the token on Android, then delete `homeops.remote.token.txt`.
