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

## Sensitive Files

Do not commit:

- `remote-app/config/homeops.remote.json`
- `remote-app/config/*.token.txt`
- Android keystores
- `logs/`
- `reports/`
- `exports/`
- any `.env`, credential, API key, or token file
