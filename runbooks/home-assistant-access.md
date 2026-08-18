# Home Assistant Access

## Grant Access

1. Open Home Assistant: `http://192.168.1.93:8123`.
2. Create a dedicated user such as `codex-homeops` from Settings > People > Users.
3. Use an administrator user only if Codex should be able to restart Home Assistant, reload config, or perform maintenance services. For basic monitoring, a less-privileged user may be enough.
4. Log in as that user.
5. Open the user profile Security tab, create a Long-Lived Access Token named `Kevin-PC home-ops`, and copy the full token once.
6. On this PC, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Set-HomeAssistantToken.ps1
```

Paste the token when prompted. It is stored as `config/homeassistant.token.xml`, encrypted by Windows DPAPI for this Windows user.

## Verify Monitoring

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-HomeAssistantMonitor.ps1
```

Latest report: `reports/homeassistant-latest.md`.

## Make A Controlled Change

The service-call helper defaults to dry-run. For common entity-targeted service calls, use `-EntityId` so PowerShell generates valid JSON for you:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-HomeAssistantService.ps1 -Domain light -Service turn_on -EntityId light.office
```

Execute only when approved:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-HomeAssistantService.ps1 -Domain light -Service turn_on -EntityId light.office -Apply
```

For complex service data, use `-BodyJson` with a valid JSON object.
## Guardrails

Allowed without extra confirmation:

- Read API health, config, states, services, and logbook data.
- Write local reports.

Require explicit approval:

- Restart Home Assistant or the host.
- Reload integrations or configuration.
- Change automations, scripts, helpers, dashboards, users, tokens, backups, add-ons, or device/entity configuration.
- Turn on/off locks, doors, garage doors, alarms, heaters, ovens, pumps, valves, or safety/security devices.

## Install Daily Home Assistant API Monitor

After storing the token, register the daily API monitor:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-HomeAssistantMonitorTask.ps1
```

Default schedule: daily at 07:05.

