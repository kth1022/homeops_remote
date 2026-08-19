# HomeOps Remote

HomeOps Remote is the local/phone dashboard for Kevin's HomeOps environment. It includes:

- the browser UI in `remote-app/app`
- the Node/PowerShell remote server in `remote-app/server`
- the Android WebView wrapper source in `remote-app/android/src`
- Windows launcher/tray source in `remote-app/windows`
- HomeOps helper scripts in `scripts`
- operational runbooks in `runbooks`
- the SocketAgent HomeOps helper in `third-party/socketagent/server/tools`

This repository intentionally excludes live configuration, tokens, logs, reports, generated APKs, Android build output, compiled Windows binaries, and keystores.

## Local Runtime

The live Kevin-PC runtime currently remains in:

```text
C:\Users\kth10\Documents\home-ops
```

Use this repository as the source-control copy. After changes are reviewed and tested, copy or deploy them back to the live HomeOps folder.

## Common Commands

Run commands from the repository root unless a command says otherwise.

Check the live remote config without starting another server:

```powershell
cd .\remote-app
npm run check
```

Build the Android WebView wrapper APK:

```powershell
cd .\remote-app
powershell -NoProfile -ExecutionPolicy Bypass -File .\android\Build-HomeOpsRemoteApk.ps1
```

The generated APK is written to:

```text
remote-app\dist\HomeOpsRemote.apk
```

Restart the Kevin-PC HomeOps Remote Node task after server or app source changes are copied to the live folder:

```powershell
Stop-ScheduledTask -TaskName 'HomeOps Remote Node'
Start-ScheduledTask -TaskName 'HomeOps Remote Node'
```

Check the running local service:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8787/ -UseBasicParsing
node "C:\Users\kth10\Documents\home-ops\third-party\socketagent\server\tools\homeops-tools.js" status --text
```

## Deploying To Kevin-PC

Only copy reviewed source files into the live HomeOps folder. Do not replace live-only configuration, tokens, logs, reports, APK output, Android build output, keystores, or compiled Windows binaries.

Typical source-only sync targets are:

- `remote-app/app/`
- `remote-app/server/`
- `remote-app/android/src/`
- `remote-app/windows/`
- `scripts/`
- `runbooks/`
- `third-party/socketagent/server/tools/homeops-tools.js`

After copying server or app files, restart `HomeOps Remote Node` and verify both:

- `http://127.0.0.1:8787/`
- `http://100.97.88.6:8787/`

The phone app is a WebView around the served dashboard. Web UI changes are picked up by reloading the app; native Android chrome changes require rebuilding and reinstalling the APK.

## Mutating Actions

Keep `allowMutatingActions` set to `false` in the live `remote-app/config/homeops.remote.json` unless an explicit maintenance window requires changes. Plex quarantine, Plex restore, Plex final delete, and Home Assistant service apply paths are treated as mutating operations and are guarded by that setting plus their typed confirmations.

## Sensitive Files

Do not commit:

- `remote-app/config/homeops.remote.json`
- `remote-app/config/*.token.txt`
- Android keystores
- `remote-app/dist/`
- `remote-app/android/build/`
- `logs/`
- `reports/`
- `exports/`
- any `.env`, credential, API key, or token file
