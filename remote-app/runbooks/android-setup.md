# HomeOps Remote Android Setup

## Control PC

From `C:\Users\kth10\Documents\home-ops\remote-app`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\New-HomeOpsRemoteToken.ps1 -TokenOutputPath .\config\homeops.remote.token.txt
```

Start the Node server for a local test:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\Start-HomeOpsRemoteNode.ps1
```

Open:

```text
http://127.0.0.1:8787/
```

Use the token from:

```text
C:\Users\kth10\Documents\home-ops\remote-app\config\homeops.remote.token.txt
```

Delete the token text file after adding it to the phone.

## Android On Home Wi-Fi

Open this URL from Android while on home Wi-Fi:

```text
http://192.168.1.86:8787/
```

Set:

```text
API URL: http://192.168.1.86:8787
Token: value from homeops.remote.token.txt
```

## Android Over Tailscale

Connect the Android phone to the same tailnet as `Kevin-PC`.

Primary HTTPS URL:

```text
https://kevin-pc.taile05f72.ts.net/
```

Fallback tailnet URLs:

```text
http://kevin-pc.taile05f72.ts.net:8080/
http://100.97.88.6:8787/
```

Set:

```text
API URL: https://kevin-pc.taile05f72.ts.net
Token: value from homeops.remote.token.txt
```

Chrome can install the app from the browser menu because Tailscale Serve provides HTTPS.

## Allowed Commands

- `HomeOps Check`: refreshes router, TrueNAS/Plex, and Home Assistant reachability.
- `Home Assistant Monitor`: refreshes API/entity/service/battery status.
- `LAN Inventory`: scans configured LAN service ports.
- Free text commands are recorded in `logs\remote-commands.jsonl` for Codex review and are not executed automatically.

Home Assistant service calls are dry-run by default. Applying a Home Assistant service requires `allowMutatingActions: true` in `config\homeops.remote.json` and `confirm=APPLY` in the request.
